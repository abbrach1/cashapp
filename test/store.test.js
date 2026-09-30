import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { ConflictError } from '../src/store/model.js';

test('mutate persists changes and returns the new snapshot', async () => {
  const store = new MemoryStore();
  const { result, snapshot } = await store.mutate('u1', (uow) => {
    uow.put('rules', { id: 'r1', pattern: 'netflix' });
    uow.putTxn({ id: 't1', accountId: 'a1', date: '2026-09-01', amountCents: 100 });
    uow.patchSettings({ yourName: 'Sam' });
    uow.putSecret('c1', 'sealed');
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(snapshot.rules.get('r1').pattern, 'netflix');
  assert.equal(snapshot.settings.yourName, 'Sam');
  assert.equal(await store.getSecret('u1', 'c1'), 'sealed');
  const loaded = await store.load('u1');
  assert.equal(loaded.txns.get('t1').amountCents, 100);
  assert.ok(loaded.rev);
});

test('stored objects are frozen so they cannot be edited in place', async () => {
  const store = new MemoryStore();
  await store.mutate('u1', (uow) => {
    uow.put('reimbursements', { id: 'r1', allocations: [{ billId: 'b', amountCents: 1 }] });
  });
  const snap = await store.load('u1');
  assert.throws(() => {
    snap.reimbursements.get('r1').allocations.push({});
  }, TypeError);
});

test('a conflicting write is retried with fresh data', async () => {
  const store = new MemoryStore();
  await store.mutate('u1', (uow) => uow.patchSettings({ counter: 0 }));
  let calls = 0;
  const { snapshot } = await store.mutate('u1', async (uow) => {
    calls++;
    if (calls === 1) {
      // Simulate another process writing between our read and our commit.
      const current = await store.load('u1');
      await store.commit('u1', { ...emptyChanges(), settings: { ...current.settings, counter: 10 } }, current);
    }
    uow.patchSettings({ counter: (uow.view.settings.counter ?? 0) + 1 });
  });
  assert.equal(calls, 2);
  assert.equal(snapshot.settings.counter, 11);
});

test('mutations for one user run one at a time', async () => {
  const store = new MemoryStore();
  await store.mutate('u1', (uow) => uow.patchSettings({ n: 0 }));
  await Promise.all(
    Array.from({ length: 20 }, () =>
      store.mutate('u1', async (uow) => {
        const n = uow.view.settings.n;
        await new Promise((r) => setTimeout(r, 1));
        uow.patchSettings({ n: n + 1 });
      }),
    ),
  );
  assert.equal((await store.load('u1')).settings.n, 20);
});

test('commit with a stale base is rejected', async () => {
  const store = new MemoryStore();
  const base = await store.load('u1');
  await store.mutate('u1', (uow) => uow.patchSettings({ a: 1 }));
  await assert.rejects(store.commit('u1', emptyChanges(), base), ConflictError);
});

function emptyChanges() {
  return {
    settings: null,
    meta: null,
    entities: { connections: new Map(), accounts: new Map(), bills: new Map(), reimbursements: new Map(), rules: new Map() },
    txns: new Map(),
    secrets: new Map(),
  };
}
