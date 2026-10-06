// Merge account and transaction data from a bank connection or a CSV file into
// the user's records without losing anything the user decided (exceptions,
// notes, reimbursement links).

import { hashId, newId } from '../lib/ids.js';
import { diffDays } from '../lib/dates.js';
import { classify } from './classify.js';

const USER_FIELDS = ['override', 'claimCents', 'note', 'reviewedAt'];

/**
 * @typedef {{
 *   externalId: string,
 *   name: string,
 *   officialName?: string|null,
 *   mask?: string|null,
 *   kind: 'credit'|'checking'|'savings'|'other',
 *   institution?: string|null,
 *   balanceCents?: number|null,
 *   availableCents?: number|null,
 *   balanceAt?: string|null,
 *   statement?: { date?: string|null, balanceCents?: number|null, dueDate?: string|null, minimumCents?: number|null } | null,
 * }} ProviderAccount
 *
 * @typedef {{
 *   accountExternalId: string,
 *   externalId: string,
 *   date: string,
 *   authDate?: string|null,
 *   description: string,
 *   rawDescription?: string|null,
 *   merchant?: string|null,
 *   category?: string|null,
 *   categoryDetail?: string|null,
 *   bankType?: string|null,
 *   amountCents: number,
 *   pending?: boolean,
 *   pendingExternalId?: string|null,
 * }} ProviderTxn
 *
 * @typedef {{
 *   source: 'plaid'|'simplefin'|'csv'|'demo',
 *   connectionId: string|null,
 *   accounts: ProviderAccount[],
 *   upserts: ProviderTxn[],
 *   accountIds?: Record<string, string>,
 *   removed?: string[],
 *   pendingSeen?: Record<string, string[]>,
 * }} Batch
 */

export function txnIdFor(source, externalId) {
  return hashId('t', source, externalId);
}

export function defaultRole(kind) {
  if (kind === 'credit') return 'expenses';
  if (kind === 'checking') return 'reimbursements';
  return 'ignore';
}

function hasUserData(txn) {
  return USER_FIELDS.some((f) => txn[f] !== null && txn[f] !== undefined);
}

/** Move exceptions/notes and reimbursement links from one transaction to another. */
export function transferUserData(uow, fromTxn, toTxn) {
  const current = uow.getTxn(toTxn.id);
  if (current && !hasUserData(current) && hasUserData(fromTxn)) {
    const patch = {};
    for (const f of USER_FIELDS) patch[f] = fromTxn[f] ?? null;
    // A partial claim only makes sense if the amount did not change: fall back
    // to the default and ask again.
    if (patch.override === 'partial' && fromTxn.amountCents !== current.amountCents) {
      patch.override = null;
      patch.claimCents = null;
      patch.reviewedAt = null;
    }
    uow.patchTxn(toTxn.id, patch);
  }
  for (const r of uow.list('reimbursements')) {
    if (r.txnId === fromTxn.id) uow.patch('reimbursements', r.id, { txnId: toTxn.id });
  }
}

/**
 * @param {import('../store/model.js').UnitOfWork} uow
 * @param {ProviderAccount} pa
 * @param {Batch} batch
 */
function upsertAccount(uow, pa, batch) {
  const now = new Date().toISOString();
  const fromProvider = {
    name: pa.name,
    officialName: pa.officialName ?? null,
    mask: pa.mask ?? null,
    institution: pa.institution ?? null,
  };
  if (pa.balanceCents !== undefined) {
    Object.assign(fromProvider, {
      balanceCents: pa.balanceCents ?? null,
      availableCents: pa.availableCents ?? null,
      balanceAt: pa.balanceAt ?? now,
    });
  }
  if (pa.statement) {
    Object.assign(fromProvider, {
      stmtDate: pa.statement.date ?? null,
      stmtBalanceCents: pa.statement.balanceCents ?? null,
      stmtDueDate: pa.statement.dueDate ?? null,
      stmtMinimumCents: pa.statement.minimumCents ?? null,
    });
  }

  let account = uow
    .list('accounts')
    .find((a) => a.connectionId === batch.connectionId && a.externalId === pa.externalId && a.source === batch.source);
  if (!account && batch.connectionId) {
    // Adopt an account created earlier from a CSV import (same last 4 digits).
    account = uow
      .list('accounts')
      .find((a) => !a.connectionId && a.mask && a.mask === pa.mask && a.kind === pa.kind);
  }
  if (account) {
    const patch = { ...fromProvider, connectionId: batch.connectionId, externalId: pa.externalId, source: batch.source };
    const changed = Object.entries(patch).some(([k, v]) => account[k] !== v);
    return changed ? uow.patch('accounts', account.id, patch) : account;
  }
  return uow.put('accounts', {
    id: newId('a'),
    ...fromProvider,
    connectionId: batch.connectionId,
    externalId: pa.externalId,
    source: batch.source,
    kind: pa.kind,
    role: defaultRole(pa.kind),
    nickname: null,
    closingDay: pa.statement?.date ? Number(pa.statement.date.slice(8, 10)) : null,
    dueDay: pa.statement?.dueDate ? Number(pa.statement.dueDate.slice(8, 10)) : null,
    createdAt: now,
  });
}

/**
 * Find an earlier copy of the same bank transaction that came from a different
 * source (e.g. a CSV import that a bank connection now also returns).
 */
function findCrossSourceTwin(candidates, pt, claimed) {
  let best = null;
  let bestGap = Infinity;
  for (const t of candidates) {
    if (claimed.has(t.id) || t.pending || t.amountCents !== pt.amountCents) continue;
    const gap = Math.abs(diffDays(t.date, pt.date));
    if (gap <= 3 && gap < bestGap) {
      best = t;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * @param {import('../store/model.js').UnitOfWork} uow
 * @param {Batch} batch
 */
export function ingest(uow, batch) {
  const stats = { accountsAdded: 0, added: 0, updated: 0, removed: 0, skippedDuplicates: 0 };
  /** @type {Map<string, string>} */
  const accountIdByExternal = new Map(Object.entries(batch.accountIds ?? {}));
  for (const pa of batch.accounts) {
    const before = uow.view.accounts.size;
    const account = upsertAccount(uow, pa, batch);
    if (uow.view.accounts.size > before) stats.accountsAdded++;
    accountIdByExternal.set(pa.externalId, account.id);
  }

  const now = new Date().toISOString();
  /** @type {Map<string, any[]>} transactions from other sources, per account */
  const otherSource = new Map();
  const claimedTwins = new Set();
  const addedThisBatch = [];

  for (const pt of batch.upserts) {
    const accountId = accountIdByExternal.get(pt.accountExternalId);
    if (!accountId) continue;
    const account = uow.get('accounts', accountId);
    const id = txnIdFor(batch.source, pt.externalId);
    const fields = {
      accountId,
      source: batch.source,
      externalId: pt.externalId,
      date: pt.date,
      authDate: pt.authDate ?? null,
      description: pt.description,
      rawDescription: pt.rawDescription ?? null,
      merchant: pt.merchant ?? null,
      category: pt.category ?? null,
      bankType: pt.bankType ?? null,
      amountCents: pt.amountCents,
      pending: Boolean(pt.pending),
      pendingExternalId: pt.pendingExternalId ?? null,
      kind: classify({
        accountKind: account.kind,
        amountCents: pt.amountCents,
        description: pt.description,
        rawDescription: pt.rawDescription,
        categoryDetail: pt.categoryDetail,
        bankType: pt.bankType,
      }),
    };
    const existing = uow.getTxn(id);
    if (existing) {
      const changed = Object.entries(fields).some(([k, v]) => existing[k] !== v);
      if (changed) {
        uow.putTxn({ ...existing, ...fields, id, updatedAt: now });
        stats.updated++;
      }
      continue;
    }

    if (!otherSource.has(accountId)) {
      otherSource.set(
        accountId,
        [...uow.view.txns.values()].filter((t) => t.accountId === accountId && t.source !== batch.source),
      );
    }
    const twin = findCrossSourceTwin(otherSource.get(accountId), pt, claimedTwins);
    if (twin && batch.source === 'csv') {
      // Already known from the bank connection: skip the CSV copy.
      claimedTwins.add(twin.id);
      stats.skippedDuplicates++;
      continue;
    }

    const txn = uow.putTxn({ id, ...fields, override: null, claimCents: null, note: null, createdAt: now });
    stats.added++;
    addedThisBatch.push(txn);

    if (pt.pendingExternalId) {
      const pendingTxn = uow.getTxn(txnIdFor(batch.source, pt.pendingExternalId));
      if (pendingTxn) transferUserData(uow, pendingTxn, txn);
    }
    if (twin && twin.source === 'csv') {
      // The bank connection now returns a transaction we had from a CSV file:
      // keep the connection's copy, carry over the user's choices.
      claimedTwins.add(twin.id);
      transferUserData(uow, twin, txn);
      uow.deleteTxn(twin.id);
      stats.skippedDuplicates++;
    }
  }

  const toRemove = new Set((batch.removed ?? []).map((ext) => txnIdFor(batch.source, ext)));
  for (const [accountExternalId, seen] of Object.entries(batch.pendingSeen ?? {})) {
    const accountId = accountIdByExternal.get(accountExternalId);
    if (!accountId) continue;
    const seenIds = new Set(seen.map((ext) => txnIdFor(batch.source, ext)));
    for (const t of uow.view.txns.values()) {
      if (t.accountId === accountId && t.source === batch.source && t.pending && !seenIds.has(t.id)) toRemove.add(t.id);
    }
  }
  const successorTaken = new Set();
  for (const id of toRemove) {
    const txn = uow.getTxn(id);
    if (!txn) continue;
    const referenced = uow.list('reimbursements').some((r) => r.txnId === id);
    if (hasUserData(txn) || referenced) {
      // Banks sometimes re-issue a transaction under a new id: hand the user's
      // data to the closest new transaction with the same amount.
      let best = null;
      let bestGap = Infinity;
      for (const cand of addedThisBatch) {
        if (successorTaken.has(cand.id) || cand.accountId !== txn.accountId || cand.amountCents !== txn.amountCents) continue;
        const gap = Math.abs(diffDays(txn.date, cand.date));
        if (gap <= 7 && gap < bestGap) {
          best = cand;
          bestGap = gap;
        }
      }
      if (best) {
        successorTaken.add(best.id);
        transferUserData(uow, txn, best);
      }
    }
    uow.deleteTxn(id);
    stats.removed++;
  }
  return stats;
}
