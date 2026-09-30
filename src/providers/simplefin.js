// SimpleFIN Bridge (https://beta-bridge.simplefin.org): a low-cost bank data
// service for personal use. You connect Chase on their site, create a setup
// token, and paste it here. Protocol: https://www.simplefin.org/protocol.html

import { addDays, epochToISODate, isoToEpoch, todayISO } from '../lib/dates.js';
import { parseMoney } from '../lib/money.js';
import { UserError } from '../core/errors.js';

const CREDIT_NAME_RE =
  /credit|card|visa|mastercard|amex|sapphire|freedom|\bink\b|slate|marriott|united|southwest|hyatt|ihg|aeroplan|disney|amazon|prime|instacart|british airways|aer lingus|iberia/i;

export class SimplefinError extends Error {
  constructor(message, { needsReauth = false } = {}) {
    super(message);
    this.name = 'SimplefinError';
    this.needsReauth = needsReauth;
  }
}

function assertSafeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new UserError('That does not look like a SimpleFIN setup token');
  }
  const host = parsed.hostname.toLowerCase();
  const isIp = /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[');
  if (parsed.protocol !== 'https:' || isIp || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new UserError('The SimpleFIN setup token must point to a public https server');
  }
  return parsed;
}

/** The setup token is a base64-encoded one-time "claim" URL. */
export function decodeSetupToken(token) {
  const trimmed = String(token ?? '').trim();
  if (!trimmed) throw new UserError('Paste your SimpleFIN setup token');
  const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
  assertSafeUrl(decoded);
  return decoded;
}

/**
 * Exchange a setup token for the long-lived access URL.
 * @param {string} token
 * @param {typeof fetch} [fetchImpl]
 */
export async function claimSetupToken(token, fetchImpl = fetch) {
  const claimUrl = decodeSetupToken(token);
  const res = await fetchImpl(claimUrl, { method: 'POST', redirect: 'error', headers: { 'Content-Length': '0' } });
  const body = (await res.text()).trim();
  if (res.status === 403) throw new UserError('This setup token was already used or has expired. Create a new one in SimpleFIN Bridge.');
  if (!res.ok) throw new UserError(`SimpleFIN rejected the setup token (HTTP ${res.status})`);
  parseAccessUrl(body);
  return body;
}

/** "https://user:pass@host/simplefin" -> base URL + basic auth header. */
export function parseAccessUrl(accessUrl) {
  const url = assertSafeUrl(accessUrl);
  if (!url.username) throw new UserError('SimpleFIN returned an access URL without credentials');
  const auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
  url.username = '';
  url.password = '';
  return { baseUrl: url.toString().replace(/\/$/, ''), authorization: `Basic ${auth}` };
}

export function guessKind(account) {
  const name = `${account.name ?? ''}`;
  if (/check/i.test(name)) return 'checking';
  if (/sav/i.test(name)) return 'savings';
  if (CREDIT_NAME_RE.test(name)) return 'credit';
  const balance = parseMoney(account.balance);
  return balance !== null && balance < 0 ? 'credit' : 'other';
}

export function maskFromName(name) {
  const m = /(?:\.{2,}|x{2,}|\*+|#|ending in\s*)(\d{4})\)?\s*$/i.exec(name ?? '') ?? /\((\d{4})\)\s*$/.exec(name ?? '');
  return m ? m[1] : null;
}

/**
 * Fetch accounts and transactions for the given date windows.
 * @param {{ accessUrl: string, since: string|null, timezone: string, now?: Date }} opts
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchSimplefinBatch({ accessUrl, since, timezone, now = new Date() }, fetchImpl = fetch) {
  const { baseUrl, authorization } = parseAccessUrl(accessUrl);
  const today = todayISO(timezone, now);
  // The bridge serves ~90 days of history and at most 60 days per request.
  const start = since ? addDays(since, -10) : addDays(today, -89);
  const windows = [];
  const end = addDays(today, 2); // end-date is exclusive and measured in UTC
  for (let from = start; from < end; from = addDays(from, 45)) {
    const to = addDays(from, 45) < end ? addDays(from, 45) : end;
    windows.push([from, to]);
  }

  /** @type {Map<string, any>} */
  const accounts = new Map();
  /** @type {Map<string, any>} */
  const txns = new Map();
  const warnings = new Set();
  for (const [from, to] of windows) {
    const url = `${baseUrl}/accounts?start-date=${isoToEpoch(from)}&end-date=${isoToEpoch(to)}&pending=1`;
    const res = await fetchImpl(url, { headers: { Authorization: authorization, Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) {
      throw new SimplefinError('SimpleFIN access was revoked. Create a new setup token and reconnect.', { needsReauth: true });
    }
    if (res.status === 402) throw new SimplefinError('Your SimpleFIN Bridge subscription needs attention (payment required).');
    if (!res.ok) throw new SimplefinError(`SimpleFIN returned HTTP ${res.status}`);
    const data = await res.json();
    for (const e of data.errors ?? []) warnings.add(String(e));
    for (const e of data.errlist ?? []) warnings.add(String(e?.msg ?? e?.message ?? e?.code ?? e));
    for (const a of data.accounts ?? []) {
      accounts.set(a.id, a);
      for (const t of a.transactions ?? []) txns.set(`${a.id}\u0001${t.id}`, { account: a, t });
    }
  }

  const mappedAccounts = [...accounts.values()].map((a) => {
    const kind = guessKind(a);
    const balance = parseMoney(a.balance);
    const available = parseMoney(a['available-balance']);
    const flip = (v) => (v === null ? null : kind === 'credit' ? -v : v);
    return {
      externalId: a.id,
      name: a.name ?? 'Account',
      mask: maskFromName(a.name),
      kind,
      institution: a.org?.name ?? a.org?.domain ?? null,
      balanceCents: flip(balance),
      availableCents: available === null ? null : kind === 'credit' ? null : available,
      balanceAt: a['balance-date'] ? new Date(a['balance-date'] * 1000).toISOString() : now.toISOString(),
    };
  });

  const upserts = [];
  /** @type {Record<string, string[]>} */
  const pendingSeen = {};
  for (const { account, t } of txns.values()) {
    const amount = parseMoney(t.amount);
    if (amount === null) continue;
    const pending = Boolean(t.pending) || !t.posted;
    const when = t.posted || t.transacted_at;
    (pendingSeen[account.id] ??= []).push(t.id);
    upserts.push({
      accountExternalId: account.id,
      externalId: t.id,
      date: when ? epochToISODate(when, timezone) : today,
      authDate: t.transacted_at ? epochToISODate(t.transacted_at, timezone) : null,
      description: (t.description || t.payee || 'Transaction').trim(),
      rawDescription: t.memo ? `${t.description ?? ''} ${t.memo}`.trim() : null,
      merchant: t.payee || null,
      amountCents: -amount,
      pending,
    });
  }
  for (const a of accounts.values()) pendingSeen[a.id] ??= [];
  return { accounts: mappedAccounts, upserts, removed: [], pendingSeen, warnings: [...warnings] };
}
