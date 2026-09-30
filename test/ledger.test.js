import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger } from '../src/core/ledger.js';
import { reconcile } from '../src/core/reconcile.js';
import { claimInfo, sanitizeClaimChange } from '../src/core/claims.js';
import { classify } from '../src/core/classify.js';
import { makeWorld } from './helpers.js';

const TODAY = '2026-09-30';

test('classify recognises card payments, fees, interest, rewards and refunds', () => {
  const c = (amountCents, description, extra = {}) => classify({ accountKind: 'credit', amountCents, description, ...extra });
  assert.equal(c(-120000, 'Payment Thank You-Mobile'), 'payment');
  assert.equal(c(-120000, 'AUTOMATIC PAYMENT - THANK'), 'payment');
  assert.equal(c(-5000, 'Whatever', { bankType: 'Payment' }), 'payment');
  assert.equal(c(-5000, 'CHASE CREDIT CRD', { categoryDetail: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }), 'payment');
  assert.equal(c(9500, 'ANNUAL MEMBERSHIP FEE'), 'fee');
  assert.equal(c(312, 'FOREIGN TRANSACTION FEE'), 'fee');
  assert.equal(c(1841, 'PURCHASE INTEREST CHARGE'), 'interest');
  assert.equal(c(-2500, 'REDEMPTION CREDIT'), 'reward');
  assert.equal(c(-4312, 'AMAZON MKTPLACE PMTS'), 'refund');
  assert.equal(c(4312, 'UBER *TRIP'), 'purchase');
  assert.equal(classify({ accountKind: 'checking', amountCents: -5000, description: 'Zelle Payment From Acme' }), 'deposit');
});

test('everything is claimed unless there is an exception', () => {
  const settings = { excludeFeesByDefault: true, excludeRewardsByDefault: true };
  const rules = [{ id: 'r1', pattern: 'netflix', accountId: null }];
  const info = (t) => claimInfo(t, { rules, settings });
  const base = { accountId: 'a', description: 'X', override: null, claimCents: null };
  assert.deepEqual(info({ ...base, kind: 'purchase', amountCents: 5000 }), {
    applicable: true,
    claimCents: 5000,
    status: 'claimed',
    reason: 'default',
  });
  assert.equal(info({ ...base, kind: 'refund', amountCents: -1500 }).claimCents, -1500);
  assert.equal(info({ ...base, kind: 'purchase', amountCents: 1599, description: 'NETFLIX.COM' }).reason, 'rule');
  assert.equal(info({ ...base, kind: 'fee', amountCents: 9500 }).status, 'excluded');
  assert.equal(info({ ...base, kind: 'reward', amountCents: -2500 }).claimCents, 0);
  assert.equal(info({ ...base, kind: 'payment', amountCents: -9000 }).applicable, false);
  assert.equal(info({ ...base, kind: 'purchase', amountCents: 5000, override: 'exclude' }).claimCents, 0);
  assert.equal(info({ ...base, kind: 'fee', amountCents: 312, override: 'include' }).claimCents, 312);
  const partial = info({ ...base, kind: 'purchase', amountCents: 8000, override: 'partial', claimCents: 5000 });
  assert.deepEqual([partial.claimCents, partial.status], [5000, 'partial']);
  const noFees = claimInfo({ ...base, kind: 'fee', amountCents: 312 }, { rules: [], settings: { excludeFeesByDefault: false } });
  assert.equal(noFees.claimCents, 312);
});

test('claim changes are validated', () => {
  const txn = { kind: 'purchase', amountCents: 8000 };
  assert.deepEqual(sanitizeClaimChange(txn, { override: 'partial', claimCents: 5000 }), { override: 'partial', claimCents: 5000 });
  assert.deepEqual(sanitizeClaimChange(txn, { override: 'partial', claimCents: 8000 }), { override: 'include', claimCents: null });
  assert.deepEqual(sanitizeClaimChange(txn, { override: 'partial', claimCents: 0 }), { override: 'exclude', claimCents: null });
  assert.throws(() => sanitizeClaimChange(txn, { override: 'partial', claimCents: 9000 }), /more than/);
  assert.throws(() => sanitizeClaimChange(txn, { override: 'partial', claimCents: -100 }), /same sign/);
  assert.throws(() => sanitizeClaimChange({ kind: 'payment', amountCents: -1 }, { override: 'include' }), /not expenses/);
  assert.deepEqual(sanitizeClaimChange(txn, { note: '  Client dinner  ' }), { note: 'Client dinner' });
  assert.deepEqual(sanitizeClaimChange(txn, { override: null }), { override: null, claimCents: null });
});

function standardWorld() {
  const w = makeWorld();
  const card = w.card();
  // Statement Aug 15 - Sep 14
  w.txn(card, '2026-08-20', 45000, 'DELTA AIR LINES');
  w.txn(card, '2026-08-22', 12000, 'MARRIOTT');
  w.txn(card, '2026-08-25', 1599, 'NETFLIX.COM', { override: 'exclude' });
  w.txn(card, '2026-09-02', -3000, 'MARRIOTT REFUND');
  w.txn(card, '2026-09-10', 9500, 'ANNUAL MEMBERSHIP FEE');
  // Paid after closing
  w.txn(card, '2026-09-25', -65099, 'Payment Thank You-Mobile');
  // Open cycle
  w.txn(card, '2026-09-20', 2500, 'UBER *TRIP');
  w.txn(card, '2026-09-28', 800, 'STARBUCKS', { pending: true });
  reconcile(w.uow, { today: TODAY });
  return { w, card };
}

test('bill totals, payment detection and status', () => {
  const { w, card } = standardWorld();
  const ledger = buildLedger(w.uow.view, { today: TODAY });
  const [sept, open] = ledger.billsByAccount.get(card.id);
  assert.equal(sept.end, '2026-09-14');
  assert.equal(sept.chargesCents, 45000 + 12000 + 1599 + 9500);
  assert.equal(sept.creditsCents, -3000);
  assert.equal(sept.claimCents, 45000 + 12000 - 3000);
  assert.equal(sept.excludedCents, 1599 + 9500);
  assert.deepEqual(sept.counts, { txns: 5, claimed: 3, excluded: 2, partial: 0, pending: 0, payments: 0 });
  // No bank statement: new activity is used as the statement balance.
  assert.equal(sept.stmtSource, 'activity');
  assert.equal(sept.stmtBalanceCents, 65099);
  assert.deepEqual(sept.paid, { paid: true, paidOn: '2026-09-25', source: 'auto', paidCents: 65099, neededCents: 65099 });
  assert.equal(sept.status, 'ready');
  assert.equal(open.status, 'open');
  assert.equal(open.claimCents, 2500);
  assert.equal(open.counts.pending, 1);
  assert.equal(ledger.dashboard.readyCount, 1);
  assert.equal(ledger.dashboard.owedCents, 54000);
  assert.equal(ledger.dashboard.currentCycleCents, 2500);
});

test('statement balances roll from a known statement and include mid-cycle payments', () => {
  const w = makeWorld();
  const card = w.card();
  w.txn(card, '2026-07-20', 30000, 'HOTEL');
  w.txn(card, '2026-08-01', -10000, 'Payment Thank You-Web'); // paid early, before closing
  w.txn(card, '2026-08-10', 5000, 'TAXI');
  w.txn(card, '2026-08-20', 7000, 'LUNCH');
  w.txn(card, '2026-09-05', -25000, 'AUTOPAY PAYMENT');
  w.txn(card, '2026-09-20', -7000, 'AUTOPAY PAYMENT');
  reconcile(w.uow, { today: TODAY });
  const aug = w.uow.list('bills').find((b) => b.end === '2026-08-14');
  const sep = w.uow.list('bills').find((b) => b.end === '2026-09-14');
  // The bank told us the September statement balance.
  w.uow.patch('bills', sep.id, { stmtBalanceCents: 7000 });
  const ledger = buildLedger(w.uow.view, { today: TODAY });
  const augView = ledger.bills.get(aug.id);
  const sepView = ledger.bills.get(sep.id);
  // Aug statement = Sep statement - (Sep activity - Sep payments) = 7000 - (7000 - 25000)
  assert.equal(augView.stmtBalanceCents, 25000);
  assert.equal(augView.stmtSource, 'estimated');
  assert.equal(augView.paid.paid, true);
  assert.equal(augView.paid.paidOn, '2026-09-05');
  assert.equal(sepView.paid.paidOn, '2026-09-20');
});

test('manual paid / unpaid overrides win', () => {
  const { w, card } = standardWorld();
  const bill = w.uow.list('bills').find((b) => b.accountId === card.id && b.end === '2026-09-14');
  w.uow.patch('bills', bill.id, { paidState: 'unpaid' });
  let v = buildLedger(w.uow.view, { today: TODAY }).bills.get(bill.id);
  assert.equal(v.paid.paid, false);
  assert.equal(v.status, 'unpaid');
  w.uow.patch('bills', bill.id, { paidState: 'paid', paidOn: '2026-09-16' });
  v = buildLedger(w.uow.view, { today: TODAY }).bills.get(bill.id);
  assert.deepEqual([v.paid.paid, v.paid.paidOn, v.paid.source], [true, '2026-09-16', 'manual']);
});

test('bills with nothing claimed are marked as such', () => {
  const w = makeWorld();
  const card = w.card();
  w.txn(card, '2026-08-20', 1599, 'NETFLIX.COM', { override: 'exclude' });
  reconcile(w.uow, { today: TODAY });
  const ledger = buildLedger(w.uow.view, { today: TODAY });
  const [aug] = ledger.billsByAccount.get(card.id);
  assert.equal(aug.status, 'nothing');
  assert.equal(ledger.dashboard.owedCents, 0);
});
