// Derived view of a user's data: which transactions belong to which bill, how
// much is claimed, what has been paid and reimbursed. Pure function of the
// snapshot, recomputed on every request.

import { claimInfo } from './claims.js';
import { dueDateAfter } from './bills.js';
import { getSettings } from './settings.js';

const byDateThenId = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1);
const byStart = (a, b) => (a.start < b.start ? -1 : 1);

/**
 * @param {import('../store/model.js').Snapshot} snapshot
 * @param {{ today: string }} opts
 */
export function buildLedger(snapshot, { today }) {
  const settings = getSettings(snapshot);
  const rules = [...snapshot.rules.values()];
  const trackingStart = settings.trackingStartDate;

  /** @type {Map<string, any[]>} */
  const txnsByAccount = new Map();
  for (const t of snapshot.txns.values()) {
    if (!txnsByAccount.has(t.accountId)) txnsByAccount.set(t.accountId, []);
    txnsByAccount.get(t.accountId).push(t);
  }
  for (const list of txnsByAccount.values()) list.sort(byDateThenId);

  /** @type {Map<string, any[]>} */
  const allocationsByBill = new Map();
  for (const r of snapshot.reimbursements.values()) {
    if (r.status !== 'active') continue;
    for (const a of r.allocations ?? []) {
      if (!allocationsByBill.has(a.billId)) allocationsByBill.set(a.billId, []);
      allocationsByBill.get(a.billId).push({
        reimbursementId: r.id,
        amountCents: a.amountCents,
        auto: Boolean(a.auto),
        date: r.date,
        sender: r.sender ?? null,
        method: r.method,
      });
    }
  }

  /** @type {Map<string, import('./claims.js').ClaimInfo>} */
  const claims = new Map();
  /** @type {Map<string, string>} */
  const txnBill = new Map();
  /** @type {Map<string, any>} */
  const bills = new Map();
  /** @type {Map<string, any[]>} */
  const billsByAccount = new Map();

  for (const account of snapshot.accounts.values()) {
    const txns = txnsByAccount.get(account.id) ?? [];
    if (account.role === 'expenses') {
      for (const t of txns) claims.set(t.id, claimInfo(t, { rules, settings }));
    }
    const accountBills = [...snapshot.bills.values()].filter((b) => b.accountId === account.id).sort(byStart);
    const perBill = accountBills.map(() => []);
    let bi = 0;
    for (const t of txns) {
      while (bi < accountBills.length && accountBills[bi].end < t.date) bi++;
      if (bi < accountBills.length && accountBills[bi].start <= t.date) {
        perBill[bi].push(t);
        txnBill.set(t.id, accountBills[bi].id);
      }
    }

    const views = accountBills.map((bill, i) => summarizeBill(bill, perBill[i], { account, claims, allocationsByBill, today, trackingStart }));
    estimateStatementBalances(views, account, txns);
    detectPayments(views, txns);
    for (const v of views) {
      v.status = billStatus(v);
      bills.set(v.id, v);
    }
    billsByAccount.set(account.id, views);
  }

  const reimbursements = new Map();
  for (const r of snapshot.reimbursements.values()) {
    const allocatedCents = (r.allocations ?? []).reduce((s, a) => s + a.amountCents, 0);
    reimbursements.set(r.id, {
      ...r,
      allocations: r.allocations ?? [],
      allocatedCents,
      unallocatedCents: r.amountCents - allocatedCents,
    });
  }

  const ledger = { settings, today, trackingStart, claims, txnBill, bills, billsByAccount, reimbursements };
  for (const r of reimbursements.values()) {
    r.suggestion = r.status === 'active' && r.unallocatedCents > 0 ? suggestAllocation(ledger, r) : [];
  }
  return { ...ledger, dashboard: buildDashboard(snapshot, ledger) };
}

function summarizeBill(bill, txns, { account, claims, allocationsByBill, today, trackingStart }) {
  let chargesCents = 0;
  let creditsCents = 0;
  let claimCents = 0;
  let netActivityCents = 0;
  let paymentsInCents = 0;
  let pendingCents = 0;
  const counts = { txns: 0, claimed: 0, excluded: 0, partial: 0, pending: 0, payments: 0 };
  for (const t of txns) {
    if (t.pending) {
      counts.pending++;
      pendingCents += t.amountCents;
      continue;
    }
    if (t.kind === 'payment') {
      counts.payments++;
      paymentsInCents += -t.amountCents;
      continue;
    }
    netActivityCents += t.amountCents;
    const c = claims.get(t.id);
    if (!c?.applicable) continue;
    counts.txns++;
    if (t.amountCents > 0) chargesCents += t.amountCents;
    else creditsCents += t.amountCents;
    claimCents += c.claimCents;
    if (c.status === 'claimed') counts.claimed++;
    else if (c.status === 'excluded') counts.excluded++;
    else counts.partial++;
  }
  const allocations = allocationsByBill.get(bill.id) ?? [];
  const receivedCents = allocations.reduce((s, a) => s + a.amountCents, 0);
  return {
    id: bill.id,
    accountId: bill.accountId,
    start: bill.start,
    end: bill.end,
    dueDate: bill.dueDate ?? dueDateAfter(bill.end, account.dueDay),
    dueDateSource: bill.dueDate ? 'bank' : account.dueDay ? 'setting' : null,
    isOpen: today <= bill.end,
    visible: !trackingStart || bill.end >= trackingStart,
    locked: Boolean(bill.locked),
    submittedOn: bill.submittedOn ?? null,
    note: bill.note ?? null,
    paidState: bill.paidState ?? null,
    manualPaidOn: bill.paidOn ?? null,
    explicitStmtBalanceCents: Number.isInteger(bill.stmtBalanceCents) ? bill.stmtBalanceCents : null,
    counts,
    chargesCents,
    creditsCents,
    claimCents,
    excludedCents: chargesCents + creditsCents - claimCents,
    netActivityCents,
    paymentsInCents,
    pendingCents,
    receivedCents,
    outstandingCents: claimCents - receivedCents,
    allocations,
  };
}

/**
 * Statement balance for every closed bill: taken from the bank when known,
 * otherwise rolled forward/backward from the nearest known statement, or from
 * the current card balance, or (last resort) the bill's own new activity.
 */
function estimateStatementBalances(views, account, txns) {
  const anchors = views.map((v, i) => (v.explicitStmtBalanceCents !== null ? i : -1)).filter((i) => i >= 0);
  const flow = (v) => v.netActivityCents - v.paymentsInCents;
  const firstTxnDate = txns.find((t) => !t.pending)?.date ?? null;
  const posted = txns.filter((t) => !t.pending);

  views.forEach((v, k) => {
    if (v.explicitStmtBalanceCents !== null) {
      v.stmtBalanceCents = v.explicitStmtBalanceCents;
      v.stmtSource = 'statement';
      return;
    }
    if (anchors.length) {
      const after = anchors.find((j) => j > k);
      const before = [...anchors].reverse().find((j) => j < k);
      const useAfter = after !== undefined && (before === undefined || after - k <= k - before);
      let s;
      if (useAfter) {
        s = views[after].explicitStmtBalanceCents;
        for (let i = after; i > k; i--) s -= flow(views[i]);
      } else {
        s = views[before].explicitStmtBalanceCents;
        for (let i = before + 1; i <= k; i++) s += flow(views[i]);
      }
      v.stmtBalanceCents = s;
      v.stmtSource = 'estimated';
      return;
    }
    const hasHistory = firstTxnDate && firstTxnDate <= v.start;
    if (Number.isInteger(account.balanceCents) && account.connectionId && hasHistory) {
      let s = account.balanceCents;
      for (const t of posted) if (t.date > v.end) s -= t.amountCents;
      v.stmtBalanceCents = s;
      v.stmtSource = 'estimated';
      return;
    }
    v.stmtBalanceCents = v.netActivityCents;
    v.stmtSource = 'activity';
  });
}

/**
 * A bill is paid once card payments made after its closing date add up to the
 * statement balance. Payments are used oldest-bill-first, so one payment never
 * counts twice.
 */
function detectPayments(views, txns) {
  const payments = txns
    .filter((t) => t.kind === 'payment' && !t.pending)
    .map((t) => ({ date: t.date, remaining: -t.amountCents }));
  for (const v of views) {
    const needed = Math.max(0, v.stmtBalanceCents ?? 0);
    let paidCents = 0;
    let autoPaidOn = null;
    if (!v.isOpen && needed > 0) {
      for (const p of payments) {
        if (p.date <= v.end || p.remaining <= 0) continue;
        const use = Math.min(p.remaining, needed - paidCents);
        p.remaining -= use;
        paidCents += use;
        if (paidCents >= needed) {
          autoPaidOn = p.date;
          break;
        }
      }
    }
    let paid;
    let paidOn = null;
    let source = null;
    if (v.paidState === 'paid') {
      paid = true;
      paidOn = v.manualPaidOn ?? autoPaidOn;
      source = 'manual';
    } else if (v.paidState === 'unpaid') {
      paid = false;
      source = 'manual';
    } else if (v.isOpen) {
      paid = false;
    } else if (needed === 0) {
      paid = true;
      source = 'none-due';
    } else {
      paid = paidCents >= needed;
      paidOn = autoPaidOn;
      source = paid ? 'auto' : null;
    }
    v.paid = { paid, paidOn, source, paidCents, neededCents: needed };
  }
}

/** @param {any} v */
export function billStatus(v) {
  if (v.isOpen) return 'open';
  if (v.receivedCents === 0 && v.claimCents <= 0) return 'nothing';
  if (v.receivedCents >= v.claimCents) return 'reimbursed';
  if (v.receivedCents > 0) return 'partial';
  if (v.submittedOn) return 'submitted';
  if (v.paid.paid) return 'ready';
  return 'unpaid';
}

const OUTSTANDING_STATUSES = new Set(['unpaid', 'ready', 'submitted', 'partial']);

/**
 * Bills that can still receive money for a reimbursement, oldest first:
 * submitted bills before ones not yet sent.
 */
export function payableBills(ledger, reimbursement) {
  return [...ledger.bills.values()]
    .filter((b) => b.visible && OUTSTANDING_STATUSES.has(b.status) && b.outstandingCents > 0 && b.start <= reimbursement.date)
    .sort((a, b) => {
      const sa = a.submittedOn ? 0 : 1;
      const sb = b.submittedOn ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a.end < b.end ? -1 : a.end > b.end ? 1 : 0;
    });
}

/** Oldest-first split of a reimbursement's unallocated amount. */
export function suggestAllocation(ledger, r) {
  let left = r.unallocatedCents;
  const out = [];
  for (const b of payableBills(ledger, r)) {
    if (left <= 0) break;
    const use = Math.min(left, b.outstandingCents);
    out.push({ billId: b.id, amountCents: use });
    left -= use;
  }
  return out;
}

function buildDashboard(snapshot, ledger) {
  const year = ledger.today.slice(0, 4);
  const d = {
    owedCents: 0,
    awaitingCompanyCents: 0,
    readyCount: 0,
    readyCents: 0,
    unpaidCount: 0,
    unpaidCents: 0,
    currentCycleCents: 0,
    receivedYtdCents: 0,
    unmatchedCount: 0,
    unmatchedCents: 0,
    accountsNeedingSetup: [],
  };
  for (const b of ledger.bills.values()) {
    if (!b.visible) continue;
    if (b.status === 'open') d.currentCycleCents += b.claimCents;
    if (OUTSTANDING_STATUSES.has(b.status) && b.outstandingCents > 0) d.owedCents += b.outstandingCents;
    if ((b.status === 'submitted' || b.status === 'partial') && b.outstandingCents > 0) d.awaitingCompanyCents += b.outstandingCents;
    if (b.status === 'ready') {
      d.readyCount++;
      d.readyCents += b.outstandingCents;
    }
    if (b.status === 'unpaid') {
      d.unpaidCount++;
      d.unpaidCents += b.outstandingCents;
    }
  }
  for (const r of ledger.reimbursements.values()) {
    if (r.status !== 'active') continue;
    if (r.date.startsWith(year)) d.receivedYtdCents += r.amountCents;
    if (r.unallocatedCents > 0) {
      d.unmatchedCount++;
      d.unmatchedCents += r.unallocatedCents;
    }
  }
  for (const a of snapshot.accounts.values()) {
    if (a.role === 'expenses' && !a.closingDay) d.accountsNeedingSetup.push(a.id);
  }
  return d;
}
