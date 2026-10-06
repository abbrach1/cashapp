// Statement cycles ("bills") for each expense card.
//
// A bill covers [start, end] where `end` is the statement closing date. Bills
// are generated from the card's closing day (e.g. the 14th of every month).
// Bills you have touched (submitted, paid, marked reimbursed, notes,
// reimbursements, edited closing date, or statement data from the bank) are
// fixed; the rest are regenerated freely, so changing the closing day
// re-slices only untouched history.

import { newId } from '../lib/ids.js';
import { addDays, clampedDate, diffDays, maxDate, parseISO, shiftMonth } from '../lib/dates.js';
import { UserError } from './errors.js';

const MIN_STUB_DAYS = 7;

/** Closing date for a calendar month. */
export function closingDateIn(y, m, closingDay) {
  return clampedDate(y, m, closingDay);
}

/**
 * The regular statement period that contains `date`.
 * @param {string} date
 * @param {number} closingDay 1-31
 */
export function periodContaining(date, closingDay) {
  const { y, m } = parseISO(date);
  let end = closingDateIn(y, m, closingDay);
  let endMonth = { y, m };
  if (date > end) {
    endMonth = shiftMonth(y, m, 1);
    end = closingDateIn(endMonth.y, endMonth.m, closingDay);
  }
  const prev = shiftMonth(endMonth.y, endMonth.m, -1);
  const start = addDays(closingDateIn(prev.y, prev.m, closingDay), 1);
  return { start, end };
}

/** First date with the given day-of-month after the closing date. */
export function dueDateAfter(closingDate, dueDay) {
  if (!dueDay) return null;
  const { y, m } = parseISO(closingDate);
  let due = clampedDate(y, m, dueDay);
  if (due <= closingDate) {
    const next = shiftMonth(y, m, 1);
    due = clampedDate(next.y, next.m, dueDay);
  }
  return due;
}

/**
 * True when a bill carries something the user (or the bank) told us, so it
 * must not be deleted or re-sliced automatically.
 * @param {any} bill
 * @param {Set<string>} allocatedBillIds
 */
export function isFixedBill(bill, allocatedBillIds) {
  return Boolean(
    bill.locked ||
      bill.submittedOn ||
      bill.settledOn ||
      bill.paidState ||
      bill.note ||
      bill.dueDate ||
      (bill.stmtBalanceCents !== undefined && bill.stmtBalanceCents !== null) ||
      allocatedBillIds.has(bill.id),
  );
}

/**
 * Periods needed to cover [rangeStart, rangeEnd] around the fixed bills.
 * Gaps that end before `anchor` (the first date that matters) are skipped.
 * @param {string} rangeStart
 * @param {string} rangeEnd
 * @param {Array<{start: string, end: string}>} fixed sorted by start
 * @param {number} closingDay
 * @param {string} [anchor]
 */
export function fillGaps(rangeStart, rangeEnd, fixed, closingDay, anchor = rangeStart) {
  const out = [];
  let d = rangeStart;
  let guard = 0;
  while (d <= rangeEnd) {
    if (++guard > 1000) throw new Error('Bill generation did not converge');
    const covering = fixed.find((b) => b.start <= d && d <= b.end);
    if (covering) {
      d = addDays(covering.end, 1);
      continue;
    }
    const nextFixed = fixed.find((b) => b.start > d);
    let { end } = periodContaining(d, closingDay);
    // A cycle shorter than a week is never a real statement: this happens right
    // after a bill whose closing date was moved. Let it run to the next closing.
    if (diffDays(d, end) + 1 < MIN_STUB_DAYS) end = periodContaining(addDays(end, 1), closingDay).end;
    if (nextFixed && nextFixed.start <= end) end = addDays(nextFixed.start, -1);
    if (end >= anchor) out.push({ start: d, end });
    d = addDays(end, 1);
  }
  return out;
}

/**
 * Create, keep or delete the automatic bills of one expense card so that every
 * day from the first tracked statement to today belongs to exactly one bill.
 * @param {import('../store/model.js').UnitOfWork} uow
 * @param {any} account
 * @param {{ today: string, trackingStart: string|null, allocatedBillIds: Set<string> }} opts
 */
export function planAccountBills(uow, account, { today, trackingStart, allocatedBillIds }) {
  const bills = uow
    .list('bills')
    .filter((b) => b.accountId === account.id)
    .sort((a, b) => (a.start < b.start ? -1 : 1));
  if (account.role !== 'expenses' || !account.closingDay) {
    // Not tracked (any more): drop generated bills, keep ones with history.
    for (const b of bills) if (!isFixedBill(b, allocatedBillIds)) uow.delete('bills', b.id);
    return;
  }

  const fixed = bills.filter((b) => isFixedBill(b, allocatedBillIds));
  const flexible = bills.filter((b) => !isFixedBill(b, allocatedBillIds));

  let firstActivity = null;
  let lastActivity = null;
  for (const t of uow.view.txns.values()) {
    if (t.accountId !== account.id) continue;
    if (!firstActivity || t.date < firstActivity) firstActivity = t.date;
    if (!lastActivity || t.date > lastActivity) lastActivity = t.date;
  }
  const anchor = maxDate(trackingStart, firstActivity ?? today);
  const rangeStart = periodContaining(anchor, account.closingDay).start;
  const rangeEnd = maxDate(today, lastActivity);

  const desired = fillGaps(rangeStart, rangeEnd, fixed, account.closingDay, anchor);
  const key = (b) => `${b.start}|${b.end}`;
  const desiredKeys = new Set(desired.map(key));
  const kept = new Set();
  for (const b of flexible) {
    if (desiredKeys.has(key(b)) && !kept.has(key(b))) kept.add(key(b));
    else uow.delete('bills', b.id);
  }
  const now = new Date().toISOString();
  for (const p of desired) {
    if (kept.has(key(p))) continue;
    uow.put('bills', { id: newId('b'), accountId: account.id, start: p.start, end: p.end, createdAt: now });
  }
}

/**
 * Move a bill's closing date. The following bill starts the day after.
 * @param {import('../store/model.js').UnitOfWork} uow
 * @param {string} billId
 * @param {string} newEnd
 */
export function setClosingDate(uow, billId, newEnd) {
  const bill = uow.get('bills', billId);
  if (!bill) throw new UserError('Bill not found', 404);
  if (newEnd < bill.start) throw new UserError('The closing date must be on or after the statement start date');
  const siblings = uow
    .list('bills')
    .filter((b) => b.accountId === bill.accountId)
    .sort((a, b) => (a.start < b.start ? -1 : 1));
  const next = siblings.find((b) => b.start > bill.start);
  if (next) {
    if (newEnd >= next.end) throw new UserError('That closing date would overlap the whole next statement');
    if (next.start !== addDays(newEnd, 1)) uow.patch('bills', next.id, { start: addDays(newEnd, 1) });
  }
  if (bill.end !== newEnd || !bill.locked) uow.patch('bills', bill.id, { end: newEnd, locked: true });
}

/**
 * Apply what the bank reported about the latest statement (Plaid Liabilities):
 * pin that bill's closing date, balance and due date.
 * @param {import('../store/model.js').UnitOfWork} uow
 * @param {any} account
 */
export function applyStatementInfo(uow, account) {
  if (!account.stmtDate) return;
  const bill = uow
    .list('bills')
    .find((b) => b.accountId === account.id && b.start <= account.stmtDate && account.stmtDate <= b.end);
  if (!bill) return;
  if (bill.end !== account.stmtDate) {
    try {
      setClosingDate(uow, bill.id, account.stmtDate);
    } catch {
      return; // bank data disagrees with bills the user fixed by hand; leave them
    }
  }
  const current = uow.get('bills', bill.id);
  const patch = {};
  if (!current.locked) patch.locked = true;
  if (Number.isInteger(account.stmtBalanceCents) && current.stmtBalanceCents !== account.stmtBalanceCents) {
    patch.stmtBalanceCents = account.stmtBalanceCents;
  }
  if (account.stmtDueDate && account.stmtDueDate > account.stmtDate && current.dueDate !== account.stmtDueDate) {
    patch.dueDate = account.stmtDueDate;
  }
  if (Object.keys(patch).length) uow.patch('bills', bill.id, patch);
}
