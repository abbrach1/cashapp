// Runs only against the Firestore emulator:
//   npm run test:firestore
import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { FirestoreStore } from '../src/store/firestore.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const opts = { skip: enabled ? false : 'FIRESTORE_EMULATOR_HOST not set' };

let app;
let db;
function freshStore() {
  return new FirestoreStore(db);
}

test.before(() => {
  if (!enabled) return;
  app = initializeApp({ projectId: 'demo-reimbursements' }, `test-${Date.now()}`);
  db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
});

test.after(async () => {
  if (app) await deleteApp(app);
});

const uid = () => `u_${Math.random().toString(36).slice(2, 10)}`;

test('round-trips every kind of record', opts, async () => {
  const u = uid();
  const store = freshStore();
  await store.mutate(u, (uow) => {
    uow.patchSettings({ yourName: 'Sam', senderFilters: ['acme'] });
    uow.patchMeta({ email: 'sam@example.com' });
    uow.put('accounts', { id: 'a1', name: 'Card', kind: 'credit', closingDay: 14, nickname: undefined });
    uow.put('bills', { id: 'b1', accountId: 'a1', start: '2026-08-15', end: '2026-09-14' });
    uow.put('reimbursements', { id: 'r1', amountCents: 500, allocations: [{ billId: 'b1', amountCents: 500, auto: true }] });
    uow.put('rules', { id: 'x1', pattern: 'netflix', accountId: null });
    uow.put('connections', { id: 'c1', provider: 'plaid', cursor: 'abc' });
    uow.putSecret('c1', 'v1:sealed');
    uow.putTxn({ id: 't_1', accountId: 'a1', date: '2026-09-01', amountCents: 100, note: null });
    uow.putTxn({ id: 't_2', accountId: 'a1', date: '2026-08-31', amountCents: -50, override: 'exclude' });
  });
  const loaded = await freshStore().load(u);
  assert.equal(loaded.settings.yourName, 'Sam');
  assert.deepEqual(loaded.settings.senderFilters, ['acme']);
  assert.equal(loaded.meta.email, 'sam@example.com');
  assert.equal(loaded.accounts.get('a1').closingDay, 14);
  assert.ok(!('nickname' in loaded.accounts.get('a1')));
  assert.deepEqual(loaded.reimbursements.get('r1').allocations, [{ billId: 'b1', amountCents: 500, auto: true }]);
  assert.equal(loaded.txns.get('t_1').accountId, 'a1');
  assert.equal(loaded.txns.get('t_1').note, null);
  assert.equal(loaded.txns.get('t_2').override, 'exclude');
  assert.equal(loaded.txns.size, 2);
  assert.equal(await store.getSecret(u, 'c1'), 'v1:sealed');
  assert.ok((await store.listUserIds()).includes(u));
});

test('moving a transaction to another month and deleting records', opts, async () => {
  const u = uid();
  const store = freshStore();
  await store.mutate(u, (uow) => {
    uow.putTxn({ id: 't_1', accountId: 'a1', date: '2026-08-31', amountCents: 100 });
    uow.putTxn({ id: 't_2', accountId: 'a1', date: '2026-08-30', amountCents: 200 });
    uow.put('rules', { id: 'x1', pattern: 'a' });
  });
  await store.mutate(u, (uow) => {
    uow.patchTxn('t_1', { date: '2026-09-01' });
    uow.deleteTxn('t_2');
    uow.delete('rules', 'x1');
    uow.deleteSecret('nope');
  });
  const loaded = await freshStore().load(u);
  assert.deepEqual([...loaded.txns.keys()], ['t_1']);
  assert.equal(loaded.txns.get('t_1').date, '2026-09-01');
  assert.equal(loaded.rules.size, 0);
  const aug = await db.doc(`users/${u}/txnMonths/a1_2026-08`).get();
  assert.deepEqual(aug.get('txns'), {});
});

test('two servers writing at once: the stale one retries with fresh data', opts, async () => {
  const u = uid();
  const a = freshStore();
  const b = freshStore();
  await a.mutate(u, (uow) => uow.patchSettings({ n: 0 }));
  await b.load(u); // b caches rev 1
  await a.mutate(u, (uow) => uow.patchSettings({ n: uow.view.settings.n + 1 }));
  let attempts = 0;
  await b.mutate(u, (uow) => {
    attempts++;
    uow.patchSettings({ n: uow.view.settings.n + 1 });
  });
  assert.equal(attempts, 1, 'b noticed the new rev before computing');
  // Force a real conflict: compute from a stale snapshot, then commit.
  const stale = await a.load(u);
  await b.mutate(u, (uow) => uow.patchSettings({ n: uow.view.settings.n + 1 }));
  const { UnitOfWork } = await import('../src/store/model.js');
  const uow = new UnitOfWork(stale);
  uow.patchSettings({ n: 999 });
  await assert.rejects(a.commit(u, uow.changes, stale), /Data changed/);
  const final = await freshStore().load(u);
  assert.equal(final.settings.n, 3);
});

test('the cache is reused while nothing changed', opts, async () => {
  const u = uid();
  const store = freshStore();
  await store.mutate(u, (uow) => uow.put('rules', { id: 'x', pattern: 'p' }));
  let fullLoads = 0;
  const original = store.loadFull.bind(store);
  store.loadFull = async (id) => {
    fullLoads++;
    return original(id);
  };
  await store.load(u);
  await store.load(u);
  assert.equal(fullLoads, 0);
  await freshStore().mutate(u, (uow) => uow.put('rules', { id: 'y', pattern: 'q' }));
  const loaded = await store.load(u);
  assert.equal(fullLoads, 1);
  assert.equal(loaded.rules.size, 2);
});

test('large first import beyond one transaction', opts, async () => {
  const u = uid();
  const store = freshStore();
  await store.mutate(u, (uow) => {
    for (let a = 0; a < 25; a++) {
      for (let m = 1; m <= 20; m++) {
        const month = String(((m - 1) % 12) + 1).padStart(2, '0');
        const year = 2025 + Math.floor((m - 1) / 12);
        uow.putTxn({ id: `t_${a}_${m}`, accountId: `a${a}`, date: `${year}-${month}-05`, amountCents: m });
      }
    }
  });
  const loaded = await freshStore().load(u);
  assert.equal(loaded.txns.size, 500);
});
