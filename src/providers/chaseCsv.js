// Chase "Download account activity" CSV files.
//
//   Credit card: Transaction Date,Post Date,Description,Category,Type,Amount,Memo
//                (business cards add a leading "Card" column)
//   Checking:    Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
//                (rows carry a trailing comma)
//
// Chase shows amounts from your side: purchases/debits are negative. We store
// the opposite sign (positive = charge), so amounts are flipped.
// Files from other banks work too if they have Date/Description/Amount (or
// Debit/Credit) columns.

import { parseCSV } from '../lib/csv.js';
import { parseFlexibleDate } from '../lib/dates.js';
import { parseMoney } from '../lib/money.js';
import { UserError } from '../core/errors.js';

const norm = (s) => String(s ?? '').trim().toLowerCase();

function findColumn(header, ...names) {
  for (const name of names) {
    const i = header.findIndex((h) => norm(h) === name);
    if (i >= 0) return i;
  }
  return -1;
}

/** "Chase1234_Activity20260930.CSV" -> "1234" */
export function maskFromFilename(filename) {
  if (!filename) return null;
  const m = /chase(\d{4})/i.exec(filename) ?? /(?:^|[^\d])(\d{4})(?:[^\d]|$)/.exec(filename.replace(/\d{8}/g, ''));
  return m ? m[1] : null;
}

/**
 * @param {string} text
 * @param {string} [filename]
 */
export function parseChaseCSV(text, filename = '') {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new UserError('The file has no transactions');
  const headerIndex = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /description/i.test(c)));
  if (headerIndex < 0) throw new UserError('Could not find the header row (expected columns like Date, Description, Amount)');
  const header = rows[headerIndex];

  const col = {
    card: findColumn(header, 'card'),
    authDate: findColumn(header, 'transaction date'),
    postDate: findColumn(header, 'post date', 'posting date', 'posted date', 'date'),
    description: findColumn(header, 'description'),
    category: findColumn(header, 'category'),
    type: findColumn(header, 'type'),
    amount: findColumn(header, 'amount'),
    debit: findColumn(header, 'debit'),
    credit: findColumn(header, 'credit'),
    memo: findColumn(header, 'memo'),
    details: findColumn(header, 'details'),
  };
  if (col.postDate < 0 && col.authDate >= 0) col.postDate = col.authDate;
  if (col.postDate < 0 || col.description < 0 || (col.amount < 0 && col.debit < 0 && col.credit < 0)) {
    throw new UserError('Unrecognized CSV format: needs date, description and amount columns');
  }
  const kind = col.details >= 0 ? 'checking' : col.authDate >= 0 || col.category >= 0 ? 'credit' : 'other';

  const out = [];
  const errors = [];
  const occurrences = new Map();
  let cardMask = null;
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    const date = parseFlexibleDate(r[col.postDate]);
    const description = (r[col.description] ?? '').trim();
    let amount = null;
    if (col.amount >= 0) amount = parseMoney(r[col.amount]);
    else {
      const debit = parseMoney(r[col.debit]) ?? 0;
      const credit = parseMoney(r[col.credit]) ?? 0;
      amount = Math.abs(credit) - Math.abs(debit);
    }
    if (!date || amount === null) {
      if (r.some((c) => c.trim())) errors.push(`Row ${i + 1}: could not read date or amount`);
      continue;
    }
    const amountCents = -amount;
    const authDate = col.authDate >= 0 ? parseFlexibleDate(r[col.authDate]) : null;
    const key = `${date}|${authDate}|${description}|${amountCents}`;
    const n = occurrences.get(key) ?? 0;
    occurrences.set(key, n + 1);
    if (col.card >= 0 && !cardMask) cardMask = (r[col.card] ?? '').trim().slice(-4) || null;
    out.push({
      externalId: `${key}|${n}`,
      date,
      authDate,
      description,
      category: col.category >= 0 ? (r[col.category] ?? '').trim() || null : null,
      bankType: col.type >= 0 ? (r[col.type] ?? '').trim() || null : col.details >= 0 ? (r[col.details] ?? '').trim() || null : null,
      memo: col.memo >= 0 ? (r[col.memo] ?? '').trim() || null : null,
      amountCents,
    });
  }
  if (!out.length) throw new UserError(errors[0] ?? 'The file has no transactions');
  return { kind, mask: cardMask ?? maskFromFilename(filename), rows: out, errors };
}
