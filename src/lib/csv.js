// Minimal RFC 4180 CSV reader/writer.

/**
 * Parse CSV text into rows of string cells. Handles quoted fields, escaped
 * quotes, CRLF/LF line endings and a UTF-8 BOM. Blank lines are skipped.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const pushRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      i++;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\r') {
      pushRow();
      i += s[i + 1] === '\n' ? 2 : 1;
    } else if (c === '\n') {
      pushRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== '' || row.length) pushRow();
  return rows;
}

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/**
 * Escape one cell. Text that a spreadsheet would treat as a formula
 * (=, +, -, @ prefixes) is prefixed with an apostrophe.
 * @param {unknown} value
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && !NUMERIC_RE.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {unknown[][]} rows
 * @param {{ bom?: boolean }} [opts] bom: prefix a UTF-8 byte order mark so
 *   Excel shows non-ASCII characters (•, –, é) correctly.
 */
export function toCSV(rows, { bom = false } = {}) {
  return (bom ? '\ufeff' : '') + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
