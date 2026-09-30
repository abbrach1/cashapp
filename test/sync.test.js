import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { loadConfig } from '../src/config.js';
import { connectPlaid, connectSimplefin, disconnect, plaidLinkToken, syncAll, syncConnection } from '../src/core/sync.js';
import { buildLedger } from '../src/core/ledger.js';
import { txnIdFor } from '../src/core/ingest.js';
import { decodeSetupToken, guessKind, maskFromName, parseAccessUrl } from '../src/providers/simplefin.js';
import { todayISO, addDays, isoToEpoch } from '../src/lib/dates.js';

const config = { ...loadConfig({ TOKEN_ENCRYPTION_KEY: 'test-key-123456789', STORE: 'memory' }) };
const today = todayISO(config.timezone);
const daysAgo = (n) => addDays(today, -n);

function plaidTxn(id, account_id, date, amount, name, extra = {}) {
  return {
    transaction_id: id,
    account_id,
    date,
    authorized_date: date,
    amount,
    name,
    merchant_name: null,
    original_description: name,
    pending: false,
    pending_transaction_id: null,
    personal_finance_category: { primary: 'TRAVEL', detailed: 'TRAVEL_TAXIS_AND_RIDE_SHARES' },
    payment_channel: 'online',
    ...extra,
  };
}

/** A fake Plaid client that serves scripted /transactions/sync pages. */
function fakePlaid({ pages, liabilities = null, failWith = null }) {
  const calls = [];
  const accounts = [
    { account_id: 'card1', name: 'Sapphire Preferred', official_name: null, mask: '4821', type: 'credit', subtype: 'credit card', balances: { current: 510.5, available: 9000 } },
    { account_id: 'chk1', name: 'Total Checking', official_name: null, mask: '9912', type: 'depository', subtype: 'checking', balances: { current: 5000, available: 5000 } },
  ];
  return {
    calls,
    async linkTokenCreate(req) {
      calls.push(['linkTokenCreate', req]);
      if (req.optional_products && failWith === 'no-liabilities') {
        const err = new Error('bad');
        err.response = { data: { error_code: 'INVALID_PRODUCT', error_message: 'client is not authorized to access the following products: ["liabilities"]' } };
        throw err;
      }
      return { data: { link_token: 'link-sandbox-123' } };
    },
    async itemPublicTokenExchange({ public_token }) {
      calls.push(['exchange', public_token]);
      return { data: { access_token: 'access-sandbox-abc', item_id: 'item-1' } };
    },
    async transactionsSync({ cursor }) {
      calls.push(['sync', cursor ?? null]);
      if (failWith === 'login') {
        const err = new Error('login');
        err.response = { data: { error_code: 'ITEM_LOGIN_REQUIRED', display_message: 'Please log in to Chase again' } };
        throw err;
      }
      const page = pages[cursor ?? 'start'];
      return { data: { accounts, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE', ...page } };
    },
    async accountsGet() {
      return { data: { accounts } };
    },
    async liabilitiesGet() {
      calls.push(['liabilities']);
      if (!liabilities) {
        const err = new Error('nope');
        err.response = { data: { error_code: 'PRODUCTS_NOT_SUPPORTED', error_message: 'not supported' } };
        throw err;
      }
      return { data: { liabilities: { credit: liabilities } } };
    },
    async itemRemove() {
      calls.push(['remove']);
      return { data: {} };
    },
  };
}

test('Plaid: connect, paginate, merge updates and removals, keep secrets encrypted', async () => {
  const store = new MemoryStore();
  const client = fakePlaid({
    liabilities: [{ account_id: 'card1', last_statement_issue_date: daysAgo(10), last_statement_balance: 450.25, next_payment_due_date: addDays(today, 15), minimum_payment_amount: 40 }],
    pages: {
      start: {
        added: [plaidTxn('t1', 'card1', daysAgo(20), 45.25, 'Uber'), plaidTxn('t2', 'card1', daysAgo(15), 405, 'Delta')],
        modified: [],
        removed: [],
        next_cursor: 'c1',
        has_more: true,
      },
      c1: {
        added: [plaidTxn('z1', 'chk1', daysAgo(2), -450.25, 'Zelle Payment From Acme Corp Bac1x2y3z4w5', { personal_finance_category: { primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER' } })],
        modified: [],
        removed: [],
        next_cursor: 'c2',
        has_more: false,
      },
      c2: {
        added: [plaidTxn('t3', 'card1', daysAgo(1), 12, 'Lyft')],
        modified: [plaidTxn('t1', 'card1', daysAgo(20), 46.25, 'Uber')],
        removed: [{ transaction_id: 't2', account_id: 'card1' }],
        next_cursor: 'c3',
        has_more: false,
      },
    },
  });
  const deps = { store, config, plaid: async () => client };
  assert.equal(await plaidLinkToken(deps, 'u1'), 'link-sandbox-123');
  const linkReq = client.calls.find((c) => c[0] === 'linkTokenCreate')[1];
  assert.deepEqual(linkReq.products, ['transactions']);
  assert.deepEqual(linkReq.optional_products, ['liabilities']);
  assert.equal(linkReq.user.client_user_id, 'u1');

  const { connectionId, sync } = await connectPlaid(deps, 'u1', { publicToken: 'public-1', institution: { name: 'Chase', institution_id: 'ins_56' } });
  assert.equal(sync.ok, true);
  assert.equal(sync.added, 3);
  const sealed = await store.getSecret('u1', connectionId);
  assert.match(sealed, /^v1:/);
  assert.ok(!sealed.includes('access-sandbox-abc'));

  let snap = await store.load('u1');
  const card = [...snap.accounts.values()].find((a) => a.kind === 'credit');
  assert.equal(card.role, 'expenses');
  assert.equal(card.closingDay, Number(daysAgo(10).slice(8)), 'closing day learned from the statement');
  assert.equal(card.balanceCents, 51050);
  assert.equal(snap.connections.get(connectionId).cursor, 'c2');
  assert.equal(snap.reimbursements.size, 1, 'Zelle deposit detected');

  // Second sync: modification + removal.
  const second = await syncConnection(deps, 'u1', connectionId, { force: true });
  assert.deepEqual([second.added, second.updated, second.removed], [1, 1, 1]);
  snap = await store.load('u1');
  assert.equal(snap.txns.get(txnIdFor('plaid', 't1')).amountCents, 4625);
  assert.equal(snap.txns.get(txnIdFor('plaid', 't2')), undefined);

  // The statement bill was pinned with the bank's balance.
  const ledger = buildLedger(snap, { today });
  const pinned = [...ledger.bills.values()].find((b) => b.end === daysAgo(10));
  assert.equal(pinned.stmtBalanceCents, 45025);
  assert.equal(pinned.stmtSource, 'statement');

  // Throttle: an immediate non-forced sync is skipped.
  assert.equal((await syncConnection(deps, 'u1', connectionId)).skipped, true);

  // Disconnect keeps the history as manual accounts.
  await disconnect(deps, 'u1', connectionId);
  snap = await store.load('u1');
  assert.equal(snap.connections.size, 0);
  assert.equal(await store.getSecret('u1', connectionId), null);
  assert.ok([...snap.accounts.values()].every((a) => a.connectionId === null));
  assert.ok(snap.txns.size > 0);
  assert.ok(client.calls.some((c) => c[0] === 'remove'));
});

test('Plaid: login errors mark the connection for re-authentication', async () => {
  const store = new MemoryStore();
  const ok = fakePlaid({ pages: { start: { added: [], modified: [], removed: [], next_cursor: 'c1', has_more: false } } });
  const deps = { store, config, plaid: async () => ok };
  const { connectionId } = await connectPlaid(deps, 'u1', { publicToken: 'p', institution: { name: 'Chase' } });
  const failing = fakePlaid({ pages: {}, failWith: 'login' });
  const result = await syncConnection({ ...deps, plaid: async () => failing }, 'u1', connectionId, { force: true });
  assert.equal(result.ok, false);
  assert.equal(result.needsReauth, true);
  const conn = (await store.load('u1')).connections.get(connectionId);
  assert.equal(conn.status, 'reauth');
  assert.equal(conn.lastError, 'Please log in to Chase again');
  // Update-mode link token uses the stored access token.
  await plaidLinkToken({ ...deps, plaid: async () => ok }, 'u1', connectionId);
  const req = ok.calls.filter((c) => c[0] === 'linkTokenCreate').pop()[1];
  assert.equal(req.access_token, 'access-sandbox-abc');
  assert.equal(req.products, undefined);
});

test('Plaid: falls back to Transactions only when Liabilities is not enabled', async () => {
  const client = fakePlaid({ pages: {}, failWith: 'no-liabilities' });
  const token = await plaidLinkToken({ store: new MemoryStore(), config, plaid: async () => client }, 'u1');
  assert.equal(token, 'link-sandbox-123');
  const reqs = client.calls.filter((c) => c[0] === 'linkTokenCreate');
  assert.equal(reqs.length, 2);
  assert.equal(reqs[1][1].optional_products, undefined);
});

test('SimpleFIN: token decoding and URL safety', () => {
  const token = Buffer.from('https://beta-bridge.simplefin.org/simplefin/claim/ABC').toString('base64');
  assert.equal(decodeSetupToken(token), 'https://beta-bridge.simplefin.org/simplefin/claim/ABC');
  for (const bad of ['http://beta-bridge.simplefin.org/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x']) {
    assert.throws(() => decodeSetupToken(Buffer.from(bad).toString('base64')), /public https/);
  }
  assert.throws(() => decodeSetupToken(''), /Paste/);
  const parsed = parseAccessUrl('https://us%40er:p%3Ass@bridge.example.org/simplefin');
  assert.equal(parsed.baseUrl, 'https://bridge.example.org/simplefin');
  assert.equal(Buffer.from(parsed.authorization.slice(6), 'base64').toString(), 'us@er:p:ss');
  assert.equal(guessKind({ name: 'Sapphire Preferred (...4821)' }), 'credit');
  assert.equal(guessKind({ name: 'TOTAL CHECKING' }), 'checking');
  assert.equal(guessKind({ name: 'Mystery', balance: '-12.00' }), 'credit');
  assert.equal(maskFromName('Sapphire Preferred (...4821)'), '4821');
  assert.equal(maskFromName('CREDIT CARD ending in 7730'), '7730');
});

test('SimpleFIN: claim, sync, pending cleanup', async () => {
  const store = new MemoryStore();
  const posted = (d) => isoToEpoch(d) + 15 * 3600; // mid-day UTC
  let pendingTxns = [{ id: 'p1', posted: 0, transacted_at: posted(daysAgo(1)), amount: '-8.40', description: 'STARBUCKS', pending: true }];
  const requests = [];
  const fakeFetch = async (url, init = {}) => {
    requests.push([url, init]);
    if (init.method === 'POST') return new Response('https://user:secret@bridge.example.org/simplefin', { status: 200 });
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from('user:secret').toString('base64')}`);
    return Response.json({
      errors: ['Connection to Chase may need attention'],
      accounts: [
        {
          org: { name: 'Chase', domain: 'chase.com' },
          id: 'ACT-card',
          name: 'Sapphire Preferred (...4821)',
          currency: 'USD',
          balance: '-452.10',
          'available-balance': '9547.90',
          'balance-date': Math.floor(Date.now() / 1000),
          transactions: [
            { id: 'T1', posted: posted(daysAgo(5)), amount: '-452.10', description: 'DELTA AIR LINES', payee: 'Delta' },
            ...pendingTxns,
          ],
        },
        {
          org: { name: 'Chase' },
          id: 'ACT-chk',
          name: 'TOTAL CHECKING (...9912)',
          currency: 'USD',
          balance: '5300.00',
          transactions: [{ id: 'Z1', posted: posted(daysAgo(1)), amount: '452.10', description: 'Zelle Payment From Acme Corp Bac9xk2m3n4p' }],
        },
      ],
    });
  };
  const deps = { store, config, fetch: fakeFetch, plaid: async () => null };
  const setupToken = Buffer.from('https://beta-bridge.simplefin.org/simplefin/claim/XYZ').toString('base64');
  const { connectionId, sync } = await connectSimplefin(deps, 'u1', { setupToken });
  assert.equal(sync.ok, true);
  assert.equal(requests[0][1].method, 'POST');
  const firstRange = new URL(requests[1][0]).searchParams;
  assert.equal(firstRange.get('pending'), '1');
  assert.ok(Number(firstRange.get('start-date')) <= isoToEpoch(daysAgo(89)));

  let snap = await store.load('u1');
  assert.equal(snap.connections.get(connectionId).institution, 'Chase');
  assert.deepEqual(snap.connections.get(connectionId).warnings, ['Connection to Chase may need attention']);
  const card = [...snap.accounts.values()].find((a) => a.kind === 'credit');
  assert.equal(card.mask, '4821');
  assert.equal(card.balanceCents, 45210, 'credit balance stored as amount owed');
  const delta = [...snap.txns.values()].find((t) => t.description === 'DELTA AIR LINES');
  assert.equal(delta.amountCents, 45210);
  assert.equal(delta.date, daysAgo(5));
  assert.equal([...snap.txns.values()].filter((t) => t.pending).length, 1);
  assert.equal(snap.reimbursements.size, 1);

  // The pending coffee disappears from the bank feed: it is removed here too.
  pendingTxns = [];
  await syncConnection(deps, 'u1', connectionId, { force: true });
  snap = await store.load('u1');
  assert.equal([...snap.txns.values()].filter((t) => t.pending).length, 0);
  assert.equal(snap.txns.size, 2);

  const all = await syncAll(deps, 'u1', { staleMinutes: 60 });
  assert.equal(all[0].skipped, true, 'fresh connections are not re-synced when the app opens');
});

test('SimpleFIN: revoked access asks to reconnect', async () => {
  const store = new MemoryStore();
  let revoked = false;
  const fakeFetch = async (url, init = {}) => {
    if (init.method === 'POST') return new Response('https://u:p@bridge.example.org/simplefin');
    if (revoked) return new Response('nope', { status: 403 });
    return Response.json({ errors: [], accounts: [] });
  };
  const deps = { store, config, fetch: fakeFetch, plaid: async () => null };
  const { connectionId } = await connectSimplefin(deps, 'u1', { setupToken: Buffer.from('https://bridge.example.org/claim/1').toString('base64') });
  revoked = true;
  const res = await syncConnection(deps, 'u1', connectionId, { force: true });
  assert.equal(res.needsReauth, true);
  assert.equal((await store.load('u1')).connections.get(connectionId).status, 'reauth');
});
