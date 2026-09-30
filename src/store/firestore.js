import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { BaseStore } from './base.js';
import { ConflictError, ENTITY_KINDS, applyChanges, deepFreeze, emptySnapshot, txnBucketId } from './model.js';

// Firestore layout (everything lives under the signed-in user's uid):
//
//   users/{uid}                          { rev, settings, meta, updatedAt }
//   users/{uid}/connections/{id}         bank connections (Plaid item, SimpleFIN)
//   users/{uid}/secrets/{connectionId}   { sealed } encrypted access token / URL
//   users/{uid}/accounts/{id}
//   users/{uid}/bills/{id}
//   users/{uid}/reimbursements/{id}      incoming Zelle payments + allocations
//   users/{uid}/rules/{id}
//   users/{uid}/txnMonths/{accountId}_{YYYY-MM}   { accountId, month, txns: { [id]: txn } }
//
// Transactions are grouped into one document per account per month so a full
// load costs a few dozen document reads instead of thousands.
//
// Every write bumps users/{uid}.rev inside a transaction that first checks the
// rev the change was computed from, so concurrent writers never overwrite each
// other (the loser retries with fresh data). The loaded snapshot is cached per
// process and reused while the rev is unchanged.

const MAX_WRITES_PER_TXN = 450;

export class FirestoreStore extends BaseStore {
  /** @param {import('firebase-admin/firestore').Firestore} db */
  constructor(db) {
    super();
    this.db = db;
    this.kind = 'firestore';
    /** @type {Map<string, import('./model.js').Snapshot>} */
    this.cache = new Map();
  }

  userRef(uid) {
    return this.db.collection('users').doc(uid);
  }

  invalidate(uid) {
    this.cache.delete(uid);
  }

  async load(uid) {
    const cached = this.cache.get(uid);
    if (cached && cached.rev !== null) {
      const userSnap = await this.userRef(uid).get();
      const rev = userSnap.exists ? (userSnap.get('rev') ?? null) : null;
      if (rev === cached.rev) return cached;
    }
    const snapshot = await this.loadFull(uid);
    this.cache.set(uid, snapshot);
    return snapshot;
  }

  async loadFull(uid) {
    const userRef = this.userRef(uid);
    return this.db.runTransaction(
      async (t) => {
        const [userSnap, monthsSnap, ...entitySnaps] = await Promise.all([
          t.get(userRef),
          t.get(userRef.collection('txnMonths')),
          ...ENTITY_KINDS.map((kind) => t.get(userRef.collection(kind))),
        ]);
        const snapshot = emptySnapshot();
        if (userSnap.exists) {
          const data = userSnap.data();
          snapshot.rev = data.rev ?? null;
          snapshot.settings = data.settings ?? {};
          snapshot.meta = data.meta ?? {};
        }
        ENTITY_KINDS.forEach((kind, i) => {
          for (const doc of entitySnaps[i].docs) snapshot[kind].set(doc.id, deepFreeze({ ...doc.data(), id: doc.id }));
        });
        for (const doc of monthsSnap.docs) {
          const { accountId, txns = {} } = doc.data();
          for (const [id, txn] of Object.entries(txns)) {
            snapshot.txns.set(id, deepFreeze({ ...txn, id, accountId }));
          }
        }
        return snapshot;
      },
      { readOnly: true },
    );
  }

  /** Translate a ChangeSet into a list of document writes. */
  buildWrites(uid, changes, base) {
    const userRef = this.userRef(uid);
    /** @type {Array<(w: { set: Function, delete: Function }) => void>} */
    const writes = [];

    for (const kind of ENTITY_KINDS) {
      for (const [id, value] of changes.entities[kind]) {
        const ref = userRef.collection(kind).doc(id);
        if (value === null) writes.push((w) => w.delete(ref));
        else {
          const { id: _omit, ...data } = value;
          writes.push((w) => w.set(ref, data));
        }
      }
    }

    for (const [connectionId, value] of changes.secrets) {
      const ref = userRef.collection('secrets').doc(connectionId);
      if (value === null) writes.push((w) => w.delete(ref));
      else writes.push((w) => w.set(ref, { sealed: value, updatedAt: new Date().toISOString() }));
    }

    /** @type {Map<string, { accountId: string, month: string, entries: Map<string, any> }>} */
    const buckets = new Map();
    const bucket = (accountId, date) => {
      const id = `${accountId}_${date.slice(0, 7)}`;
      if (!buckets.has(id)) buckets.set(id, { accountId, month: date.slice(0, 7), entries: new Map() });
      return buckets.get(id);
    };
    for (const [id, value] of changes.txns) {
      const prev = base.txns.get(id);
      const prevBucket = prev ? txnBucketId(prev) : null;
      const nextBucket = value ? txnBucketId(value) : null;
      if (prev && prevBucket !== nextBucket) bucket(prev.accountId, prev.date).entries.set(id, FieldValue.delete());
      if (value) {
        const { id: _i, accountId: _a, ...data } = value;
        bucket(value.accountId, value.date).entries.set(id, data);
      }
    }
    for (const [bucketId, b] of buckets) {
      const ref = userRef.collection('txnMonths').doc(bucketId);
      const txns = Object.fromEntries(b.entries);
      const fields = ['accountId', 'month', ...[...b.entries.keys()].map((id) => new FieldPath('txns', id))];
      writes.push((w) => w.set(ref, { accountId: b.accountId, month: b.month, txns }, { mergeFields: fields }));
    }
    return writes;
  }

  async commit(uid, changes, base) {
    const userRef = this.userRef(uid);
    const rev = this.newRev();
    const writes = this.buildWrites(uid, changes, base);
    const userDoc = { rev, updatedAt: new Date().toISOString() };
    const userFields = ['rev', 'updatedAt'];
    if (changes.settings) {
      userDoc.settings = changes.settings;
      userFields.push('settings');
    }
    if (changes.meta) {
      userDoc.meta = changes.meta;
      userFields.push('meta');
    }
    const [first, ...rest] = chunk(writes, MAX_WRITES_PER_TXN);
    try {
      await this.db.runTransaction(async (t) => {
        const current = await t.get(userRef);
        const currentRev = current.exists ? (current.get('rev') ?? null) : null;
        if (currentRev !== base.rev) throw new ConflictError();
        for (const write of first ?? []) write(t);
        t.set(userRef, userDoc, { mergeFields: userFields });
      });
      // Very large first imports exceed one transaction; the rev above already
      // claimed the write, so the remainder goes out in plain batches.
      for (const group of rest) {
        const batch = this.db.batch();
        for (const write of group) write(batch);
        await batch.commit();
      }
    } catch (err) {
      this.cache.delete(uid);
      throw err;
    }
    const next = applyChanges(base, changes, rev);
    this.cache.set(uid, next);
    return next;
  }

  async getSecret(uid, connectionId) {
    const doc = await this.userRef(uid).collection('secrets').doc(connectionId).get();
    return doc.exists ? (doc.get('sealed') ?? null) : null;
  }

  async listUserIds() {
    const refs = await this.db.collection('users').listDocuments();
    return refs.map((r) => r.id);
  }
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
