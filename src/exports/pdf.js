// Printable expense report for the company (US Letter).

import { formatDateLong, formatDateUS } from '../lib/dates.js';
import { formatMoney } from '../lib/money.js';

let PDFDocument;
async function loadPdf() {
  PDFDocument ??= (await import('pdfkit')).default;
  return PDFDocument;
}

const PAGE = { width: 612, height: 792, margin: 48 };
const CONTENT_W = PAGE.width - PAGE.margin * 2;
const COLORS = { text: '#111827', muted: '#6B7280', rule: '#E5E7EB', stripe: '#F9FAFB', head: '#1F2937', accent: '#0F766E' };
const COLS = [
  { key: 'date', label: 'Date', width: 58 },
  { key: 'merchant', label: 'Merchant / description', width: 186 },
  { key: 'category', label: 'Category', width: 82 },
  { key: 'purpose', label: 'Business purpose', width: 114 },
  { key: 'amount', label: 'Amount', width: CONTENT_W - 58 - 186 - 82 - 114, align: 'right' },
];

// The built-in PDF fonts only cover Windows-1252. Replace anything else so
// merchant names with emoji or other scripts cannot break the file.
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
export function winAnsi(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0);
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (ch === '\n') out += ch;
    else if (/\s/.test(ch)) out += ' ';
    else out += '?';
  }
  return out;
}

/**
 * @param {ReturnType<import('./report.js').billReport>} r
 * @param {{ includeExcluded?: boolean }} opts
 * @returns {Promise<Buffer>}
 */
export async function companyPDF(r, { includeExcluded = false } = {}) {
  const PDF = await loadPdf();
  const doc = new PDF({
    size: 'LETTER',
    margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
    bufferPages: true,
    info: {
      Title: winAnsi(`${r.title} – ${r.account.label} – ${r.bill.period}`),
      Author: winAnsi(r.employee.name || ''),
      Subject: 'Expense reimbursement',
    },
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });

  const left = PAGE.margin;
  const bottom = PAGE.height - PAGE.margin - 24;
  const t = (s) => winAnsi(s);

  // ---- header ----
  doc.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(18).text(t(r.title), left, PAGE.margin, { width: CONTENT_W - 170 });
  let y = doc.y + 3;
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted).text(t(`Report date: ${formatDateLong(r.generatedOn)}`), left, PAGE.margin + 4, {
    width: CONTENT_W,
    align: 'right',
  });
  if (r.company.name) {
    doc.font('Helvetica').fontSize(12).fillColor(COLORS.text).text(t(r.company.name), left, y);
    y = doc.y;
  }
  y += 12;

  // Summary box on the right, details on the left.
  const boxW = 170;
  const boxX = left + CONTENT_W - boxW;
  const details = [
    ['Submitted by', r.employee.name ? (r.employee.email ? `${r.employee.name} (${r.employee.email})` : r.employee.name) : null],
    ['Card', r.account.institution ? `${r.account.institution} ${r.account.label}` : r.account.label],
    ['Statement period', r.bill.period],
    ['Statement paid on', r.bill.paidOn ? formatDateLong(r.bill.paidOn) : null],
    ['Reimburse via Zelle', r.zelleHandle || null],
  ].filter(([, v]) => v);
  const detailsTop = y;
  for (const [label, value] of details) {
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted).text(t(label.toUpperCase()), left, y, { width: 110, characterSpacing: 0.4 });
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.text).text(t(value), left + 112, y - 1, { width: CONTENT_W - boxW - 130 });
    y = Math.max(doc.y, y + 12) + 5;
  }
  const boxH = 64;
  doc.roundedRect(boxX, detailsTop, boxW, boxH, 6).fillAndStroke('#F0FDFA', '#99F6E4');
  doc.fillColor(COLORS.accent).font('Helvetica').fontSize(8).text('TOTAL REQUESTED', boxX + 12, detailsTop + 10, { width: boxW - 24, characterSpacing: 0.4 });
  doc.font('Helvetica-Bold').fontSize(20).text(t(formatMoney(r.totals.claimCents)), boxX + 12, detailsTop + 22, { width: boxW - 24 });
  doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted).text(`${r.totals.claimedCount} item${r.totals.claimedCount === 1 ? '' : 's'}`, boxX + 12, detailsTop + 46, {
    width: boxW - 24,
  });
  y = Math.max(y, detailsTop + boxH) + 18;

  // ---- tables ----
  const drawHeader = () => {
    doc.rect(left, y, CONTENT_W, 18).fill(COLORS.head);
    let x = left;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF');
    for (const c of COLS) {
      doc.text(c.label.toUpperCase(), x + 6, y + 5, { width: c.width - 12, align: c.align ?? 'left', characterSpacing: 0.3 });
      x += c.width;
    }
    y += 18;
  };

  const cellText = (l, muted) => {
    const purpose = [l.note];
    if (l.status === 'partial') purpose.push(`Claiming ${formatMoney(l.claimCents)} of ${formatMoney(l.amountCents)}`);
    if (muted) purpose.push('Not claimed (personal)');
    return {
      date: formatDateUS(l.date),
      merchant: l.merchant,
      sub: l.description && l.description.toLowerCase() !== String(l.merchant).toLowerCase() ? l.description : '',
      category: l.category || l.kindLabel,
      purpose: purpose.filter(Boolean).join('\n'),
      amount: formatMoney(muted ? l.amountCents : l.claimCents),
    };
  };

  const rowHeight = (cells) => {
    doc.font('Helvetica-Bold').fontSize(9);
    let h = doc.heightOfString(t(cells.merchant), { width: COLS[1].width - 12 });
    if (cells.sub) {
      doc.font('Helvetica').fontSize(7.5);
      h += doc.heightOfString(t(cells.sub), { width: COLS[1].width - 12 }) + 1;
    }
    doc.font('Helvetica').fontSize(8.5);
    h = Math.max(h, doc.heightOfString(t(cells.purpose || ' '), { width: COLS[3].width - 12 }));
    h = Math.max(h, doc.heightOfString(t(cells.category || ' '), { width: COLS[2].width - 12 }));
    return h + 8;
  };

  const drawRows = (lines, { muted = false } = {}) => {
    lines.forEach((l, i) => {
      const cells = cellText(l, muted);
      const h = rowHeight(cells);
      if (y + h > bottom) {
        doc.addPage();
        y = PAGE.margin;
        drawHeader();
      }
      if (i % 2 === 1) doc.rect(left, y, CONTENT_W, h).fill(COLORS.stripe);
      const color = muted ? COLORS.muted : COLORS.text;
      let x = left;
      doc.font('Helvetica').fontSize(8.5).fillColor(color).text(t(cells.date), x + 6, y + 4, { width: COLS[0].width - 12 });
      x += COLS[0].width;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(color).text(t(cells.merchant), x + 6, y + 4, { width: COLS[1].width - 12 });
      if (cells.sub) doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.muted).text(t(cells.sub), x + 6, doc.y + 1, { width: COLS[1].width - 12 });
      x += COLS[1].width;
      doc.font('Helvetica').fontSize(8.5).fillColor(color).text(t(cells.category), x + 6, y + 4, { width: COLS[2].width - 12 });
      x += COLS[2].width;
      doc.text(t(cells.purpose), x + 6, y + 4, { width: COLS[3].width - 12 });
      x += COLS[3].width;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(muted ? COLORS.muted : l.claimCents < 0 ? COLORS.accent : COLORS.text);
      doc.text(t(cells.amount), x + 6, y + 4, { width: COLS[4].width - 12, align: 'right' });
      y += h;
      doc.moveTo(left, y).lineTo(left + CONTENT_W, y).lineWidth(0.5).strokeColor(COLORS.rule).stroke();
    });
  };

  drawHeader();
  if (r.claimed.length) drawRows(r.claimed);
  else {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted).text('No reimbursable transactions on this statement.', left + 6, y + 8);
    y += 26;
  }

  // Total line.
  if (y + 30 > bottom) {
    doc.addPage();
    y = PAGE.margin;
  }
  y += 8;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.text);
  doc.text('Total reimbursement requested', left, y, { width: CONTENT_W - COLS[4].width - 6, align: 'right' });
  doc.text(t(formatMoney(r.totals.claimCents)), left + CONTENT_W - COLS[4].width, y, { width: COLS[4].width - 6, align: 'right' });
  y = doc.y + 4;
  doc.moveTo(left + CONTENT_W - COLS[4].width, y).lineTo(left + CONTENT_W, y).lineWidth(1).strokeColor(COLORS.text).stroke();
  y += 16;

  if (includeExcluded && r.excluded.length) {
    if (y + 60 > bottom) {
      doc.addPage();
      y = PAGE.margin;
    }
    doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.text).text('Not claimed (personal)', left, y);
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.muted).text('Shown for completeness; these charges are not part of the request.', left, doc.y + 2);
    y = doc.y + 8;
    drawHeader();
    drawRows(r.excluded, { muted: true });
    y += 10;
  }

  // ---- footer on every page ----
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // Writing inside the bottom margin would make pdfkit start a new page.
    doc.page.margins.bottom = 0;
    const fy = PAGE.height - PAGE.margin + 10;
    doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.muted);
    doc.text(t(`${r.account.label} · ${r.bill.period}`), left, fy, { width: CONTENT_W / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, left + CONTENT_W / 2, fy, { width: CONTENT_W / 2, align: 'right', lineBreak: false });
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
