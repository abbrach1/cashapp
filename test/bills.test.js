import test from 'node:test';
import assert from 'node:assert/strict';
import { dueDateAfter, fillGaps, periodContaining, planAccountBills, setClosingDate } from '../src/core/bills.js';
import { reconcile } from '../src/core/reconcile.js';
import { billsOf, makeWorld } from './helpers.js';

test('periodContaining follows the closing day', () => {
  assert.deepEqual(periodContaining('2026-09-10', 14), { start: '2026-08-15', end: '2026-09-14' });
  assert.deepEqual(periodContaining('2026-09-14', 14), { start: '2026-08-15', end: '2026-09-14' });
  assert.deepEqual(periodContaining('2026-09-15', 14), { start: '2026-09-15', end: '2026-10-14' });
  // Closing on the 31st clamps to short months.
  assert.deepEqual(periodContaining('2026-02-10', 31), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(periodContaining('2026-03-01', 31), { start: '2026-03-01', end: '2026-03-31' });
  assert.deepEqual(periodContaining('2026-04-30', 31), { start: '2026-04-01', end: '2026-04-30' });
  // Year boundary.
  assert.deepEqual(periodContaining('2026-12-20', 14), { start: '2026-12-15', end: '2027-01-14' });
  assert.deepEqual(periodContaining('2027-01-02', 3), { start: '2026-12-04', end: '2027-01-03' });
});

test('dueDateAfter picks the next due day after closing', () => {
  assert.equal(dueDateAfter('2026-09-14', 11), '2026-10-11');
  assert.equal(dueDateAfter('2026-09-14', 20), '2026-09-20');
  assert.equal(dueDateAfter('2026-01-03', 31), '2026-01-31');
  assert.equal(dueDateAfter('2026-01-31', 30), '2026-02-28');
  assert.equal(dueDateAfter('2026-09-14', null), null);
});

test('fillGaps covers the range around fixed bills and avoids stubs', () => {
  const fixed = [{ start: '2026-08-15', end: '2026-09-12' }];
  assert.deepEqual(fillGaps('2026-07-15', '2026-10-20', fixed, 14), [
    { start: '2026-07-15', end: '2026-08-14' },
    // The day after a moved closing date runs to the following closing date.
    { start: '2026-09-13', end: '2026-10-14' },
    { start: '2026-10-15', end: '2026-11-14' },
  ]);
});

test('bills are generated from the first transaction to the open cycle', () => {
  const w = makeWorld();
  const card = w.card();
  w.txn(card, '2026-07-20', 1000);
  w.txn(card, '2026-09-01', 2000);
  planAccountBills(w.uow, card, { today: '2026-09-30', trackingStart: null, allocatedBillIds: new Set() });
  assert.deepEqual(billsOf(w.uow, card.id), [
    '2026-07-15..2026-08-14',
    '2026-08-15..2026-09-14',
    '2026-09-15..2026-10-14',
  ]);
  // Planning again changes nothing.
  const before = w.uow.changes.entities.bills.size;
  planAccountBills(w.uow, card, { today: '2026-09-30', trackingStart: null, allocatedBillIds: new Set() });
  assert.equal(w.uow.changes.entities.bills.size, before);
  assert.equal(w.uow.list('bills').length, 3);
});

test('tracking start skips older statements', () => {
  const w = makeWorld();
  const card = w.card();
  w.txn(card, '2026-03-02', 1000);
  w.txn(card, '2026-09-01', 2000);
  planAccountBills(w.uow, card, { today: '2026-09-30', trackingStart: '2026-09-01', allocatedBillIds: new Set() });
  assert.deepEqual(billsOf(w.uow, card.id), ['2026-08-15..2026-09-14', '2026-09-15..2026-10-14']);
});

test('changing the closing day re-slices untouched bills but keeps submitted ones', () => {
  const w = makeWorld();
  const card = w.card();
  w.txn(card, '2026-06-20', 1000);
  planAccountBills(w.uow, card, { today: '2026-09-30', trackingStart: null, allocatedBillIds: new Set() });
  const july = w.uow.list('bills').find((b) => b.end === '2026-07-14');
  w.uow.patch('bills', july.id, { submittedOn: '2026-07-20' });
  const updated = w.uow.patch('accounts', card.id, { closingDay: 3 });
  planAccountBills(w.uow, updated, { today: '2026-09-30', trackingStart: null, allocatedBillIds: new Set() });
  assert.deepEqual(billsOf(w.uow, card.id), [
    '2026-06-15..2026-07-14', // submitted: kept as it was
    '2026-07-15..2026-08-03',
    '2026-08-04..2026-09-03',
    '2026-09-04..2026-10-03',
  ]);
});

test('setClosingDate moves the boundary and locks the bill', () => {
  const w = makeWorld();
  const card = w.card();
  w.txn(card, '2026-08-01', 1000);
  planAccountBills(w.uow, card, { today: '2026-09-30', trackingStart: null, allocatedBillIds: new Set() });
  const aug = w.uow.list('bills').find((b) => b.end === '2026-08-14');
  setClosingDate(w.uow, aug.id, '2026-08-12');
  assert.deepEqual(billsOf(w.uow, card.id), [
    '2026-07-15..2026-08-12',
    '2026-08-13..2026-09-14',
    '2026-09-15..2026-10-14',
  ]);
  assert.equal(w.uow.get('bills', aug.id).locked, true);
  assert.throws(() => setClosingDate(w.uow, aug.id, '2026-09-20'), /overlap/);
  assert.throws(() => setClosingDate(w.uow, aug.id, '2026-07-01'), /on or after/);
});

test('bank statement info pins the closing date, balance and due date', () => {
  const w = makeWorld();
  const card = w.card({ stmtDate: '2026-09-13', stmtBalanceCents: 123456, stmtDueDate: '2026-10-10' });
  w.txn(card, '2026-08-20', 1000);
  reconcile(w.uow, { today: '2026-09-30' });
  const bills = w.uow.list('bills').sort((a, b) => (a.start < b.start ? -1 : 1));
  assert.deepEqual(billsOf(w.uow, card.id), ['2026-08-15..2026-09-13', '2026-09-14..2026-10-14']);
  assert.equal(bills[0].stmtBalanceCents, 123456);
  assert.equal(bills[0].dueDate, '2026-10-10');
  assert.equal(bills[0].locked, true);
  // Idempotent.
  const size = w.uow.changes.entities.bills.size;
  const snapshotBills = JSON.stringify(billsOf(w.uow, card.id));
  reconcile(w.uow, { today: '2026-09-30' });
  assert.equal(JSON.stringify(billsOf(w.uow, card.id)), snapshotBills);
  assert.equal(w.uow.changes.entities.bills.size, size);
});

test('accounts that are not expense cards get no bills', () => {
  const w = makeWorld();
  const chk = w.checking();
  w.txn(chk, '2026-09-01', -5000, 'Zelle Payment From Acme Corp Bac123abc45');
  reconcile(w.uow, { today: '2026-09-30' });
  assert.equal(w.uow.list('bills').length, 0);
  const card = w.card({ closingDay: null });
  w.txn(card, '2026-09-02', 1000);
  reconcile(w.uow, { today: '2026-09-30' });
  assert.equal(w.uow.list('bills').length, 0, 'no closing day yet');
});
