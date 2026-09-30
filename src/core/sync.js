// Pull fresh data from every bank connection of a user and fold it in.
//
// Network calls happen outside the storage transaction; only the (fast) merge
// runs inside store.mutate, so a slow bank never blocks other edits.

import { openJSON, sealJSON } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';
import { todayISO } from '../lib/dates.js';
import { ingest } from './ingest.js';
import { reconcile } from './reconcile.js';
import { UserError } from './errors.js';
import { createLinkToken, exchangePublicToken, explainPlaidError, fetchPlaidBatch, plaidError, removeItem } from '../providers/plaid.js';
import { claimSetupToken, fetchSimplefinBatch } from '../providers/simplefin.js';

/**
 * @typedef {{
 *   store: import('../store/base.js').BaseStore,
 *   config: import('../config.js').Config,
 *   plaid: () => Promise<import('plaid').PlaidApi|null>,
 *   fetch?: typeof fetch,
 * }} Deps
 */

const MINUTE = 60_000;
// SimpleFIN asks apps to stay under ~24 requests a day.
const MIN_INTERVAL = { plaid: 2 * MINUTE, simplefin: 30 * MINUTE };

async function readSecret(deps, uid, connectionId) {
  const sealed = await deps.store.getSecret(uid, connectionId);
  if (!sealed) throw new UserError('Stored bank credentials are missing. Remove this connection and connect again.');
  return openJSON(sealed, deps.config.tokenKey ?? undefined);
}

/**
 * @param {Deps} deps
 * @param {string} uid
 * @param {string} connectionId
 * @param {{ force?: boolean, staleMinutes?: number }} [opts]
 */
export async function syncConnection(deps, uid, connectionId, opts = {}) {
  const snapshot = await deps.store.load(uid);
  const conn = snapshot.connections.get(connectionId);
  if (!conn) throw new UserError('Connection not found', 404);
  const last = conn.lastSyncedAt ? Date.parse(conn.lastSyncedAt) : 0;
  const minGap = opts.staleMinutes !== undefined ? opts.staleMinutes * MINUTE : MIN_INTERVAL[conn.provider] ?? 0;
  if (!opts.force && Date.now() - last < minGap) return { connectionId, skipped: true };

  let batch;
  try {
    const secret = await readSecret(deps, uid, connectionId);
    if (conn.provider === 'plaid') {
      const client = await deps.plaid();
      if (!client) throw new UserError('Plaid is not configured on this server (PLAID_CLIENT_ID / PLAID_SECRET).');
      batch = await fetchPlaidBatch(client, { accessToken: secret.accessToken, cursor: conn.cursor ?? null, institution: conn.institution });
    } else if (conn.provider === 'simplefin') {
      const since = conn.lastSyncedAt ? todayISO(deps.config.timezone, new Date(conn.lastSyncedAt)) : null;
      batch = await fetchSimplefinBatch({ accessUrl: secret.accessUrl, since, timezone: deps.config.timezone }, deps.fetch);
    } else {
      throw new UserError(`Unknown connection type ${conn.provider}`);
    }
  } catch (err) {
    const info =
      conn.provider === 'plaid' && err?.response
        ? { ...plaidError(err), message: explainPlaidError(err, deps.config.plaid.env) }
        : { message: err.message, needsReauth: Boolean(err.needsReauth) };
    await deps.store.mutate(uid, (uow) => {
      if (!uow.get('connections', connectionId)) return;
      uow.patch('connections', connectionId, {
        status: info.needsReauth ? 'reauth' : 'error',
        lastError: info.message,
        lastAttemptAt: new Date().toISOString(),
      });
    });
    return { connectionId, ok: false, error: info.message, needsReauth: info.needsReauth };
  }

  const today = todayISO(deps.config.timezone);
  const { result } = await deps.store.mutate(uid, (uow) => {
    const current = uow.get('connections', connectionId);
    if (!current) return { skipped: true };
    if (conn.provider === 'plaid' && (current.cursor ?? null) !== (conn.cursor ?? null)) {
      return { skipped: true }; // another sync already applied these changes
    }
    const stats = ingest(uow, { source: conn.provider, connectionId, ...batch });
    const now = new Date().toISOString();
    uow.patch('connections', connectionId, {
      status: 'ok',
      lastError: null,
      lastAttemptAt: now,
      lastSyncedAt: now,
      ...(conn.provider === 'plaid'
        ? { cursor: batch.nextCursor ?? current.cursor ?? null, historyStatus: batch.historyStatus ?? null, liabilities: batch.liabilitiesAvailable }
        : {}),
      warnings: batch.warnings ?? [],
    });
    reconcile(uow, { today });
    return stats;
  });
  return { connectionId, ok: true, ...result };
}

/**
 * Sync every connection. With `staleMinutes`, only connections not synced for
 * that long are refreshed (used when the app is opened).
 * @param {Deps} deps
 * @param {string} uid
 * @param {{ force?: boolean, staleMinutes?: number }} [opts]
 */
export async function syncAll(deps, uid, opts = {}) {
  const snapshot = await deps.store.load(uid);
  const results = [];
  for (const conn of snapshot.connections.values()) {
    try {
      results.push(await syncConnection(deps, uid, conn.id, opts));
    } catch (err) {
      results.push({ connectionId: conn.id, ok: false, error: err.message });
    }
  }
  return results;
}

// ---- connecting ----------------------------------------------------------

/** @param {Deps} deps */
export async function plaidLinkToken(deps, uid, connectionId = null) {
  const client = await deps.plaid();
  if (!client) throw new UserError('Plaid is not configured on this server. Set PLAID_CLIENT_ID and PLAID_SECRET.');
  let accessToken = null;
  if (connectionId) {
    const snapshot = await deps.store.load(uid);
    if (!snapshot.connections.get(connectionId)) throw new UserError('Connection not found', 404);
    accessToken = (await readSecret(deps, uid, connectionId)).accessToken;
  }
  try {
    return await createLinkToken(client, { config: deps.config, uid, accessToken });
  } catch (err) {
    throw new UserError(`Plaid: ${explainPlaidError(err, deps.config.plaid.env)}`, 502);
  }
}

/**
 * Finish Plaid Link: store the new connection and pull its data.
 * @param {Deps} deps
 */
export async function connectPlaid(deps, uid, { publicToken, institution }) {
  if (!publicToken) throw new UserError('Missing public token');
  const client = await deps.plaid();
  if (!client) throw new UserError('Plaid is not configured on this server.');
  let exchanged;
  try {
    exchanged = await exchangePublicToken(client, publicToken);
  } catch (err) {
    throw new UserError(`Plaid: ${explainPlaidError(err, deps.config.plaid.env)}`, 502);
  }
  const { result: connectionId } = await deps.store.mutate(uid, (uow) => {
    const existing = uow.list('connections').find((c) => c.provider === 'plaid' && c.itemId === exchanged.itemId);
    const id = existing?.id ?? newId('c');
    uow.put('connections', {
      ...(existing ?? {}),
      id,
      provider: 'plaid',
      itemId: exchanged.itemId,
      institution: institution?.name ?? existing?.institution ?? 'Bank',
      institutionId: institution?.institution_id ?? institution?.id ?? null,
      status: 'ok',
      lastError: null,
      cursor: existing?.cursor ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
    uow.putSecret(id, sealJSON({ accessToken: exchanged.accessToken }, deps.config.tokenKey ?? undefined));
    return id;
  });
  const sync = await syncConnection(deps, uid, connectionId, { force: true });
  return { connectionId, sync };
}

/** @param {Deps} deps */
export async function connectSimplefin(deps, uid, { setupToken }) {
  const accessUrl = await claimSetupToken(setupToken, deps.fetch);
  const { result: connectionId } = await deps.store.mutate(uid, (uow) => {
    const id = newId('c');
    uow.put('connections', {
      id,
      provider: 'simplefin',
      institution: 'SimpleFIN Bridge',
      status: 'ok',
      lastError: null,
      createdAt: new Date().toISOString(),
    });
    uow.putSecret(id, sealJSON({ accessUrl }, deps.config.tokenKey ?? undefined));
    return id;
  });
  const sync = await syncConnection(deps, uid, connectionId, { force: true });
  if (sync.ok) {
    // Name the connection after the banks it returned.
    await deps.store.mutate(uid, (uow) => {
      const names = [...new Set(uow.list('accounts').filter((a) => a.connectionId === connectionId).map((a) => a.institution).filter(Boolean))];
      if (names.length && uow.get('connections', connectionId)) uow.patch('connections', connectionId, { institution: names.join(', ') });
    });
  }
  return { connectionId, sync };
}

/**
 * Remove a connection. Its accounts and history stay (as manual accounts).
 * @param {Deps} deps
 */
export async function disconnect(deps, uid, connectionId) {
  const snapshot = await deps.store.load(uid);
  const conn = snapshot.connections.get(connectionId);
  if (!conn) throw new UserError('Connection not found', 404);
  if (conn.provider === 'plaid') {
    try {
      const client = await deps.plaid();
      const secret = await readSecret(deps, uid, connectionId);
      if (client) await removeItem(client, secret.accessToken);
    } catch {
      // Already removed on Plaid's side, or credentials unreadable: carry on.
    }
  }
  await deps.store.mutate(uid, (uow) => {
    uow.delete('connections', connectionId);
    uow.deleteSecret(connectionId);
    const detached = new Set();
    for (const a of uow.list('accounts')) {
      if (a.connectionId !== connectionId) continue;
      uow.patch('accounts', a.id, { connectionId: null, source: 'csv', externalId: null });
      detached.add(a.id);
    }
    // Treat the history like an import, so reconnecting later merges with it
    // instead of duplicating it.
    for (const t of uow.view.txns.values()) {
      if (detached.has(t.accountId) && t.source !== 'csv') uow.patchTxn(t.id, { source: 'csv' });
    }
  });
}
