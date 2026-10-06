import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger } from '../src/core/ledger.js';
import { reconcile } from '../src/core/reconcile.js';
import { ingest, txnIdFor } from '../src/core/ingest.js';
import { isReviewed, merchantKey, statementOf } from '../src/core/review.js';
import { billReport } from '../src/exports/report.js';
import { classifyView } from '../src/views.js';
import { makeWorld } from './helpers.js';

const TODAY = '2026-09-30';

/** Three statements of a card that closes on the 14th, plus a checking account. */
function history(settings = {}) {
  const w = makeWorld({ senderFilters: ['acme'], ...settings });
  const card = w.card();
  const chk = w.checking();
  const t = {
    // Jul 15 - Aug 14
    delta: w.txn(card, '2026-07-20', 40000, 'DELTA AIR LINES'),
    netflixJul: w.txn(card, '2026-07-25', 1599, 'NETFLIX.COM'),
    // Aug 15 - Sep 14
    hilton: w.txn(card, '2026-08-20', 25000, 'HILTON GARDEN INN'),
    netflixAug: w.txn(card, '2026-08-25', 1599, 'NETFLIX.COM'),
    coffeeAug: w.txn(card, '2026-09-02', 650, 'STARBUCKS STORE 11923'),
    // Sep 15 - Oct 14 (open)
    coffeeSep: w.txn(card, '2026-09-20', 1000, 'STARBUCKS STORE 5521'),
    pending: w.txn(card, '2026-09-21', 1599, 'NETFLIX.COM', { pending: true }),
    payment: w.txn(card, '2026-09-25', -41599, 'Payment Thank You-Mobile'),
  };
  reconcile(w.uow, { today: TODAY });
  const billAt = (date) => w.uow.list('bills').find((b) => b.start <= date && date <= b.end);
  return { w, card, chk, t, billAt, ledger: () => buildLedger(w.uow.view, { today: TODAY }) };
}

test('merchant keys group the same shop', () => {
  assert.equal(merchantKey({ description: 'STARBUCKS STORE 11923' }), 'starbucks store');
  assert.equal(merchantKey({ description: 'STARBUCKS STORE 5521' }), 'starbucks store');
  assert.equal(merchantKey({ merchant: 'Netflix', description: 'NETFLIX.COM' }), 'netflix');
  assert.equal(merchantKey({ description: 'AMAZON MKTPL*2K4' }), 'amazon mktpl');
  assert.equal(merchantKey({ description: 'UBER *TRIP HELP.UBER.COM' }), 'uber trip help');
  assert.equal(merchantKey({ description: '1234 5678' }), '');
});

test('reviewed means you decided, a rule decided, or you confirmed the default', () => {
  assert.equal(isReviewed({}, { reason: 'default' }), false);
  assert.equal(isReviewed({}, { reason: 'fee' }), false);
  assert.equal(isReviewed({ override: 'exclude' }, { reason: 'excluded' }), true);
  assert.equal(isReviewed({ reviewedAt: '2026-09-30T10:00:00Z' }, { reason: 'default' }), true);
  assert.equal(isReviewed({}, { reason: 'rule' }), true);
});

test('review progress only asks about statements not sent or reimbursed yet', () => {
  const { w, t, billAt, ledger } = history();
  let d = ledger().dashboard;
  // Six posted card expenses; the pending charge and the card payment don't count.
  assert.deepEqual([d.reviewTotal, d.unreviewedCount, d.unreviewedClosedCount], [6, 6, 5]);

  w.uow.put('rules', { id: 'x1', pattern: 'netflix', accountId: null });
  w.uow.patchTxn(t.hilton.id, { reviewedAt: '2026-09-30T10:00:00Z' });
  d = ledger().dashboard;
  assert.deepEqual([d.unreviewedCount, d.unreviewedClosedCount], [3, 2]);

  // Sent to the company: July is done, its transactions aren't asked about any more.
  w.uow.patch('bills', billAt('2026-07-20').id, { submittedOn: '2026-08-20' });
  d = ledger().dashboard;
  assert.deepEqual([d.reviewTotal, d.unreviewedCount, d.unreviewedClosedCount], [4, 2, 1]);
});

test('a statement marked as already reimbursed stops counting as owed', () => {
  const { w, card, chk, billAt, ledger } = history();
  const aug = billAt('2026-08-20');
  const before = ledger();
  assert.ok(before.bills.get(aug.id).outstandingCents > 0);
  const owedBefore = before.dashboard.owedCents;

  w.uow.patch('bills', aug.id, { settledOn: '2026-09-30' });
  reconcile(w.uow, { today: TODAY });
  let l = ledger();
  const v = l.bills.get(aug.id);
  assert.deepEqual([v.status, v.outstandingCents, v.settledOn], ['reimbursed', 0, '2026-09-30']);
  assert.equal(l.dashboard.owedCents, owedBefore - before.bills.get(aug.id).outstandingCents);
  assert.equal(billReport(w.uow.view, l, aug.id).bill.statusLabel, 'Reimbursed (marked by you)');

  // A Zelle for exactly that amount is not applied to it any more.
  w.txn(chk, '2026-09-28', -v.claimCents, 'Zelle Payment From Acme Corp Bac1x2y3z4w5');
  reconcile(w.uow, { today: TODAY });
  l = ledger();
  assert.equal(l.bills.get(aug.id).receivedCents, 0);
  assert.equal([...l.reimbursements.values()][0].allocatedCents, 0);

  // Changing the closing day re-slices other statements but keeps this one.
  w.uow.patch('accounts', card.id, { closingDay: 20 });
  reconcile(w.uow, { today: TODAY });
  const kept = w.uow.get('bills', aug.id);
  assert.deepEqual([kept.start, kept.end], [aug.start, aug.end]);
});

test('statements before tracking starts, and cards without a closing day', () => {
  const { w, card, t } = history({ trackingStartDate: '2026-08-15' });
  const l = buildLedger(w.uow.view, { today: TODAY });
  const s = statementOf(w.uow.getTxn(t.delta.id), card, l);
  assert.deepEqual([s.billId, s.start, s.end, s.inPlay], [null, '2026-07-15', '2026-08-14', false]);
  assert.equal(l.dashboard.reviewTotal, 4);

  const loose = w.card({ id: 'a_loose', closingDay: null, mask: '1111' });
  const x = w.txn(loose, '2026-09-03', 2000, 'LYFT *RIDE');
  const l2 = buildLedger(w.uow.view, { today: TODAY });
  const s2 = statementOf(x, loose, l2);
  assert.deepEqual([s2.billId, s2.start, s2.end, s2.inPlay], [null, '2026-09-01', '2026-09-30', true]);
});

test('classify view: newest statement first, paged by whole statements', () => {
  const { w, t, billAt, ledger } = history();
  const l = ledger();
  const page1 = classifyView(w.uow.view, l, { limit: 1 });
  assert.equal(page1.show, 'review');
  assert.deepEqual(page1.stats, { total: 6, reviewed: 0, claimCents: 40000 + 1599 + 25000 + 1599 + 650 + 1000, amountCents: 69848 });
  assert.equal(page1.groups.length, 1);
  assert.equal(page1.groups[0].end, '2026-10-14');
  assert.equal(page1.groups[0].status, 'open');
  assert.deepEqual(page1.groups[0].transactions.map((x) => x.id), [t.coffeeSep.id]);
  assert.equal(page1.groups[0].transactions[0].similarCount, 2, 'both Starbucks visits');
  assert.deepEqual(page1.more, { statements: 2, transactions: 5 });

  const page2 = classifyView(w.uow.view, l, { limit: 1, cursor: page1.nextCursor });
  assert.equal(page2.groups[0].billId, billAt('2026-08-20').id);
  assert.deepEqual(page2.groups[0].transactions.map((x) => x.id), [t.hilton.id, t.netflixAug.id, t.coffeeAug.id]);
  const page3 = classifyView(w.uow.view, l, { limit: 1, cursor: page2.nextCursor });
  assert.equal(page3.groups[0].end, '2026-08-14');
  assert.equal(page3.nextCursor, null);
  assert.deepEqual(classifyView(w.uow.view, l, { cursor: 'garbage' }).groups, []);

  // Filters
  w.uow.patchTxn(t.netflixAug.id, { override: 'exclude' });
  const l2 = ledger();
  const personal = classifyView(w.uow.view, l2, { show: 'personal' });
  assert.deepEqual(personal.groups.flatMap((g) => g.transactions.map((x) => x.id)), [t.netflixAug.id]);
  const review = classifyView(w.uow.view, l2, {});
  assert.equal(review.stats.reviewed, 1);
  assert.ok(!review.groups.some((g) => g.transactions.some((x) => x.id === t.netflixAug.id)));
  const found = classifyView(w.uow.view, l2, { show: 'all', q: 'starbucks' });
  assert.equal(found.groups.flatMap((g) => g.transactions).length, 2);
  const one = classifyView(w.uow.view, l2, { show: 'all', billId: billAt('2026-07-20').id });
  assert.deepEqual(one.groups.map((g) => g.transactions.length), [2]);
});

test('classify view: "not sent yet" leaves out done statements; summary lists every header', () => {
  const { w, billAt, ledger } = history();
  const jul = billAt('2026-07-20');
  w.uow.patch('bills', jul.id, { submittedOn: '2026-08-20' });
  const l = ledger();
  const open = classifyView(w.uow.view, l, { show: 'all' });
  assert.ok(!open.groups.some((g) => g.billId === jul.id));
  const all = classifyView(w.uow.view, l, { show: 'all', scope: 'all' });
  assert.ok(all.groups.some((g) => g.billId === jul.id && g.status === 'submitted' && !g.inPlay));
  const summary = classifyView(w.uow.view, l, { summary: true });
  assert.equal(summary.stats.total, 4);
  const head = summary.groups.find((g) => g.billId === jul.id);
  assert.deepEqual([head.status, head.counts.total, head.claimCents, 'transactions' in head], ['submitted', 2, 41599, false]);
});

test('reviewed state carries over from pending to posted; a changed split asks again', () => {
  const w = makeWorld();
  const acct = { externalId: 'acc-card', name: 'Sapphire Preferred', mask: '4821', kind: 'credit', institution: 'Chase' };
  const tx = (externalId, date, amountCents, extra = {}) => ({ accountExternalId: 'acc-card', externalId, date, amountCents, description: 'THE CAPITAL GRILLE', ...extra });
  ingest(w.uow, { source: 'plaid', connectionId: 'c1', accounts: [acct], upserts: [tx('p1', '2026-09-20', 8000, { pending: true }), tx('p2', '2026-09-21', 3000, { pending: true })] });
  w.uow.patchTxn(txnIdFor('plaid', 'p1'), { reviewedAt: '2026-09-21T12:00:00Z' });
  w.uow.patchTxn(txnIdFor('plaid', 'p2'), { override: 'partial', claimCents: 2000, reviewedAt: '2026-09-21T12:00:00Z' });
  ingest(w.uow, {
    source: 'plaid',
    connectionId: 'c1',
    accounts: [acct],
    // The tip was added to the second one, so its amount changed.
    upserts: [tx('q1', '2026-09-22', 8000, { pendingExternalId: 'p1' }), tx('q2', '2026-09-22', 3600, { pendingExternalId: 'p2' })],
    removed: ['p1', 'p2'],
  });
  const q1 = w.uow.getTxn(txnIdFor('plaid', 'q1'));
  const q2 = w.uow.getTxn(txnIdFor('plaid', 'q2'));
  assert.equal(q1.reviewedAt, '2026-09-21T12:00:00Z');
  assert.deepEqual([q2.override, q2.claimCents, q2.reviewedAt], [null, null, null]);
});
