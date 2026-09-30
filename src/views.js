// Shapes sent to the browser.

import { accountLabel } from './exports/report.js';

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
  const txns = [...snapshot.txns.values()]
    .filter((t) => ledger.txnBill.get(t.id) === billId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
    .map((t) => txnView(t, ledger));
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
