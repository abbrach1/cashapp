// Shapes sent to the browser.

import { accountLabel } from './exports/report.js';
import { addDays } from './lib/dates.js';
import { IN_PLAY_STATUSES, classifiable, isReviewed, merchantCounts, merchantKey, statementOf } from './core/review.js';
import { parseZelleSender } from './core/reimbursements.js';

export function connectionView(c) {
  return {
    id: c.id,
    provider: c.provider,
    institution: c.institution ?? null,
    status: c.status ?? 'ok',
    lastError: c.lastError ?? null,
    lastSyncedAt: c.lastSyncedAt ?? null,
    lastAttemptAt: c.lastAttemptAt ?? null,
    historyStatus: c.historyStatus ?? null,
    liabilities: c.liabilities ?? null,
    warnings: c.warnings ?? [],
    createdAt: c.createdAt ?? null,
  };
}

export function accountView(a, stats) {
  return {
    id: a.id,
    name: a.name,
    nickname: a.nickname ?? null,
    label: accountLabel(a),
    mask: a.mask ?? null,
    kind: a.kind,
    role: a.role,
    institution: a.institution ?? null,
    connectionId: a.connectionId ?? null,
    source: a.source ?? null,
    closingDay: a.closingDay ?? null,
    dueDay: a.dueDay ?? null,
    balanceCents: a.balanceCents ?? null,
    balanceAt: a.balanceAt ?? null,
    stmtDate: a.stmtDate ?? null,
    stmtBalanceCents: a.stmtBalanceCents ?? null,
    stmtDueDate: a.stmtDueDate ?? null,
    txnCount: stats?.count ?? 0,
    firstDate: stats?.first ?? null,
    lastDate: stats?.last ?? null,
  };
}

export function billView(b, snapshot) {
  const account = snapshot.accounts.get(b.accountId);
  return { ...b, accountLabel: accountLabel(account) };
}

export function txnView(t, ledger) {
  const c = ledger.claims.get(t.id);
  return {
    id: t.id,
    accountId: t.accountId,
    billId: ledger.txnBill.get(t.id) ?? null,
    date: t.date,
    authDate: t.authDate ?? null,
    description: t.description,
    merchant: t.merchant ?? null,
    rawDescription: t.rawDescription ?? null,
    category: t.category ?? null,
    amountCents: t.amountCents,
    pending: Boolean(t.pending),
    kind: t.kind,
    source: t.source,
    override: t.override ?? null,
    claimOverrideCents: t.claimCents ?? null,
    note: t.note ?? null,
    reviewed: isReviewed(t, c),
    reviewedAt: t.reviewedAt ?? null,
    claim: c
      ? { applicable: c.applicable, claimCents: c.claimCents, status: c.status, reason: c.reason, ruleId: c.ruleId ?? null }
      : { applicable: false, claimCents: 0, status: 'n/a', reason: null, ruleId: null },
  };
}

/**
 * Everything the app shell needs (transactions are loaded per bill/search).
 * @param {import('./store/model.js').Snapshot} snapshot
 * @param {ReturnType<import('./core/ledger.js').buildLedger>} ledger
 */
export function stateView(snapshot, ledger, extra = {}) {
  const stats = new Map();
  for (const t of snapshot.txns.values()) {
    const s = stats.get(t.accountId) ?? { count: 0, first: null, last: null };
    s.count++;
    if (!s.first || t.date < s.first) s.first = t.date;
    if (!s.last || t.date > s.last) s.last = t.date;
    stats.set(t.accountId, s);
  }
  const connections = [...snapshot.connections.values()].map(connectionView);
  const lastSyncedAt = connections.map((c) => c.lastSyncedAt).filter(Boolean).sort().pop() ?? null;
  return {
    today: ledger.today,
    settings: ledger.settings,
    connections,
    accounts: [...snapshot.accounts.values()]
      .map((a) => accountView(a, stats.get(a.id)))
      .sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'credit' ? -1 : 1)),
    bills: [...ledger.bills.values()].map((b) => billView(b, snapshot)).sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0)),
    reimbursements: [...ledger.reimbursements.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    rules: [...snapshot.rules.values()].sort((a, b) => a.pattern.localeCompare(b.pattern)),
    dashboard: ledger.dashboard,
    lastSyncedAt,
    demo: Boolean(snapshot.meta?.demo),
    ...extra,
  };
}

/**
 * One bill with its transactions, payments and reimbursements.
 */
export function billDetailView(snapshot, ledger, billId) {
  const bill = ledger.bills.get(billId);
  if (!bill) return null;
  const siblings = ledger.billsByAccount.get(bill.accountId) ?? [];
  const idx = siblings.findIndex((b) => b.id === billId);
  const next = siblings[idx + 1];
  // "All from <merchant>" changes statements still in play, plus this one.
  const similar = merchantCounts(snapshot, ledger, 'open');
  const self = bill.visible && IN_PLAY_STATUSES.has(bill.status) ? 0 : 1;
  const txns = [...snapshot.txns.values()]
    .filter((t) => ledger.txnBill.get(t.id) === billId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
    .map((t) => ({ ...txnView(t, ledger), similarCount: Math.max(1, (similar.get(merchantKey(t)) ?? 0) + self) }));
  const windowEnd = next ? next.end : '9999-12-31';
  const payments = [...snapshot.txns.values()]
    .filter((t) => t.accountId === bill.accountId && t.kind === 'payment' && !t.pending && t.date > bill.end && t.date <= windowEnd)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((t) => ({ id: t.id, date: t.date, amountCents: -t.amountCents, description: t.description }));
  return {
    bill: billView(bill, snapshot),
    account: snapshot.accounts.get(bill.accountId) ? accountView(snapshot.accounts.get(bill.accountId)) : null,
    transactions: txns.filter((t) => t.kind !== 'payment'),
    paymentsInPeriod: txns.filter((t) => t.kind === 'payment'),
    payments,
    prevBillId: siblings[idx - 1]?.id ?? null,
    nextBillId: next?.id ?? null,
  };
}

/** Text a search box matches against. */
export function searchText(t) {
  return `${t.description} ${t.merchant ?? ''} ${t.rawDescription ?? ''} ${t.note ?? ''} ${t.category ?? ''} ${(Math.abs(t.amountCents) / 100).toFixed(2)}`.toLowerCase();
}

const CLASSIFY_SHOW = {
  review: (t, c) => !isReviewed(t, c),
  all: () => true,
  business: (_t, c) => c.claimCents !== 0,
  personal: (_t, c) => c.claimCents === 0,
};

// Newest statement first; ties broken so the order (and the paging cursor) is stable.
const groupOrder = (a, b) =>
  a.end !== b.end ? (a.end < b.end ? 1 : -1) : a.accountId !== b.accountId ? (a.accountId < b.accountId ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

const encodeCursor = (g) => Buffer.from(JSON.stringify([g.end, g.accountId, g.key])).toString('base64url');
function decodeCursor(cursor) {
  try {
    const [end, accountId, key] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return typeof end === 'string' && typeof accountId === 'string' && typeof key === 'string' ? { end, accountId, key } : null;
  } catch {
    return null;
  }
}

/**
 * Card history grouped by statement, for going back through it and marking
 * what was personal. Pages hold about `limit` transactions (whole statements).
 * @param {import('./store/model.js').Snapshot} snapshot
 * @param {ReturnType<import('./core/ledger.js').buildLedger>} ledger
 * @param {{
 *   show?: string,              // review (not looked at yet) | all | business | personal
 *   scope?: string,             // open: statements not sent or reimbursed yet | all: whole history
 *   accountId?: string|null,
 *   billId?: string|null,
 *   q?: string,
 *   limit?: number,
 *   cursor?: string|null,
 *   summary?: boolean,          // only totals and statement headers (every statement, any scope)
 * }} [opts]
 */
export function classifyView(snapshot, ledger, opts = {}) {
  const show = Object.hasOwn(CLASSIFY_SHOW, opts.show ?? '') ? opts.show : 'review';
  const scope = opts.scope === 'all' || opts.billId ? 'all' : 'open';
  const q = String(opts.q ?? '').trim().toLowerCase();
  const limit = opts.limit ?? 250;

  const items = [];
  for (const item of classifiable(snapshot, ledger)) {
    const s = statementOf(item.txn, snapshot.accounts.get(item.txn.accountId), ledger);
    const inScope = scope === 'all' || s.inPlay;
    if (!inScope && !opts.summary) continue;
    items.push({ ...item, s, inScope });
  }
  // What "all from <merchant>" would change.
  const similar = opts.summary ? new Map() : merchantCounts(snapshot, ledger, scope);

  const stats = { total: 0, reviewed: 0, claimCents: 0, amountCents: 0 };
  /** @type {Map<string, any>} */
  const groups = new Map();
  for (const { txn: t, claim: c, s, inScope } of items) {
    if (opts.accountId && t.accountId !== opts.accountId) continue;
    if (opts.billId && s.billId !== opts.billId) continue;
    const account = snapshot.accounts.get(t.accountId);
    const reviewed = isReviewed(t, c);
    if (inScope) {
      stats.total++;
      if (reviewed) stats.reviewed++;
      stats.claimCents += c.claimCents;
      stats.amountCents += t.amountCents;
    }

    let g = groups.get(s.key);
    if (!g) {
      const b = s.bill;
      g = {
        key: s.key,
        billId: s.billId,
        accountId: t.accountId,
        accountLabel: accountLabel(account),
        start: s.start,
        end: s.end,
        status: b?.status ?? null,
        isOpen: b?.isOpen ?? false,
        inPlay: s.inPlay,
        tracked: b ? b.visible : s.inPlay,
        submittedOn: b?.submittedOn ?? null,
        settledOn: b?.settledOn ?? null,
        receivedCents: b?.receivedCents ?? 0,
        claimCents: 0,
        amountCents: 0,
        counts: { total: 0, reviewed: 0 },
        txns: [],
      };
      groups.set(s.key, g);
    }
    g.claimCents += c.claimCents;
    g.amountCents += t.amountCents;
    g.counts.total++;
    if (reviewed) g.counts.reviewed++;
    if (!CLASSIFY_SHOW[show](t, c)) continue;
    if (q && !searchText(t).includes(q)) continue;
    g.txns.push(t);
  }

  if (opts.summary) {
    return { show, scope, stats, groups: [...groups.values()].map(({ txns: _t, ...g }) => g) };
  }

  const ordered = [...groups.values()].filter((g) => g.txns.length).sort(groupOrder);
  let i = 0;
  if (opts.cursor) {
    const after = decodeCursor(opts.cursor);
    i = after ? ordered.findIndex((g) => groupOrder(g, after) > 0) : -1;
    if (i < 0) i = ordered.length;
  }
  const page = [];
  let count = 0;
  for (; i < ordered.length && count < limit; i++) {
    page.push(ordered[i]);
    count += ordered[i].txns.length;
  }
  const rest = ordered.slice(i);

  return {
    show,
    scope,
    stats,
    trackingStart: ledger.trackingStart ?? null,
    groups: page.map(({ txns, ...g }) => ({
      ...g,
      transactions: txns
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
        .map((t) => ({ ...txnView(t, ledger), similarCount: similar.get(merchantKey(t)) || 1 })),
    })),
    nextCursor: rest.length ? encodeCursor(page[page.length - 1]) : null,
    more: { statements: rest.length, transactions: rest.reduce((n, g) => n + g.txns.length, 0) },
  };
}

/**
 * Money received on accounts watched for reimbursements that isn't counted as
 * one (a different sender name, a bank transfer instead of Zelle, payroll...).
 * @param {import('./store/model.js').Snapshot} snapshot
 * @param {{ today: string, days?: number }} opts
 */
export function otherDepositsView(snapshot, { today, days = 90 }) {
  const since = addDays(today, -days);
  const linked = new Set([...snapshot.reimbursements.values()].map((r) => r.txnId).filter(Boolean));
  const out = [];
  for (const t of snapshot.txns.values()) {
    const account = snapshot.accounts.get(t.accountId);
    if (account?.role !== 'reimbursements' || t.pending || t.amountCents >= 0 || t.date < since || linked.has(t.id)) continue;
    const sender = parseZelleSender(t.rawDescription || t.description) ?? parseZelleSender(t.description);
    out.push({ id: t.id, accountId: t.accountId, accountLabel: accountLabel(account), date: t.date, description: t.description, sender, amountCents: -t.amountCents });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1)).slice(0, 200);
}
