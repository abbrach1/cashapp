// Bank connection and sync flows used across pages.

import { post } from './api.js';
import { openPlaidLink, resumePlaidOAuth } from './plaid.js';
import { getStore, refresh, setStore, toast } from './store.js';

const STALE_MINUTES = 240;

async function finishPlaid(result, connectionId = null) {
  if (!result) return;
  if (connectionId) {
    const res = await post(`/connections/${connectionId}/sync`);
    refresh(res.state);
    toast('Reconnected. Your transactions are up to date.');
    return;
  }
  toast('Connected! Importing your transactions…');
  const res = await post('/plaid/exchange', { publicToken: result.publicToken, institution: result.metadata?.institution ?? null });
  refresh(res.state);
  if (!res.sync?.ok) {
    toast(res.sync?.error ?? 'Connected, but the first import failed. Try "Sync now" in a minute.', 'error', 8000);
    return;
  }
  // Chase can take a minute to prepare history the first time.
  if (res.sync.historyStatus === 'NOT_READY' || res.sync.added === 0) pollNewConnection(res.connectionId);
  else toast(`Imported ${res.sync.added} transactions.`);
}

async function pollNewConnection(connectionId) {
  setStore({ syncing: true });
  try {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      const res = await post(`/connections/${connectionId}/sync`);
      refresh(res.state);
      if (res.result?.added > 0 || res.result?.ok === false) {
        if (res.result.ok) toast(`Imported ${res.result.added} transactions.`);
        return;
      }
    }
    toast('Your bank is still preparing history. It will appear on the next sync.');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setStore({ syncing: false });
  }
}

export async function connectWithPlaid() {
  try {
    await finishPlaid(await openPlaidLink());
  } catch (err) {
    toast(err.message, 'error', 7000);
  }
}

export async function reconnectPlaid(connectionId) {
  try {
    await finishPlaid(await openPlaidLink({ connectionId }), connectionId);
  } catch (err) {
    toast(err.message, 'error', 7000);
  }
}

export async function resumeOAuthIfNeeded() {
  try {
    const result = await resumePlaidOAuth();
    if (result) await finishPlaid(result, result.connectionId);
  } catch (err) {
    toast(err.message, 'error', 7000);
  }
}

/** Sync every connection. `auto` only refreshes stale ones, quietly. */
export async function syncNow({ auto = false } = {}) {
  const { state, syncing } = getStore();
  if (syncing || !state?.connections?.length) return;
  setStore({ syncing: true });
  try {
    const res = await post('/sync', auto ? { staleMinutes: STALE_MINUTES } : { force: true });
    refresh(res.state);
    const failed = res.results.filter((r) => r.ok === false);
    const added = res.results.reduce((s, r) => s + (r.added ?? 0), 0);
    if (failed.length) toast(`Sync problem: ${failed[0].error}`, 'error', 8000);
    else if (!auto) toast(added ? `Synced. ${added} new transactions.` : 'Synced. Everything is up to date.');
    else if (added) toast(`${added} new transactions from your bank.`);
  } catch (err) {
    if (!auto) toast(err.message, 'error');
  } finally {
    setStore({ syncing: false });
  }
}

export function isStale(state) {
  if (!state?.connections?.length) return false;
  if (!state.lastSyncedAt) return true;
  return Date.now() - Date.parse(state.lastSyncedAt) > STALE_MINUTES * 60_000;
}
