import { formatDateLong } from '../lib/dates.js';
import { accountLabel, billStatusLabel } from './report.js';
import { ledgerBills } from './csv.js';

let excel;
async function loadExcel() {
  excel ??= await import('exceljs');
  return excel.default ?? excel;
}

const MONEY = '"$"#,##0.00;[Red]-"$"#,##0.00';
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };
const d = (iso) => (iso ? new Date(`${iso}T12:00:00Z`) : null);
const dollars = (cents) => (cents === null || cents === undefined ? null : cents / 100);

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle' };
  });
  row.height = 20;
}

function newWorkbook(E, title) {
  const wb = new E.Workbook();
  wb.creator = 'Reimbursement Tracker';
  wb.title = title;
  wb.created = new Date();
  return wb;
}

/**
 * Workbook for the company: header block, claimed items, total.
 * @param {ReturnType<import('./report.js').billReport>} r
 */
export async function companyXLSX(r, { includeExcluded = false } = {}) {
  const E = await loadExcel();
  const wb = newWorkbook(E, r.title);
  const ws = wb.addWorksheet('Expenses', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [
    { key: 'date', width: 12 },
    { key: 'merchant', width: 28 },
    { key: 'description', width: 36 },
    { key: 'category', width: 18 },
    { key: 'note', width: 34 },
    { key: 'charged', width: 14 },
    { key: 'claimed', width: 14 },
  ];
  ws.addRow([r.title]).font = { bold: true, size: 16 };
  const info = [
    ['Company', r.company.name],
    ['Submitted by', r.employee.email ? `${r.employee.name} (${r.employee.email})` : r.employee.name],
    ['Card', r.account.label],
    ['Statement period', r.bill.period],
    ['Statement paid on', r.bill.paidOn ? formatDateLong(r.bill.paidOn) : ''],
    ['Reimburse via Zelle to', r.zelleHandle],
  ].filter(([, v]) => v);
  for (const [k, v] of info) {
    const row = ws.addRow([k, v]);
    row.getCell(1).font = { bold: true };
  }
  ws.addRow([]);
  const header = ws.addRow(['Date', 'Merchant', 'Description', 'Category', 'Business purpose', 'Charged', 'Claimed']);
  styleHeader(header);
  const firstDataRow = header.number + 1;
  const add = (l, excludedRow) => {
    const row = ws.addRow({
      date: d(l.date),
      merchant: l.merchant,
      description: l.description,
      category: l.category,
      note: excludedRow ? `Not claimed (personal)${l.note ? ` – ${l.note}` : ''}` : l.note,
      charged: dollars(l.amountCents),
      claimed: dollars(l.claimCents),
    });
    row.getCell('date').numFmt = 'mm/dd/yyyy';
    row.getCell('charged').numFmt = MONEY;
    row.getCell('claimed').numFmt = MONEY;
    if (excludedRow) row.font = { color: { argb: 'FF6B7280' }, italic: true };
  };
  r.claimed.forEach((l) => add(l, false));
  if (includeExcluded) r.excluded.forEach((l) => add(l, true));
  const lastDataRow = ws.lastRow.number;
  const total = ws.addRow({ note: 'Total reimbursement requested', claimed: dollars(r.totals.claimCents) });
  if (lastDataRow >= firstDataRow) {
    total.getCell('claimed').value = { formula: `SUM(G${firstDataRow}:G${lastDataRow})`, result: dollars(r.totals.claimCents) };
  }
  total.font = { bold: true };
  total.getCell('claimed').numFmt = MONEY;
  total.getCell('claimed').border = { top: { style: 'thin' }, bottom: { style: 'double' } };
  ws.views = [{ state: 'frozen', ySplit: header.number }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * Workbook for your records: summary + every transaction with its status.
 * @param {ReturnType<import('./report.js').billReport>} r
 */
export async function trackingXLSX(r) {
  const E = await loadExcel();
  const wb = newWorkbook(E, `${r.account.label} ${r.bill.period}`);
  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 26 }, { width: 44 }];
  const rows = [
    ['Card', r.account.label],
    ['Statement period', r.bill.period],
    ['Status', r.bill.statusLabel],
    ['Paid on', r.bill.paidOn ? formatDateLong(r.bill.paidOn) : r.bill.paid ? 'Nothing due' : 'Not paid yet'],
    ['Submitted on', r.bill.submittedOn ? formatDateLong(r.bill.submittedOn) : 'Not submitted'],
    ['Charges & credits', dollars(r.totals.chargesCents + r.totals.creditsCents)],
    ['Excluded (personal)', dollars(r.totals.excludedCents)],
    ['Claimed', dollars(r.totals.claimCents)],
    ['Received', dollars(r.totals.receivedCents)],
    ['Outstanding', dollars(r.totals.outstandingCents)],
  ];
  for (const [k, v] of rows) {
    const row = summary.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    if (typeof v === 'number') row.getCell(2).numFmt = MONEY;
  }
  if (r.reimbursements.length) {
    summary.addRow([]);
    styleHeader(summary.addRow(['Reimbursements received', '']));
    for (const p of r.reimbursements) {
      const row = summary.addRow([`${formatDateLong(p.date)}${p.sender ? ` – ${p.sender}` : ''}`, dollars(p.amountCents)]);
      row.getCell(2).numFmt = MONEY;
    }
  }

  const ws = wb.addWorksheet('Transactions');
  ws.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Posted', key: 'post', width: 12 },
    { header: 'Merchant', key: 'merchant', width: 26 },
    { header: 'Description', key: 'description', width: 34 },
    { header: 'Category', key: 'category', width: 16 },
    { header: 'Type', key: 'type', width: 14 },
    { header: 'Amount', key: 'amount', width: 13 },
    { header: 'Claimed', key: 'claimed', width: 13 },
    { header: 'Claim status', key: 'status', width: 30 },
    { header: 'Note', key: 'note', width: 34 },
  ];
  styleHeader(ws.getRow(1));
  for (const l of r.lines) {
    const row = ws.addRow({
      date: d(l.date),
      post: d(l.postDate),
      merchant: l.merchant,
      description: l.description,
      category: l.category,
      type: l.kindLabel,
      amount: dollars(l.amountCents),
      claimed: dollars(l.claimCents),
      status: l.reasonLabel,
      note: l.note,
    });
    row.getCell('date').numFmt = 'mm/dd/yyyy';
    row.getCell('post').numFmt = 'mm/dd/yyyy';
    row.getCell('amount').numFmt = MONEY;
    row.getCell('claimed').numFmt = MONEY;
  }
  ws.autoFilter = { from: 'A1', to: 'J1' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * Everything: all bills, their transactions and all reimbursements.
 * @param {import('../store/model.js').Snapshot} snapshot
 * @param {ReturnType<import('../core/ledger.js').buildLedger>} ledger
 */
export async function ledgerXLSX(snapshot, ledger) {
  const E = await loadExcel();
  const wb = newWorkbook(E, 'Reimbursement ledger');
  const bills = ledgerBills(ledger);

  const ws = wb.addWorksheet('Bills');
  ws.columns = [
    { header: 'Card', key: 'card', width: 30 },
    { header: 'Statement start', key: 'start', width: 15 },
    { header: 'Statement closing', key: 'end', width: 17 },
    { header: 'Due', key: 'due', width: 12 },
    { header: 'Paid on', key: 'paid', width: 12 },
    { header: 'Submitted on', key: 'submitted', width: 14 },
    { header: 'Claimed', key: 'claimed', width: 13 },
    { header: 'Received', key: 'received', width: 13 },
    { header: 'Outstanding', key: 'outstanding', width: 13 },
    { header: 'Status', key: 'status', width: 34 },
  ];
  styleHeader(ws.getRow(1));
  for (const b of bills) {
    const row = ws.addRow({
      card: accountLabel(snapshot.accounts.get(b.accountId)),
      start: d(b.start),
      end: d(b.end),
      due: d(b.dueDate),
      paid: b.paid.paid ? d(b.paid.paidOn) : null,
      submitted: d(b.submittedOn),
      claimed: dollars(b.claimCents),
      received: dollars(b.receivedCents),
      outstanding: dollars(b.outstandingCents),
      status: billStatusLabel(b),
    });
    for (const k of ['start', 'end', 'due', 'paid', 'submitted']) row.getCell(k).numFmt = 'mm/dd/yyyy';
    for (const k of ['claimed', 'received', 'outstanding']) row.getCell(k).numFmt = MONEY;
  }
  ws.autoFilter = { from: 'A1', to: 'J1' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const tx = wb.addWorksheet('Transactions');
  tx.columns = [
    { header: 'Card', key: 'card', width: 30 },
    { header: 'Statement closing', key: 'bill', width: 17 },
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Merchant', key: 'merchant', width: 28 },
    { header: 'Category', key: 'category', width: 16 },
    { header: 'Amount', key: 'amount', width: 13 },
    { header: 'Claimed', key: 'claimed', width: 13 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Note', key: 'note', width: 34 },
  ];
  styleHeader(tx.getRow(1));
  const visibleBills = new Map(bills.map((b) => [b.id, b]));
  const txns = [...snapshot.txns.values()]
    .filter((t) => visibleBills.has(ledger.txnBill.get(t.id)) && !t.pending && ledger.claims.get(t.id)?.applicable)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const t of txns) {
    const c = ledger.claims.get(t.id);
    const row = tx.addRow({
      card: accountLabel(snapshot.accounts.get(t.accountId)),
      bill: d(visibleBills.get(ledger.txnBill.get(t.id)).end),
      date: d(t.authDate ?? t.date),
      merchant: t.merchant || t.description,
      category: t.category ?? '',
      amount: dollars(t.amountCents),
      claimed: dollars(c.claimCents),
      status: c.status,
      note: t.note ?? '',
    });
    row.getCell('bill').numFmt = 'mm/dd/yyyy';
    row.getCell('date').numFmt = 'mm/dd/yyyy';
    row.getCell('amount').numFmt = MONEY;
    row.getCell('claimed').numFmt = MONEY;
  }
  tx.autoFilter = { from: 'A1', to: 'I1' };
  tx.views = [{ state: 'frozen', ySplit: 1 }];

  const rs = wb.addWorksheet('Reimbursements');
  rs.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'From', key: 'from', width: 28 },
    { header: 'Method', key: 'method', width: 10 },
    { header: 'Amount', key: 'amount', width: 13 },
    { header: 'Unallocated', key: 'unallocated', width: 13 },
    { header: 'Applied to', key: 'applied', width: 60 },
    { header: 'Kind', key: 'status', width: 22 },
  ];
  styleHeader(rs.getRow(1));
  const reimbs = [...ledger.reimbursements.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const r of reimbs) {
    const applied = r.allocations
      .map((a) => {
        const b = ledger.bills.get(a.billId);
        return b ? `${accountLabel(snapshot.accounts.get(b.accountId))} closing ${b.end}: $${(a.amountCents / 100).toFixed(2)}` : '';
      })
      .filter(Boolean)
      .join('; ');
    const row = rs.addRow({
      date: d(r.date),
      from: r.sender ?? r.description ?? '',
      method: r.method,
      amount: dollars(r.amountCents),
      unallocated: dollars(r.unallocatedCents),
      applied,
      status: { active: 'Reimbursement', income: 'Payment for services', ignored: 'Not a reimbursement' }[r.status] ?? r.status,
    });
    row.getCell('date').numFmt = 'mm/dd/yyyy';
    row.getCell('amount').numFmt = MONEY;
    row.getCell('unallocated').numFmt = MONEY;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
