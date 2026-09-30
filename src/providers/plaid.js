// Plaid: the standard way to connect Chase (OAuth) to your own app.
// Uses /transactions/sync (incremental, cursor based) and, when available,
// /liabilities/get for the exact statement closing date, balance and due date.

import { prettyCategory } from '../core/classify.js';

const REAUTH_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'PENDING_EXPIRATION',
  'PENDING_DISCONNECT',
  'ACCESS_NOT_GRANTED',
  'INVALID_CREDENTIALS',
  'INSUFFICIENT_CREDENTIALS',
  'USER_PERMISSION_REVOKED',
  'NO_ACCOUNTS',
]);

let plaidModule;

/**
 * @param {import('../config.js').Config} config
 * @returns {Promise<import('plaid').PlaidApi|null>}
 */
export async function createPlaidClient(config) {
  if (!config.plaid.clientId || !config.plaid.secret) return null;
  plaidModule ??= await import('plaid');
  const { Configuration, PlaidApi, PlaidEnvironments } = plaidModule;
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[config.plaid.env],
      baseOptions: {
        headers: { 'PLAID-CLIENT-ID': config.plaid.clientId, 'PLAID-SECRET': config.plaid.secret },
        timeout: 60_000,
      },
    }),
  );
}

/** Normalise an error thrown by the Plaid client. */
export function plaidError(err) {
  const data = err?.response?.data;
  if (data?.error_code) {
    return {
      code: data.error_code,
      message: data.display_message || data.error_message || data.error_code,
      needsReauth: REAUTH_CODES.has(data.error_code),
    };
  }
  return { code: 'NETWORK_ERROR', message: err?.message || 'Could not reach Plaid', needsReauth: false };
}

const toCents = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 100));

/**
 * @param {import('plaid').PlaidApi} client
 * @param {{ config: import('../config.js').Config, uid: string, accessToken?: string|null }} opts
 */
export async function createLinkToken(client, { config, uid, accessToken }) {
  const base = {
    user: { client_user_id: uid },
    client_name: config.appName.slice(0, 30),
    country_codes: ['US'],
    language: 'en',
    ...(config.plaid.redirectUri ? { redirect_uri: config.plaid.redirectUri } : {}),
  };
  if (accessToken) {
    const { data } = await client.linkTokenCreate({ ...base, access_token: accessToken });
    return data.link_token;
  }
  const request = {
    ...base,
    products: ['transactions'],
    optional_products: ['liabilities'],
    transactions: { days_requested: config.plaid.daysRequested },
  };
  try {
    const { data } = await client.linkTokenCreate(request);
    return data.link_token;
  } catch (err) {
    const e = plaidError(err);
    if (!/PRODUCT/.test(e.code) && !/liabilit/i.test(e.message)) throw err;
    // Plaid account without Liabilities access: connect with Transactions only.
    const { optional_products: _omit, ...withoutLiabilities } = request;
    const { data } = await client.linkTokenCreate(withoutLiabilities);
    return data.link_token;
  }
}

/** @param {import('plaid').PlaidApi} client @param {string} publicToken */
export async function exchangePublicToken(client, publicToken) {
  const { data } = await client.itemPublicTokenExchange({ public_token: publicToken });
  return { accessToken: data.access_token, itemId: data.item_id };
}

/** @param {import('plaid').PlaidApi} client @param {string} accessToken */
export async function removeItem(client, accessToken) {
  await client.itemRemove({ access_token: accessToken });
}

export function mapPlaidAccount(a, institution, liability) {
  const kind = a.type === 'credit' ? 'credit' : a.subtype === 'checking' ? 'checking' : a.subtype === 'savings' ? 'savings' : 'other';
  return {
    externalId: a.account_id,
    name: a.name,
    officialName: a.official_name ?? null,
    mask: a.mask ?? null,
    kind,
    institution: institution ?? null,
    balanceCents: toCents(a.balances?.current),
    availableCents: toCents(a.balances?.available),
    balanceAt: new Date().toISOString(),
    statement: liability
      ? {
          date: liability.last_statement_issue_date ?? null,
          balanceCents: toCents(liability.last_statement_balance),
          dueDate: liability.next_payment_due_date ?? null,
          minimumCents: toCents(liability.minimum_payment_amount),
        }
      : null,
  };
}

export function mapPlaidTransaction(t) {
  const pfc = t.personal_finance_category;
  return {
    accountExternalId: t.account_id,
    externalId: t.transaction_id,
    date: t.date,
    authDate: t.authorized_date ?? null,
    description: t.name || t.merchant_name || t.original_description || 'Transaction',
    rawDescription: t.original_description ?? null,
    merchant: t.merchant_name ?? null,
    category: prettyCategory(pfc?.primary) ?? t.category?.[0] ?? null,
    categoryDetail: pfc?.detailed ?? null,
    bankType: t.payment_channel ?? null,
    amountCents: toCents(t.amount),
    pending: Boolean(t.pending),
    pendingExternalId: t.pending_transaction_id ?? null,
  };
}

/**
 * Pull everything new since `cursor`.
 * @param {import('plaid').PlaidApi} client
 * @param {{ accessToken: string, cursor: string|null, institution?: string|null }} opts
 */
export async function fetchPlaidBatch(client, { accessToken, cursor, institution }) {
  let pages;
  for (let attempt = 1; ; attempt++) {
    try {
      pages = await syncPages(client, accessToken, cursor);
      break;
    } catch (err) {
      // Data changed on Plaid's side mid-pagination: restart from our cursor.
      if (plaidError(err).code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < 3) continue;
      throw err;
    }
  }
  let accounts = pages.accounts;
  if (!accounts.length) accounts = (await client.accountsGet({ access_token: accessToken })).data.accounts;

  /** @type {Map<string, any>} */
  const liabilities = new Map();
  let liabilitiesAvailable = false;
  if (accounts.some((a) => a.type === 'credit')) {
    try {
      const { data } = await client.liabilitiesGet({ access_token: accessToken });
      for (const l of data.liabilities?.credit ?? []) if (l.account_id) liabilities.set(l.account_id, l);
      liabilitiesAvailable = true;
    } catch (err) {
      const e = plaidError(err);
      if (e.needsReauth) throw err;
      // Liabilities not enabled for this Plaid account / not consented: fine.
    }
  }

  return {
    accounts: accounts.map((a) => mapPlaidAccount(a, institution, liabilities.get(a.account_id))),
    upserts: [...pages.added, ...pages.modified].map(mapPlaidTransaction),
    removed: pages.removed.map((r) => r.transaction_id),
    nextCursor: pages.nextCursor,
    historyStatus: pages.status,
    liabilitiesAvailable,
  };
}

async function syncPages(client, accessToken, cursor) {
  const out = { added: [], modified: [], removed: [], accounts: [], nextCursor: cursor ?? null, status: null };
  let next = cursor || undefined;
  for (let page = 0; page < 500; page++) {
    const { data } = await client.transactionsSync({
      access_token: accessToken,
      cursor: next,
      count: 500,
      options: { include_original_description: true },
    });
    out.added.push(...data.added);
    out.modified.push(...data.modified);
    out.removed.push(...data.removed);
    out.accounts = data.accounts ?? out.accounts;
    out.status = data.transactions_update_status ?? out.status;
    next = data.next_cursor;
    if (!data.has_more) break;
  }
  out.nextCursor = next || null;
  return out;
}
