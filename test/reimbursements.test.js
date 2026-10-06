import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger } from '../src/core/ledger.js';
import { reconcile } from '../src/core/reconcile.js';
import {
  addManualReimbursement,
  exactCombination,
  isReimbursementDeposit,
  parseZelleSender,
  setAllocations,
} from '../src/core/reimbursements.js';
import { makeWorld } from './helpers.js';

const TODAY = '2026-09-30';

test('parseZelleSender extracts the sender name', () => {
  assert.equal(parseZelleSender('Zelle Payment From Acme Corp Bacx2kl8qz1m'), 'Acme Corp');
  assert.equal(parseZelleSender('Zelle Payment From Daniel Cardenas Bacn8Lbqfmse'), 'Daniel Cardenas');
  assert.equal(parseZelleSender('ZELLE PAYMENT FROM ACME HOLDINGS LLC'), 'ACME HOLDINGS LLC');
  assert.equal(parseZelleSender('Zelle payment from ACME INC for "August expenses"; Conf# ab12cd34'), 'ACME INC');
  assert.equal(parseZelleSender('QuickPay with Zelle payment from JANE DOE'), 'JANE DOE');
  assert.equal(parseZelleSender('Online Transfer From Chk ...1234'), null);
  assert.equal(parseZelleSender(null), null);
});

test('reimbursement deposits are recognised by keyword and sender filter', () => {
  const account = { role: 'reimbursements' };
  const settings = { reimbursementKeywords: ['zelle', 'quickpay'], senderFilters: [], trackingStartDate: '2026-07-01' };
  const t = (description, amountCents = -5000, extra = {}) => ({ description, amountCents, date: '2026-09-01', pending: false, ...extra });
  assert.equal(isReimbursementDeposit(t('Zelle Payment From Acme'), account, settings), true);
  assert.equal(isReimbursementDeposit(t('PAYROLL ACME'), account, settings), false);
  assert.equal(isReimbursementDeposit(t('Deposit', -5000, { bankType: 'QUICKPAY_CREDIT' }), account, settings), true);
  assert.equal(isReimbursementDeposit(t('Zelle Payment To Landlord', 5000), account, settings), false);
  assert.equal(isReimbursementDeposit(t('Zelle Payment From Acme', -5000, { pending: true }), account, settings), false);
  assert.equal(isReimbursementDeposit(t('Zelle Payment From Acme', -5000, { date: '2026-06-01' }), account, settings), false);
  assert.equal(isReimbursementDeposit(t('Zelle Payment From Acme'), { role: 'ignore' }, settings), false);
  const filtered = { ...settings, senderFilters: ['acme'] };
  assert.equal(isReimbursementDeposit(t('Zelle Payment From Acme Corp'), account, filtered), true);
  assert.equal(isReimbursementDeposit(t('Zelle Payment From Mom'), account, filtered), false);
});

test('exactCombination prefers a single bill, then the oldest pair', () => {
  const bills = [
    { id: 'a', outstandingCents: 100 },
    { id: 'b', outstandingCents: 250 },
    { id: 'c', outstandingCents: 150 },
    { id: 'd', outstandingCents: 250 },
  ];
  assert.deepEqual(exactCombination(bills, 250).map((b) => b.id), ['b']);
  assert.deepEqual(exactCombination(bills, 350).map((b) => b.id), ['a', 'b']);
  assert.deepEqual(exactCombination(bills, 650).map((b) => b.id), ['b', 'c', 'd']);
  assert.deepEqual(exactCombination(bills, 750).map((b) => b.id), ['a', 'b', 'c', 'd']);
  assert.equal(exactCombination(bills, 1), null);
});

function world() {
  const w = makeWorld({ senderFilters: ['acme'] });
  const card = w.card();
  const chk = w.checking();
  w.txn(card, '2026-07-20', 40000, 'DELTA');
  w.txn(card, '2026-08-20', 25000, 'HILTON');
  w.txn(card, '2026-08-25', 5000, 'UBER');
  w.txn(card, '2026-09-20', 1000, 'LYFT');
  return { w, card, chk };
}

test('an incoming Zelle that equals a bill is matched automatically', () => {
  const { w, card, chk } = world();
  w.txn(chk, '2026-09-26', -30000, 'Zelle Payment From Acme Corp Bac9xk2m3n4p');
  w.txn(chk, '2026-09-27', -2000, 'Zelle Payment From Mom Wfct8k2m3n4p');
  reconcile(w.uow, { today: TODAY });
  const reimbs = w.uow.list('reimbursements');
  assert.equal(reimbs.length, 1, 'only the company sender is picked up');
  assert.equal(reimbs[0].sender, 'Acme Corp');
  const ledger = buildLedger(w.uow.view, { today: TODAY });
  const [jul, aug] = ledger.billsByAccount.get(card.id);
  assert.equal(aug.status, 'reimbursed');
  assert.equal(aug.receivedCents, 30000);
  assert.equal(jul.status, 'unpaid');
  assert.deepEqual(reimbs[0].allocations, [{ billId: aug.id, amountCents: 30000, auto: true }]);
  // Running reconcile again is a no-op.
  const before = JSON.stringify(w.uow.list('reimbursements'));
  reconcile(w.uow, { today: TODAY });
  assert.equal(JSON.stringify(w.uow.list('reimbursements')), before);
});

test('a payment covering two bills is split; otherwise a suggestion is offered', () => {
  const { w, card, chk } = world();
  w.txn(chk, '2026-09-26', -70000, 'Zelle Payment From Acme Corp');
  w.txn(chk, '2026-09-28', -12345, 'Zelle Payment From Acme Corp');
  reconcile(w.uow, { today: TODAY });
  const ledger = buildLedger(w.uow.view, { today: TODAY });
  const [jul, aug] = ledger.billsByAccount.get(card.id);
  assert.equal(jul.status, 'reimbursed');
  assert.equal(aug.status, 'reimbursed');
  const odd = [...ledger.reimbursements.values()].find((r) => r.amountCents === 12345);
  assert.equal(odd.allocatedCents, 0);
  assert.deepEqual(odd.suggestion, []);
  assert.equal(ledger.dashboard.unmatchedCount, 1);
});

test('manual allocation, validation and partial reimbursement', () => {
  const { w, card, chk } = world();
  w.txn(chk, '2026-09-26', -50000, 'Zelle Payment From Acme Corp');
  reconcile(w.uow, { today: TODAY });
  let ledger = buildLedger(w.uow.view, { today: TODAY });
  const [jul, aug] = ledger.billsByAccount.get(card.id);
  const r = [...ledger.reimbursements.values()][0];
  // Not an exact match: oldest-first suggestion.
  assert.deepEqual(r.suggestion, [
    { billId: jul.id, amountCents: 40000 },
    { billId: aug.id, amountCents: 10000 },
  ]);
  assert.throws(() => setAllocations(w.uow, r.id, [{ billId: jul.id, amountCents: 60000 }]), /more than/);
  assert.throws(() => setAllocations(w.uow, r.id, [{ billId: 'nope', amountCents: 1 }]), /Unknown bill/);
  setAllocations(w.uow, r.id, r.suggestion);
  reconcile(w.uow, { today: TODAY });
  ledger = buildLedger(w.uow.view, { today: TODAY });
  assert.equal(ledger.bills.get(jul.id).status, 'reimbursed');
  assert.equal(ledger.bills.get(aug.id).status, 'partial');
  assert.equal(ledger.bills.get(aug.id).outstandingCents, 20000);
  assert.equal(w.uow.get('reimbursements', r.id).manual, true);
});

test('changing the sender filter drops untouched detections but keeps allocated ones', () => {
  const { w, chk } = world();
  w.txn(chk, '2026-09-26', -30000, 'Zelle Payment From Acme Corp');
  w.txn(chk, '2026-09-27', -12345, 'Zelle Payment From Acme Corp');
  reconcile(w.uow, { today: TODAY });
  assert.equal(w.uow.list('reimbursements').length, 2);
  w.uow.patchSettings({ senderFilters: ['globex'] });
  reconcile(w.uow, { today: TODAY });
  const left = w.uow.list('reimbursements');
  assert.equal(left.length, 1);
  assert.equal(left[0].amountCents, 30000);
});

test('ignored reimbursements do not count', () => {
  const { w, card, chk } = world();
  w.txn(chk, '2026-09-26', -30000, 'Zelle Payment From Acme Corp');
  reconcile(w.uow, { today: TODAY });
  const r = w.uow.list('reimbursements')[0];
  w.uow.patch('reimbursements', r.id, { status: 'ignored', allocations: [] });
  reconcile(w.uow, { today: TODAY });
  const ledger = buildLedger(w.uow.view, { today: TODAY });
  const [, aug] = ledger.billsByAccount.get(card.id);
  assert.equal(aug.receivedCents, 0);
  assert.equal(w.uow.list('reimbursements').length, 1);
});

test('manual reimbursements', () => {
  const { w, card } = world();
  reconcile(w.uow, { today: TODAY });
  const id = addManualReimbursement(w.uow, { date: '2026-09-15', amountCents: 40000, sender: 'Acme payroll', method: 'payroll' });
  reconcile(w.uow, { today: TODAY });
  const ledger = buildLedger(w.uow.view, { today: TODAY });
  const [jul] = ledger.billsByAccount.get(card.id);
  assert.equal(ledger.reimbursements.get(id).allocatedCents, 40000, 'auto-matched to the July bill');
  assert.equal(jul.status, 'reimbursed');
  assert.throws(() => addManualReimbursement(w.uow, { date: 'x', amountCents: 1 }), /date/);
  assert.throws(() => addManualReimbursement(w.uow, { date: '2026-09-15', amountCents: 0 }), /amount/);
});

test('a client paying for your services is kept as income, never a reimbursement', () => {
  const { w, chk } = world();
  w.uow.patchSettings({ senderFilters: [] }); // count Zelles from anyone
  w.txn(chk, '2026-09-26', -30000, 'Zelle Payment From Acme Corp Bac9xk2m3n4p');
  w.txn(chk, '2026-09-27', -5500, 'Zelle Payment From YEHUDA SCHER Wfct8k2m3n4p');
  reconcile(w.uow, { today: TODAY });
  let rs = w.uow.list('reimbursements');
  assert.deepEqual(rs.map((r) => [r.sender, r.status]).sort(), [['Acme Corp', 'active'], ['YEHUDA SCHER', 'active']]);

  // Once the sender is listed, untouched payments from them become income...
  w.uow.patchSettings({ incomeSenders: ['Yehuda Scher'] });
  w.txn(chk, '2026-09-29', -7000, 'Zelle Payment From YEHUDA SCHER Wfct9z2m3n4q');
  reconcile(w.uow, { today: TODAY });
  rs = w.uow.list('reimbursements');
  assert.deepEqual(rs.filter((r) => r.sender === 'YEHUDA SCHER').map((r) => r.status), ['income', 'income']);
  // ...even when the reimbursement sender filter would skip them.
  w.uow.patchSettings({ senderFilters: ['acme'] });
  w.txn(chk, '2026-09-30', -2500, 'YEHUDA SCHER CONSULTING ACH PPD');
  reconcile(w.uow, { today: TODAY });
  const ledger = buildLedger(w.uow.view, { today: TODAY });
  const income = [...ledger.reimbursements.values()].filter((r) => r.status === 'income');
  assert.equal(income.length, 3);
  assert.ok(income.every((r) => r.allocations.length === 0 && r.suggestion.length === 0));
  assert.equal(ledger.dashboard.incomeYtdCents, 5500 + 7000 + 2500);
  assert.equal(ledger.dashboard.receivedYtdCents, 30000, 'only the company payment counts as reimbursed');
  assert.equal(ledger.dashboard.unmatchedCount, 0);
});
