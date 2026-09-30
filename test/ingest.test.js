import test from 'node:test';
import assert from 'node:assert/strict';
import { ingest, txnIdFor } from '../src/core/ingest.js';
import { reconcile } from '../src/core/reconcile.js';
import { parseChaseCSV, maskFromFilename } from '../src/providers/chaseCsv.js';
import { makeWorld } from './helpers.js';

const card = { externalId: 'acc-card', name: 'Sapphire Preferred', mask: '4821', kind: 'credit', institution: 'Chase' };
const checking = { externalId: 'acc-chk', name: 'Total Checking', mask: '9912', kind: 'checking', institution: 'Chase' };
const tx = (accountExternalId, externalId, date, amountCents, description, extra = {}) => ({
  accountExternalId,
  externalId,
  date,
  amountCents,
  description,
  ...extra,
});

test('first sync creates accounts with sensible roles and classifies transactions', () => {
  const w = makeWorld();
  const stats = ingest(w.uow, {
    source: 'plaid',
    connectionId: 'c1',
    accounts: [card, checking, { externalId: 'acc-sav', name: 'Savings', mask: '1111', kind: 'savings' }],
    upserts: [
      tx('acc-card', 'p1', '2026-09-01', 4500, 'UBER'),
      tx('acc-card', 'p2', '2026-09-05', -80000, 'Payment Thank You-Mobile'),
      tx('acc-chk', 'p3', '2026-09-06', -30000, 'Zelle Payment From Acme Corp'),
    ],
  });
  assert.deepEqual(stats, { accountsAdded: 3, added: 3, updated: 0, removed: 0, skippedDuplicates: 0 });
  const accounts = w.uow.list('accounts');
  assert.deepEqual(accounts.map((a) => a.role).sort(), ['expenses', 'ignore', 'reimbursements']);
  const kinds = [...w.uow.view.txns.values()].map((t) => t.kind).sort();
  assert.deepEqual(kinds, ['deposit', 'payment', 'purchase']);
});

test('re-syncing keeps user choices and only writes real changes', () => {
  const w = makeWorld();
  const batch = { source: 'plaid', connectionId: 'c1', accounts: [card], upserts: [tx('acc-card', 'p1', '2026-09-01', 4500, 'UBER')] };
  ingest(w.uow, batch);
  const id = txnIdFor('plaid', 'p1');
  w.uow.patchTxn(id, { override: 'exclude', note: 'personal ride' });
  const stats = ingest(w.uow, batch);
  assert.equal(stats.updated, 0);
  const changed = ingest(w.uow, { ...batch, upserts: [tx('acc-card', 'p1', '2026-09-02', 4600, 'UBER TRIP')] });
  assert.equal(changed.updated, 1);
  const t = w.uow.getTxn(id);
  assert.deepEqual([t.override, t.note, t.amountCents, t.date], ['exclude', 'personal ride', 4600, '2026-09-02']);
});

test('pending to posted keeps the exception (Plaid pending_transaction_id)', () => {
  const w = makeWorld();
  ingest(w.uow, {
    source: 'plaid',
    connectionId: 'c1',
    accounts: [card],
    upserts: [tx('acc-card', 'pend1', '2026-09-28', 800, 'STARBUCKS', { pending: true })],
  });
  w.uow.patchTxn(txnIdFor('plaid', 'pend1'), { override: 'exclude', note: 'coffee for me' });
  const stats = ingest(w.uow, {
    source: 'plaid',
    connectionId: 'c1',
    accounts: [card],
    upserts: [tx('acc-card', 'post1', '2026-09-29', 800, 'STARBUCKS', { pendingExternalId: 'pend1' })],
    removed: ['pend1'],
  });
  assert.equal(stats.removed, 1);
  assert.equal(w.uow.getTxn(txnIdFor('plaid', 'pend1')), undefined);
  const posted = w.uow.getTxn(txnIdFor('plaid', 'post1'));
  assert.deepEqual([posted.override, posted.note, posted.pending], ['exclude', 'coffee for me', false]);
});

test('SimpleFIN-style pending cleanup and re-issued ids keep user data', () => {
  const w = makeWorld();
  ingest(w.uow, {
    source: 'simplefin',
    connectionId: 'c2',
    accounts: [card],
    upserts: [
      tx('acc-card', 's-pend', '2026-09-28', 1250, 'CHIPOTLE', { pending: true }),
      tx('acc-card', 's-old', '2026-09-10', 9900, 'ADOBE'),
    ],
  });
  w.uow.patchTxn(txnIdFor('simplefin', 's-pend'), { note: 'team lunch' });
  w.uow.patchTxn(txnIdFor('simplefin', 's-old'), { override: 'exclude' });
  ingest(w.uow, {
    source: 'simplefin',
    connectionId: 'c2',
    accounts: [card],
    upserts: [tx('acc-card', 's-posted', '2026-09-29', 1250, 'CHIPOTLE 123'), tx('acc-card', 's-new', '2026-09-11', 9900, 'ADOBE')],
    removed: ['s-old'],
    pendingSeen: { 'acc-card': [] },
  });
  assert.equal(w.uow.getTxn(txnIdFor('simplefin', 's-pend')), undefined);
  assert.equal(w.uow.getTxn(txnIdFor('simplefin', 's-posted')).note, 'team lunch');
  assert.equal(w.uow.getTxn(txnIdFor('simplefin', 's-new')).override, 'exclude');
});

test('CSV import skips rows the bank connection already has, and vice versa', () => {
  const w = makeWorld();
  ingest(w.uow, { source: 'plaid', connectionId: 'c1', accounts: [card], upserts: [tx('acc-card', 'p1', '2026-09-01', 4500, 'Uber')] });
  const accountId = w.uow.list('accounts')[0].id;
  const csvStats = ingest(w.uow, {
    source: 'csv',
    connectionId: null,
    accounts: [],
    accountIds: { csv: accountId },
    upserts: [
      tx('csv', 'row1', '2026-09-02', 4500, 'UBER *TRIP HELP.UBER.COM'), // same charge, posted a day later
      tx('csv', 'row2', '2026-08-15', 2000, 'LYFT'),
    ],
  });
  assert.equal(csvStats.added, 1);
  assert.equal(csvStats.skippedDuplicates, 1);

  // A CSV-first account is adopted by the bank connection and its rows merged.
  const w2 = makeWorld();
  const manual = w2.uow.put('accounts', { id: 'a_manual', name: 'Chase card', mask: '4821', kind: 'credit', role: 'expenses', closingDay: 14, connectionId: null, source: 'csv' });
  ingest(w2.uow, { source: 'csv', connectionId: null, accounts: [], accountIds: { x: manual.id }, upserts: [tx('x', 'row1', '2026-09-02', 4500, 'UBER')] });
  w2.uow.patchTxn(txnIdFor('csv', 'row1'), { note: 'airport' });
  const stats = ingest(w2.uow, { source: 'plaid', connectionId: 'c1', accounts: [card], upserts: [tx('acc-card', 'p1', '2026-09-01', 4500, 'Uber')] });
  assert.equal(stats.accountsAdded, 0);
  assert.equal(w2.uow.list('accounts').length, 1);
  assert.equal(w2.uow.get('accounts', 'a_manual').connectionId, 'c1');
  assert.equal(w2.uow.view.txns.size, 1);
  assert.equal(w2.uow.getTxn(txnIdFor('plaid', 'p1')).note, 'airport');
});

test('re-issued deposit keeps its reimbursement allocation', () => {
  const w = makeWorld();
  ingest(w.uow, {
    source: 'plaid',
    connectionId: 'c1',
    accounts: [card, checking],
    upserts: [tx('acc-card', 'p1', '2026-08-20', 30000, 'HILTON'), tx('acc-chk', 'z1', '2026-09-26', -30000, 'Zelle Payment From Acme Corp')],
  });
  reconcile(w.uow, { today: '2026-09-30' });
  // closing day unknown for a brand new Plaid card without statement data
  const cardAccount = w.uow.list('accounts').find((a) => a.kind === 'credit');
  w.uow.patch('accounts', cardAccount.id, { closingDay: 14 });
  reconcile(w.uow, { today: '2026-09-30' });
  const [r] = w.uow.list('reimbursements');
  assert.equal(r.allocations.length, 1);
  ingest(w.uow, {
    source: 'plaid',
    connectionId: 'c1',
    accounts: [card, checking],
    upserts: [tx('acc-chk', 'z1-new', '2026-09-26', -30000, 'Zelle Payment From Acme Corp')],
    removed: ['z1'],
  });
  reconcile(w.uow, { today: '2026-09-30' });
  const all = w.uow.list('reimbursements');
  assert.equal(all.length, 1, 'no duplicate reimbursement');
  assert.equal(all[0].txnId, txnIdFor('plaid', 'z1-new'));
  assert.equal(all[0].allocations.length, 1);
});

const CARD_CSV = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
09/13/2026,09/14/2026,DELTA AIR LINES,Travel,Sale,-452.10,
09/12/2026,09/13/2026,UBER   *TRIP,Travel,Sale,-23.45,
09/12/2026,09/13/2026,UBER   *TRIP,Travel,Sale,-23.45,
09/10/2026,09/10/2026,Payment Thank You-Mobile,,Payment,1200.00,
09/08/2026,09/09/2026,AMAZON MKTPL*2K4,Shopping,Return,15.99,
`;

const CHECKING_CSV = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
CREDIT,09/26/2026,"Zelle Payment From Acme Corp Bac9xk2m3n4p",300.00,QUICKPAY_CREDIT,5300.00,,
DEBIT,09/25/2026,"CHASE CREDIT CRD AUTOPAY PPD ID: 4760039224",-1200.00,ACH_DEBIT,5000.00,,
`;

test('parseChaseCSV reads credit card exports', () => {
  const parsed = parseChaseCSV(CARD_CSV, 'Chase4821_Activity20260930.CSV');
  assert.equal(parsed.kind, 'credit');
  assert.equal(parsed.mask, '4821');
  assert.equal(parsed.rows.length, 5);
  const [delta, uber1, uber2, payment, refund] = parsed.rows;
  assert.deepEqual([delta.date, delta.authDate, delta.amountCents, delta.category, delta.bankType], ['2026-09-14', '2026-09-13', 45210, 'Travel', 'Sale']);
  assert.notEqual(uber1.externalId, uber2.externalId, 'identical rows stay distinct');
  assert.equal(payment.amountCents, -120000);
  assert.equal(refund.amountCents, -1599);
  // Same file again gives the same ids (idempotent import).
  assert.deepEqual(parseChaseCSV(CARD_CSV).rows.map((r) => r.externalId), parsed.rows.map((r) => r.externalId));
});

test('parseChaseCSV reads checking exports with trailing commas', () => {
  const parsed = parseChaseCSV(CHECKING_CSV, 'Chase9912_Activity_20260930.CSV');
  assert.equal(parsed.kind, 'checking');
  assert.equal(parsed.mask, '9912');
  assert.deepEqual(
    parsed.rows.map((r) => [r.date, r.amountCents, r.bankType]),
    [
      ['2026-09-26', -30000, 'QUICKPAY_CREDIT'],
      ['2026-09-25', 120000, 'ACH_DEBIT'],
    ],
  );
});

test('parseChaseCSV rejects unrelated files with a clear message', () => {
  assert.throws(() => parseChaseCSV('name,email\nbob,b@x.com\n'), /header row/);
  assert.throws(() => parseChaseCSV('Date,Description\n09/01/2026,x\n'), /amount/);
  assert.equal(maskFromFilename('Chase1234_Activity20260930.CSV'), '1234');
  assert.equal(maskFromFilename('activity.csv'), null);
});
