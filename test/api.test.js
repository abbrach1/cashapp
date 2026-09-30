import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from '../src/httpApp.js';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';

const TODAY = '2026-09-30';

async function serve(env = {}, extra = {}) {
  const config = loadConfig({ STORE: 'memory', AUTH_DISABLED: '1', TOKEN_ENCRYPTION_KEY: 'k'.repeat(32), ...env });
  const store = new MemoryStore();
  const app = createApp({ config, store, plaid: async () => null, today: () => TODAY, serveStatic: true, ...extra });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'reimbursement-tracker', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  return { base, call, store, config, close: () => server.close() };
}

const CARD_CSV = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
08/19/2026,08/20/2026,DELTA AIR LINES,Travel,Sale,-450.00,
08/21/2026,08/22/2026,NETFLIX.COM,Entertainment,Sale,-15.49,
08/24/2026,08/25/2026,THE CAPITAL GRILLE,Food & Drink,Sale,-180.00,
09/02/2026,09/02/2026,ANNUAL MEMBERSHIP FEE,Fees & Adjustments,Fee,-95.00,
09/20/2026,09/21/2026,UBER *TRIP,Travel,Sale,-25.00,
09/25/2026,09/25/2026,Payment Thank You-Mobile,,Payment,740.49,
`;
const BANK_CSV = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
CREDIT,09/29/2026,"Zelle Payment From Acme Corp Bac9xk2m3n4p",522.00,QUICKPAY_CREDIT,5300.00,,
`;

test('end to end: import, exceptions, submit, Zelle match, exports', async (t) => {
  const s = await serve();
  t.after(s.close);

  let r = await s.call('GET', '/api/config');
  assert.equal(r.body.authRequired, false);

  r = await s.call('POST', '/api/import/csv/preview', { filename: 'Chase4821_Activity20260930.CSV', content: CARD_CSV });
  assert.deepEqual([r.body.kind, r.body.mask, r.body.rows], ['credit', '4821', 6]);

  r = await s.call('POST', '/api/import/csv', {
    filename: 'Chase4821_Activity20260930.CSV',
    content: CARD_CSV,
    newAccount: { name: 'Sapphire Preferred', closingDay: 14 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added, 6);
  const cardId = r.body.accountId;
  // Importing the same file again adds nothing.
  r = await s.call('POST', '/api/import/csv', { filename: 'x.csv', content: CARD_CSV, accountId: cardId });
  assert.equal(r.body.added, 0);

  r = await s.call('POST', '/api/import/csv', { filename: 'Chase9912_Activity.CSV', content: BANK_CSV });
  const bankId = r.body.accountId;
  let state = r.body.state;
  assert.equal(state.accounts.find((a) => a.id === bankId).role, 'reimbursements');
  assert.equal(state.reimbursements.length, 1);

  const aug = state.bills.find((b) => b.end === '2026-09-14');
  assert.ok(aug, 'statement bill exists');
  assert.equal(aug.claimCents, 45000 + 1549 + 18000, 'fee excluded by default, everything else claimed');
  assert.equal(aug.status, 'ready', 'paid on 9/25');

  // Exceptions: Netflix via a rule, dinner partly.
  r = await s.call('POST', '/api/rules', { pattern: 'netflix' });
  assert.equal(r.status, 200);
  let detail = (await s.call('GET', `/api/bills/${aug.id}`)).body;
  const dinner = detail.transactions.find((x) => x.description === 'THE CAPITAL GRILLE');
  r = await s.call('POST', `/api/transactions/${dinner.id}`, { override: 'partial', claimCents: 7200, note: 'Client dinner' });
  assert.equal(r.body.transaction.claim.claimCents, 7200);
  assert.equal(r.body.bill.bill.claimCents, 45000 + 7200);
  r = await s.call('POST', `/api/transactions/${dinner.id}`, { override: 'partial', claimCents: 99999 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /more than/);

  // The Zelle for 522.00 now matches this bill exactly.
  state = (await s.call('GET', '/api/state')).body;
  const bill = state.bills.find((b) => b.id === aug.id);
  assert.equal(bill.receivedCents, 52200);
  assert.equal(bill.status, 'reimbursed');
  assert.equal(state.dashboard.unmatchedCount, 0);

  // Mark submitted, edit the note.
  r = await s.call('POST', `/api/bills/${aug.id}`, { submittedOn: '2026-09-26', note: 'Sent to AP' });
  assert.equal(r.body.bill.bill.submittedOn, '2026-09-26');
  r = await s.call('POST', `/api/bills/${aug.id}`, { submittedOn: 'yesterday' });
  assert.equal(r.status, 400);

  // Exports.
  r = await s.call('GET', `/api/export/bills/${aug.id}?format=pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="Expenses_Sapphire-Preferred-4821_2026-08-15_to_2026-09-14.pdf"/);
  assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
  r = await s.call('GET', `/api/export/bills/${aug.id}?format=csv&audience=company`);
  assert.match(r.body.toString(), /Total reimbursement requested,,522\.00/);
  r = await s.call('GET', `/api/export/bills/${aug.id}?format=xlsx&audience=tracking`);
  assert.equal(r.body.subarray(0, 2).toString(), 'PK');
  r = await s.call('GET', '/api/export/ledger?format=xlsx');
  assert.equal(r.status, 200);
  r = await s.call('GET', '/api/export/ledger?format=csv');
  assert.match(r.body.toString(), /Statement closing/);

  // Search.
  r = await s.call('GET', '/api/transactions?q=uber');
  assert.equal(r.body.total, 1);
  r = await s.call('GET', '/api/transactions?status=excluded');
  assert.equal(r.body.transactions.length, 2);

  // Toggle semantics: 'unclaim' on a default-claimed item sets an exception,
  // 'claim' on a fee (excluded by default) forces it in, 'claim' again resets.
  const fee = detail.transactions.find((x) => x.kind === 'fee');
  r = await s.call('POST', `/api/transactions/${fee.id}`, { override: 'claim' });
  assert.deepEqual([r.body.transaction.override, r.body.transaction.claim.claimCents], ['include', 9500]);
  r = await s.call('POST', `/api/transactions/${fee.id}`, { override: 'unclaim' });
  assert.deepEqual([r.body.transaction.override, r.body.transaction.claim.claimCents], [null, 0]);
  const uber = detail.transactions.find((x) => x.description === 'DELTA AIR LINES');
  r = await s.call('POST', `/api/transactions/${uber.id}`, { override: 'unclaim' });
  assert.equal(r.body.transaction.override, 'exclude');
  r = await s.call('POST', `/api/transactions/${uber.id}`, { override: 'claim' });
  assert.equal(r.body.transaction.override, null);

  // Bulk exclude then reset.
  const ids = detail.transactions.map((x) => x.id);
  r = await s.call('POST', '/api/transactions/bulk', { ids, override: 'exclude' });
  assert.equal(r.body.changed, ids.length);
  detail = (await s.call('GET', `/api/bills/${aug.id}`)).body;
  assert.equal(detail.bill.claimCents, 0);
  await s.call('POST', '/api/transactions/bulk', { ids, override: null });

  // Settings validation.
  r = await s.call('POST', '/api/settings', { yourName: 'Sam', senderFilters: 'acme, ' });
  assert.deepEqual(r.body.state.settings.senderFilters, ['acme']);
  r = await s.call('POST', '/api/settings', { bogus: 1 });
  assert.equal(r.status, 400);

  // Manual reimbursement can be deleted; bank ones cannot.
  r = await s.call('POST', '/api/reimbursements', { date: '2026-09-29', amountCents: 1000, sender: 'Check', method: 'check' });
  const manualId = r.body.id;
  r = await s.call('DELETE', `/api/reimbursements/${manualId}`);
  assert.equal(r.status, 200);
  const zelleId = r.body.state.reimbursements[0].id;
  r = await s.call('DELETE', `/api/reimbursements/${zelleId}`);
  assert.equal(r.status, 400);
  r = await s.call('POST', `/api/reimbursements/${zelleId}`, { status: 'ignored' });
  assert.equal(r.body.state.bills.find((b) => b.id === aug.id).receivedCents, 0);

  // Account settings and deletion.
  r = await s.call('POST', `/api/accounts/${cardId}`, { closingDay: 40 });
  assert.equal(r.status, 400);
  r = await s.call('POST', `/api/accounts/${cardId}`, { nickname: 'Work card', dueDay: 11 });
  assert.equal(r.body.state.accounts.find((a) => a.id === cardId).label, 'Work card •••• 4821');
  r = await s.call('DELETE', `/api/accounts/${cardId}`);
  assert.equal(r.body.state.bills.filter((b) => b.accountId === cardId).length, 0);
});

test('mutations need the custom header; unknown hosts are refused locally', async (t) => {
  const s = await serve();
  t.after(s.close);
  const noHeader = await fetch(`${s.base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  // fetch() will not send a custom Host header, so use a raw request.
  const withHost = (path, host) =>
    new Promise((resolve, reject) => {
      const url = new URL(s.base + path);
      const req = http.request({ hostname: url.hostname, port: url.port, path, headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
  assert.equal(await withHost('/api/state', 'evil.example'), 403);
  assert.equal(await withHost('/', 'evil.example:3000'), 403);
  assert.equal(await withHost('/api/state', 'localhost:3000'), 200);
});

test('sign-in: token required, allow-list enforced, users isolated', async (t) => {
  const tokens = {
    good: { uid: 'u-good', email: 'me@example.com', email_verified: true },
    other: { uid: 'u-other', email: 'someone@example.com', email_verified: true },
    unverified: { uid: 'u-x', email: 'me@example.com', email_verified: false },
  };
  const s = await serve(
    { AUTH_DISABLED: '0', ALLOWED_EMAILS: 'Me@Example.com' },
    { verifyToken: async (tok) => tokens[tok] ?? Promise.reject(new Error('bad')) },
  );
  t.after(s.close);
  assert.equal((await s.call('GET', '/api/state')).status, 401);
  assert.equal((await s.call('GET', '/api/state', undefined, { authorization: 'Bearer nope' })).status, 401);
  const denied = await s.call('GET', '/api/state', undefined, { authorization: 'Bearer other' });
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /someone@example.com is not allowed/);
  assert.equal((await s.call('GET', '/api/state', undefined, { authorization: 'Bearer unverified' })).status, 403);
  const first = await s.call('GET', '/api/state', undefined, { authorization: 'Bearer good' });
  assert.equal(first.status, 200);
  assert.equal((await s.store.load('u-good')).meta.email, 'me@example.com', 'email remembered on first load');
  const ok = await s.call('POST', '/api/settings', { yourName: 'Me' }, { authorization: 'Bearer good' });
  assert.equal(ok.status, 200);
  // The public config endpoint works without a token.
  const cfg = await s.call('GET', '/api/config');
  assert.equal(cfg.body.authRequired, true);
});

test('cron endpoint requires the secret and syncs allowed users only', async (t) => {
  const s = await serve({ AUTH_DISABLED: '0', ALLOWED_EMAILS: 'me@example.com', CRON_SECRET: 'cron-secret-123' }, { verifyToken: async () => ({ uid: 'u1', email: 'me@example.com' }) });
  t.after(s.close);
  await s.call('POST', '/api/settings', { yourName: 'Me' }, { authorization: 'Bearer x' });
  await s.store.mutate('intruder', (uow) => uow.patchMeta({ email: 'intruder@example.com' }));
  assert.equal((await s.call('GET', '/api/cron/sync')).status, 401);
  assert.equal((await s.call('GET', '/api/cron/sync', undefined, { authorization: 'Bearer wrong-secret-12' })).status, 401);
  const r = await s.call('GET', '/api/cron/sync', undefined, { authorization: 'Bearer cron-secret-123' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.summary.map((u) => u.uid), ['u1']);
});

test('demo mode seeds data on first load', async (t) => {
  const s = await serve({ DEMO: '1' });
  t.after(s.close);
  const state = (await s.call('GET', '/api/state')).body;
  assert.equal(state.demo, true);
  assert.ok(state.bills.length > 5);
  assert.ok(state.settings.companyName);
  const reset = await s.call('POST', '/api/demo/reset');
  assert.equal(reset.status, 200);
  assert.equal(reset.body.state.bills.length, state.bills.length);
});
