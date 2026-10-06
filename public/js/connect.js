// Bank connection and sync flows used across pages.

import { post } from './api.js';
import { plural } from './format.js';
import { openPlaidLink, resumePlaidOAuth } from './plaid.js';
import { getStore, refresh, setStore, toast } from './store.js';

const STALE_MINUTES = 240;
const HISTORY_DONE = 'HISTORICAL_UPDATE_COMPLETE';
const HISTORY_LOADING = ['NOT_READY', 'INITIAL_UPDATE_COMPLETE'];
const WEEK_MS = 7 * 24 * 3600_000;

/**
 * Bank connections still sending older history. Plaid delivers the latest
 * month first and the rest (up to a year) a few minutes later.
 */
export function historyLoading(state) {
  return (state?.connections ?? []).filter(
    (c) =>
      c.provider === 'plaid' &&
      c.status === 'ok' &&
      HISTORY_LOADING.includes(c.historyStatus) &&
      (!c.createdAt || Date.now() - Date.parse(c.createdAt) < WEEK_MS),
  );
}

let watching = false;

/** While older history is on its way, check back every so often (about 15 minutes). */
export async function watchHistory() {
  if (watching) return;
  watching = true;
  try {
    for (const seconds of [8, 15, 20, 30, 30, 45, 45, 60, 60, 60, 90, 90, 120, 120, 120]) {
      if (!historyLoading(getStore().state).length) return;
      await new Promise((r) => setTimeout(r, seconds * 1000));
      for (const c of historyLoading(getStore().state)) {
        if (getStore().syncing) continue;
        let res;
        try {
          res = await post(`/connections/${c.id}/sync`);
        } catch {
          continue;
        }
        refresh(res.state);
        const r = res.result ?? {};
        if (r.ok === false) continue;
        const done = r.historyStatus === HISTORY_DONE;
        if (r.added > 0) toast(`${c.institution ?? 'Your bank'} sent ${plural(r.added, 'more transaction')}${done ? ' — your history is complete' : ''}.`);
        else if (done) toast(`All of your ${c.institution ?? 'bank'} history is in.`);
      }
    }
  } finally {
    watching = false;
  }
}

async function finishPlaid(result, connectionId = null) {
  if (!result) return;
  if (connectionId) {
    const res = await post(`/connections/${connectionId}/sync`);
    refresh(res.state);
    toast('Reconnected. Your transactions are up to date.');
    watchHistory();
    return;
  }
  toast('Connected! Importing your transactions…');
  const res = await post('/plaid/exchange', { publicToken: result.publicToken, institution: result.metadata?.institution ?? null });
  refresh(res.state);
  if (!res.sync?.ok) {
    toast(res.sync?.error ?? 'Connected, but the first import failed. Try "Sync now" in a minute.', 'error', 8000);
    return;
  }
  // Chase sends the latest month first; older history follows within minutes.
  const more = res.sync.historyStatus !== HISTORY_DONE;
  if (res.sync.added) toast(`Imported ${plural(res.sync.added, 'transaction')}.${more ? ' Older history is on its way.' : ''}`, 'info', 6000);
  else toast('Connected. Your bank is preparing your history; it will appear here in a few minutes.', 'info', 6000);
  watchHistory();
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
  if (!state.lastSyncedAt || historyLoading(state).length) return true;
  return Date.now() - Date.parse(state.lastSyncedAt) > STALE_MINUTES * 60_000;
}
