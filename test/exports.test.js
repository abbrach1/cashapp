import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { UnitOfWork, emptySnapshot } from '../src/store/model.js';
import { seedDemo } from '../src/demo/seed.js';
import { buildLedger } from '../src/core/ledger.js';
import { billReport } from '../src/exports/report.js';
import { companyCSV, ledgerCSV, trackingCSV } from '../src/exports/csv.js';
import { companyXLSX, ledgerXLSX, trackingXLSX } from '../src/exports/xlsx.js';
import { companyPDF, winAnsi } from '../src/exports/pdf.js';
import { parseCSV } from '../src/lib/csv.js';

const today = '2026-09-30';
const uow = new UnitOfWork(emptySnapshot());
seedDemo(uow, { today });
const snapshot = uow.view;
const ledger = buildLedger(snapshot, { today });
const ready = [...ledger.bills.values()].find((b) => b.status === 'ready');
const report = billReport(snapshot, ledger, ready.id);

test('the demo has one bill of every interesting kind', () => {
  const statuses = new Set([...ledger.bills.values()].map((b) => b.status));
  for (const s of ['open', 'unpaid', 'ready', 'submitted', 'partial', 'reimbursed']) assert.ok(statuses.has(s), s);
  assert.equal(ledger.dashboard.unmatchedCount, 1);
});

test('report model separates claimed and excluded lines', () => {
  assert.equal(report.claimed.length + report.excluded.length, report.lines.length);
  assert.equal(report.claimed.reduce((s, l) => s + l.claimCents, 0), report.totals.claimCents);
  assert.ok(report.excluded.every((l) => l.claimCents === 0));
  assert.ok(report.lines.every((l) => l.kind !== 'payment'));
  assert.match(report.filenameBase, /^Expenses_Sapphire-Preferred-4821_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}$/);
});

test('company CSV lists claimed items and the total', () => {
  const csv = companyCSV(report);
  assert.ok(csv.startsWith('﻿'));
  const rows = parseCSV(csv);
  assert.deepEqual(rows[0].slice(0, 3), ['Date', 'Merchant', 'Description']);
  const total = rows.find((r) => r[4] === 'Total reimbursement requested');
  assert.equal(total[6], (report.totals.claimCents / 100).toFixed(2));
  assert.equal(rows.filter((r) => r[7] === 'Claimed' || r[7] === 'Partly claimed').length, report.claimed.length);
  const withPersonal = parseCSV(companyCSV(report, { includeExcluded: true }));
  assert.equal(withPersonal.filter((r) => r[7] === 'Not claimed (personal)').length, report.excluded.length);
});

test('tracking and ledger CSVs', () => {
  const rows = parseCSV(trackingCSV(report));
  assert.equal(rows.length, report.lines.length + 1);
  const ledgerRows = parseCSV(ledgerCSV(snapshot, ledger));
  assert.equal(ledgerRows.length, [...ledger.bills.values()].filter((b) => b.visible).length + 1);
});

async function xlsxSheet(buffer, sheetIndex = 1) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.worksheets[sheetIndex - 1];
}

test('company workbook has a SUM formula with the right cached total', async () => {
  const buf = await companyXLSX(report);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const ws = await xlsxSheet(buf);
  const last = ws.getRow(ws.rowCount);
  const cell = last.getCell(7).value;
  assert.match(cell.formula, /^SUM\(G\d+:G\d+\)$/);
  assert.equal(Math.round(cell.result * 100), report.totals.claimCents);
});

test('tracking and ledger workbooks', async () => {
  const tracking = await xlsxSheet(await trackingXLSX(report), 2);
  assert.equal(tracking.rowCount, report.lines.length + 1);
  const buf = await ledgerXLSX(snapshot, ledger);
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Bills', 'Transactions', 'Reimbursements']);
});

function pdfPageCount(buf) {
  // Page objects may live in compressed object streams; count both forms.
  const text = buf.toString('latin1');
  let count = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  if (!count) {
    for (const m of text.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
      try {
        count += (inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
      } catch {}
    }
  }
  return count;
}

test('company PDF renders on one page for a normal statement', async () => {
  const pdf = await companyPDF(report);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pdfPageCount(pdf), 1);
  const withPersonal = await companyPDF(report, { includeExcluded: true });
  assert.ok(pdfPageCount(withPersonal) >= 1);
});

test('PDF handles long statements and odd characters', async () => {
  const many = { ...report, claimed: Array.from({ length: 80 }, (_, i) => ({ ...report.claimed[i % report.claimed.length], merchant: `Café ☕ #${i} 東京` })) };
  const pdf = await companyPDF(many);
  assert.ok(pdfPageCount(pdf) >= 3);
  assert.equal(winAnsi('Café ☕ – “ok” 東'), 'Café ? – “ok” ?');
});
