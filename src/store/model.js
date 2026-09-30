// In-memory model shared by every storage backend.
//
// A Snapshot is everything we know about one user, loaded at once. Business
// logic never writes to storage directly: it works on a UnitOfWork, which keeps
// an updated view of the snapshot and records a ChangeSet. The store then
// persists the ChangeSet atomically (and rejects it if someone else wrote in
// between, see ConflictError).

export const ENTITY_KINDS = /** @type {const} */ (['connections', 'accounts', 'bills', 'reimbursements', 'rules']);

/**
 * @typedef {{
 *   rev: string|null,
 *   meta: Record<string, any>,
 *   settings: Record<string, any>,
 *   connections: Map<string, any>,
 *   accounts: Map<string, any>,
 *   bills: Map<string, any>,
 *   reimbursements: Map<string, any>,
 *   rules: Map<string, any>,
 *   txns: Map<string, any>,
 * }} Snapshot
 */

/** @returns {Snapshot} */
export function emptySnapshot() {
  return {
    rev: null,
    meta: {},
    settings: {},
    connections: new Map(),
    accounts: new Map(),
    bills: new Map(),
    reimbursements: new Map(),
    rules: new Map(),
    txns: new Map(),
  };
}

export class ConflictError extends Error {
  constructor() {
    super('Data changed while saving, please retry');
    this.name = 'ConflictError';
  }
}

/** Month bucket a transaction is stored in. */
export function txnBucketId(txn) {
  return `${txn.accountId}_${txn.date.slice(0, 7)}`;
}

export class ChangeSet {
  constructor() {
    /** @type {Record<string, any>|null} full settings object when changed */
    this.settings = null;
    /** @type {Record<string, any>|null} */
    this.meta = null;
    /** @type {Record<string, Map<string, any>>} id -> full object, or null to delete */
    this.entities = Object.fromEntries(ENTITY_KINDS.map((k) => [k, new Map()]));
    /** @type {Map<string, any>} id -> full transaction, or null to delete */
    this.txns = new Map();
    /** @type {Map<string, any>} connection id -> secret object, or null to delete */
    this.secrets = new Map();
  }

  isEmpty() {
    return (
      !this.settings &&
      !this.meta &&
      this.txns.size === 0 &&
      this.secrets.size === 0 &&
      ENTITY_KINDS.every((k) => this.entities[k].size === 0)
    );
  }
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// Stored objects are frozen so that accidental in-place edits (which would
// bypass the ChangeSet and silently diverge from storage) fail loudly.
function freeze(obj) {
  return deepFreeze({ ...obj });
}

export class UnitOfWork {
  /** @param {Snapshot} snapshot */
  constructor(snapshot) {
    this.base = snapshot;
    this.changes = new ChangeSet();
    /** @type {Snapshot} */
    this.view = {
      rev: snapshot.rev,
      meta: { ...snapshot.meta },
      settings: { ...snapshot.settings },
      connections: new Map(snapshot.connections),
      accounts: new Map(snapshot.accounts),
      bills: new Map(snapshot.bills),
      reimbursements: new Map(snapshot.reimbursements),
      rules: new Map(snapshot.rules),
      txns: new Map(snapshot.txns),
    };
  }

  /** @param {typeof ENTITY_KINDS[number]} kind @param {string} id */
  get(kind, id) {
    return this.view[kind].get(id);
  }

  /** @param {typeof ENTITY_KINDS[number]} kind */
  list(kind) {
    return [...this.view[kind].values()];
  }

  /** Create or replace an entity. */
  put(kind, obj) {
    if (!obj?.id) throw new Error(`${kind}: id required`);
    const value = freeze(obj);
    this.view[kind].set(obj.id, value);
    this.changes.entities[kind].set(obj.id, value);
    return value;
  }

  /** Merge fields into an existing entity. */
  patch(kind, id, fields) {
    const existing = this.view[kind].get(id);
    if (!existing) throw new Error(`${kind}: ${id} not found`);
    return this.put(kind, { ...existing, ...fields, id });
  }

  delete(kind, id) {
    this.view[kind].delete(id);
    this.changes.entities[kind].set(id, null);
  }

  getTxn(id) {
    return this.view.txns.get(id);
  }

  putTxn(txn) {
    if (!txn?.id || !txn.accountId || !txn.date) throw new Error('transaction: id, accountId and date required');
    const value = freeze(txn);
    this.view.txns.set(txn.id, value);
    this.changes.txns.set(txn.id, value);
    return value;
  }

  patchTxn(id, fields) {
    const existing = this.view.txns.get(id);
    if (!existing) throw new Error(`transaction ${id} not found`);
    return this.putTxn({ ...existing, ...fields, id });
  }

  deleteTxn(id) {
    this.view.txns.delete(id);
    this.changes.txns.set(id, null);
  }

  patchSettings(fields) {
    this.replaceSettings({ ...this.view.settings, ...fields });
  }

  replaceSettings(settings) {
    this.view.settings = { ...settings };
    this.changes.settings = this.view.settings;
  }

  patchMeta(fields) {
    this.view.meta = { ...this.view.meta, ...fields };
    this.changes.meta = this.view.meta;
  }

  putSecret(connectionId, value) {
    this.changes.secrets.set(connectionId, value);
  }

  deleteSecret(connectionId) {
    this.changes.secrets.set(connectionId, null);
  }
}

/**
 * Return a new snapshot with the changes applied (the input is not modified).
 * @param {Snapshot} snapshot
 * @param {ChangeSet} changes
 * @param {string} rev
 * @returns {Snapshot}
 */
export function applyChanges(snapshot, changes, rev) {
  const next = {
    rev,
    meta: changes.meta ? { ...changes.meta } : snapshot.meta,
    settings: changes.settings ? { ...changes.settings } : snapshot.settings,
    connections: snapshot.connections,
    accounts: snapshot.accounts,
    bills: snapshot.bills,
    reimbursements: snapshot.reimbursements,
    rules: snapshot.rules,
    txns: snapshot.txns,
  };
  for (const kind of ENTITY_KINDS) {
    const ch = changes.entities[kind];
    if (!ch.size) continue;
    const map = new Map(snapshot[kind]);
    for (const [id, value] of ch) {
      if (value === null) map.delete(id);
      else map.set(id, freeze(value));
    }
    next[kind] = map;
  }
  if (changes.txns.size) {
    const map = new Map(snapshot.txns);
    for (const [id, value] of changes.txns) {
      if (value === null) map.delete(id);
      else map.set(id, freeze(value));
    }
    next.txns = map;
  }
  return next;
}
