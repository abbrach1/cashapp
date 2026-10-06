// Incoming reimbursements (Zelle deposits) and how they are split across bills.

import { hashId, newId } from '../lib/ids.js';
import { isISODate } from '../lib/dates.js';
import { UserError } from './errors.js';
import { payableBills } from './ledger.js';

/**
 * "Zelle Payment From Acme Corp Bacx2kl8qz1m" -> "Acme Corp"
 * @param {string|null|undefined} description
 */
export function parseZelleSender(description) {
  if (!description) return null;
  const m = /(?:zelle|quickpay)(?:\s+(?:payment|pmt|transfer|credit))?\s+from\s+(.+)$/i.exec(description.trim());
  if (!m) return null;
  let name = m[1].trim();
  // Drop "for <memo>", "; conf# ..." and the trailing bank reference token.
  name = name.replace(/\s+(?:for|memo)\s*[:"].*$/i, '').replace(/\s*[;,]?\s*conf(?:irmation)?\s*#.*$/i, '');
  const parts = name.split(/\s+/);
  const last = parts[parts.length - 1];
  if (parts.length > 1 && /^[A-Za-z0-9]{8,}$/.test(last) && /\d/.test(last)) parts.pop();
  name = parts.join(' ').trim();
  return name || null;
}

function haystack(txn) {
  return [txn.description, txn.rawDescription, txn.merchant, txn.bankType].filter(Boolean).join(' ').toLowerCase();
}

/** Does this deposit look like a reimbursement from the company? */
export function isReimbursementDeposit(txn, account, settings) {
  if (!account || account.role !== 'reimbursements') return false;
  if (txn.pending || txn.amountCents >= 0) return false;
  if (settings.trackingStartDate && txn.date < settings.trackingStartDate) return false;
  const text = haystack(txn);
  const keywords = (settings.reimbursementKeywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  if (keywords.length && !keywords.some((k) => text.includes(k))) return false;
  const senders = (settings.senderFilters ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  if (senders.length && !senders.some((k) => text.includes(k))) return false;
  return true;
}

export function reimbursementIdFor(txnId) {
  return hashId('r', txnId);
}

/**
 * Create reimbursement records for new matching deposits and drop untouched
 * ones that no longer match (e.g. after changing the sender filter).
 * @param {import('../store/model.js').UnitOfWork} uow
 * @param {Record<string, any>} settings
 */
export function detectReimbursements(uow, settings) {
  const now = new Date().toISOString();
  const matchedIds = new Set();
  const byTxn = new Map(uow.list('reimbursements').filter((r) => r.txnId).map((r) => [r.txnId, r]));
  for (const txn of uow.view.txns.values()) {
    const account = uow.get('accounts', txn.accountId);
    if (!isReimbursementDeposit(txn, account, settings)) continue;
    const existing = byTxn.get(txn.id) ?? uow.get('reimbursements', reimbursementIdFor(txn.id));
    const id = existing?.id ?? reimbursementIdFor(txn.id);
    matchedIds.add(id);
    if (!existing) {
      uow.put('reimbursements', {
        id,
        txnId: txn.id,
        accountId: txn.accountId,
        date: txn.date,
        amountCents: -txn.amountCents,
        sender: parseZelleSender(txn.rawDescription || txn.description) ?? parseZelleSender(txn.description),
        description: txn.description,
        method: 'zelle',
        status: 'active',
        allocations: [],
        manual: false,
        createdAt: now,
      });
    } else if (existing.amountCents !== -txn.amountCents || existing.date !== txn.date || existing.txnId !== txn.id) {
      uow.patch('reimbursements', id, { amountCents: -txn.amountCents, date: txn.date, txnId: txn.id });
    }
  }
  for (const r of uow.list('reimbursements')) {
    if (!r.txnId || matchedIds.has(r.id)) continue;
    const untouched = r.status === 'active' && !r.manual && !r.counted && !(r.allocations?.length) && !r.note;
    if (untouched) uow.delete('reimbursements', r.id);
  }
}

/**
 * Find 1..maxSize bills whose outstanding amounts add up to exactly `target`.
 * Smaller combinations are tried first (so a single exact bill always wins) and
 * older bills before newer ones.
 * @param {any[]} bills sorted by preference
 * @param {number} target
 */
export function exactCombination(bills, target, maxSize = 4) {
  const pool = bills.slice(0, 14);
  for (let size = 1; size <= maxSize; size++) {
    const chosen = [];
    const search = (start, sum) => {
      if (chosen.length === size) return sum === target;
      for (let i = start; i < pool.length; i++) {
        chosen.push(pool[i]);
        if (search(i + 1, sum + pool[i].outstandingCents)) return true;
        chosen.pop();
      }
      return false;
    };
    if (search(0, 0)) return chosen;
  }
  return null;
}

/**
 * Allocate untouched reimbursements to bills when the amount matches one bill
 * (or a few bills together) exactly. Submitted bills are preferred.
 * @param {import('../store/model.js').UnitOfWork} uow
 * @param {ReturnType<import('./ledger.js').buildLedger>} ledger
 */
export function autoMatch(uow, ledger) {
  if (!ledger.settings.autoMatch) return 0;
  const outstanding = new Map([...ledger.bills.values()].map((b) => [b.id, b.outstandingCents]));
  let matched = 0;
  const candidates = uow
    .list('reimbursements')
    .filter((r) => r.status === 'active' && !r.manual && !(r.allocations?.length))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const r of candidates) {
    const payable = payableBills(ledger, r)
      .map((b) => ({ ...b, outstandingCents: outstanding.get(b.id) }))
      .filter((b) => b.outstandingCents > 0);
    const submitted = payable.filter((b) => b.submittedOn);
    const combo = exactCombination(submitted, r.amountCents) ?? exactCombination(payable, r.amountCents);
    if (!combo) continue;
    uow.patch('reimbursements', r.id, {
      allocations: combo.map((b) => ({ billId: b.id, amountCents: b.outstandingCents, auto: true })),
    });
    for (const b of combo) outstanding.set(b.id, 0);
    matched++;
  }
  return matched;
}

/**
 * Replace a reimbursement's allocations with the user's choice.
 * @param {import('../store/model.js').UnitOfWork} uow
 * @param {string} id
 * @param {Array<{billId: string, amountCents: number}>} allocations
 */
export function setAllocations(uow, id, allocations) {
  const r = uow.get('reimbursements', id);
  if (!r) throw new UserError('Reimbursement not found', 404);
  if (!Array.isArray(allocations)) throw new UserError('Allocations must be a list');
  const merged = new Map();
  for (const a of allocations) {
    if (!a || typeof a.billId !== 'string' || !uow.get('bills', a.billId)) throw new UserError('Unknown bill in allocation');
    if (!Number.isInteger(a.amountCents) || a.amountCents < 0) throw new UserError('Allocation amounts must be positive');
    if (a.amountCents === 0) continue;
    merged.set(a.billId, (merged.get(a.billId) ?? 0) + a.amountCents);
  }
  const total = [...merged.values()].reduce((s, v) => s + v, 0);
  if (total > r.amountCents) throw new UserError('You allocated more than the payment amount');
  uow.patch('reimbursements', id, {
    allocations: [...merged].map(([billId, amountCents]) => ({ billId, amountCents, auto: false })),
    manual: true,
  });
}

/**
 * Count a deposit the automatic detection skipped (another sender name, a bank
 * transfer instead of Zelle...) as a reimbursement. It is matched to
 * statements like any other.
 * @param {import('../store/model.js').UnitOfWork} uow
 * @param {string} txnId
 */
export function countAsReimbursement(uow, txnId) {
  const txn = uow.getTxn(txnId);
  if (!txn) throw new UserError('Transaction not found', 404);
  if (txn.pending || txn.amountCents >= 0) throw new UserError('Only money you received can be a reimbursement');
  const existing = uow.list('reimbursements').find((r) => r.txnId === txn.id);
  if (existing) {
    if (existing.status !== 'active' || !existing.counted) uow.patch('reimbursements', existing.id, { status: 'active', counted: true });
    return existing.id;
  }
  const text = txn.rawDescription || txn.description;
  const id = reimbursementIdFor(txn.id);
  uow.put('reimbursements', {
    id,
    txnId: txn.id,
    accountId: txn.accountId,
    date: txn.date,
    amountCents: -txn.amountCents,
    sender: parseZelleSender(text) ?? parseZelleSender(txn.description),
    description: txn.description,
    method: /zelle|quickpay/i.test(text) ? 'zelle' : 'other',
    status: 'active',
    allocations: [],
    manual: false,
    counted: true,
    createdAt: new Date().toISOString(),
  });
  return id;
}

/**
 * Record a reimbursement that did not come through a connected account
 * (a check, a Zelle to another bank, payroll...).
 * @param {import('../store/model.js').UnitOfWork} uow
 */
export function addManualReimbursement(uow, input) {
  const amountCents = input.amountCents;
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new UserError('Enter the amount you received');
  if (!isISODate(input.date)) throw new UserError('Enter the date you received it');
  const id = newId('r');
  uow.put('reimbursements', {
    id,
    txnId: null,
    accountId: null,
    date: input.date,
    amountCents,
    sender: input.sender ? String(input.sender).trim().slice(0, 120) : null,
    description: null,
    method: ['zelle', 'check', 'payroll', 'ach', 'cash', 'other'].includes(input.method) ? input.method : 'other',
    status: 'active',
    allocations: [],
    manual: false,
    note: input.note ? String(input.note).trim().slice(0, 500) : null,
    createdAt: new Date().toISOString(),
  });
  return id;
}

/** Remove allocations that point at bills which no longer exist. */
export function pruneDanglingAllocations(uow) {
  for (const r of uow.list('reimbursements')) {
    const allocations = r.allocations ?? [];
    const kept = allocations.filter((a) => uow.get('bills', a.billId));
    if (kept.length !== allocations.length) uow.patch('reimbursements', r.id, { allocations: kept });
  }
}
