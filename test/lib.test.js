import test from 'node:test';
import assert from 'node:assert/strict';
import { centsToDecimal, formatMoney, parseMoney } from '../src/lib/money.js';
import {
  addDays,
  dateInZone,
  daysInMonth,
  diffDays,
  epochToISODate,
  formatPeriod,
  isISODate,
  parseFlexibleDate,
} from '../src/lib/dates.js';
import { csvCell, parseCSV, toCSV } from '../src/lib/csv.js';
import { openJSON, sealJSON } from '../src/lib/crypto.js';
import { hashId, newId } from '../src/lib/ids.js';

test('parseMoney handles bank and user formats', () => {
  assert.equal(parseMoney('12.34'), 1234);
  assert.equal(parseMoney('-12.34'), -1234);
  assert.equal(parseMoney('$1,234.5'), 123450);
  assert.equal(parseMoney('(45.00)'), -4500);
  assert.equal(parseMoney('-$7'), -700);
  assert.equal(parseMoney('$-7'), -700);
  assert.equal(parseMoney('+3'), 300);
  assert.equal(parseMoney('.5'), 50);
  assert.equal(parseMoney('1.005'), 101);
  assert.equal(parseMoney('0.1'), 10);
  assert.equal(parseMoney(19.99), 1999);
  assert.equal(parseMoney(0.1 + 0.2), 30);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('1.2.3'), null);
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney(Number.NaN), null);
});

test('formatMoney and centsToDecimal', () => {
  assert.equal(formatMoney(123456), '$1,234.56');
  assert.equal(formatMoney(-5), '-$0.05');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(centsToDecimal(-120000), '-1200.00');
  assert.equal(centsToDecimal(7), '0.07');
});

test('date arithmetic is calendar based', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09'); // DST change in the US
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(diffDays('2026-09-14', '2026-10-14'), 30);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(isISODate('2026-02-30'), false);
  assert.equal(isISODate('2026-12-31'), true);
  assert.equal(parseFlexibleDate('09/14/2026'), '2026-09-14');
  assert.equal(parseFlexibleDate('9/4/26'), '2026-09-04');
  assert.equal(parseFlexibleDate('13/40/2026'), null);
  assert.equal(formatPeriod('2026-08-15', '2026-09-14'), 'Aug 15 – Sep 14, 2026');
  assert.equal(formatPeriod('2025-12-15', '2026-01-14'), 'Dec 15, 2025 – Jan 14, 2026');
});

test('time zone conversion uses the bank calendar day', () => {
  // 2026-09-15 02:00 UTC is still Sept 14 in New York.
  const instant = new Date('2026-09-15T02:00:00Z');
  assert.equal(dateInZone(instant, 'America/New_York'), '2026-09-14');
  assert.equal(dateInZone(instant, 'UTC'), '2026-09-15');
  assert.equal(epochToISODate(instant.getTime() / 1000), '2026-09-14');
});

test('parseCSV handles quotes, CRLF, BOM and trailing commas', () => {
  const text = '﻿A,B,C\r\n"x, y","say ""hi""",3,\r\n\r\nlast,,\n';
  assert.deepEqual(parseCSV(text), [
    ['A', 'B', 'C'],
    ['x, y', 'say "hi"', '3', ''],
    ['last', '', ''],
  ]);
  assert.deepEqual(parseCSV('a,"multi\nline"\n'), [['a', 'multi\nline']]);
});

test('toCSV escapes and neutralises spreadsheet formulas', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('-12.50'), '-12.50');
  assert.equal(csvCell('-Uber'), "'-Uber");
  assert.equal(csvCell(null), '');
  assert.equal(toCSV([['a', 'b,c'], [1, 2]]), 'a,"b,c"\r\n1,2\r\n');
});

test('sealJSON encrypts and round-trips', () => {
  const sealed = sealJSON({ accessToken: 'access-sandbox-123' }, 'k'.repeat(40));
  assert.match(sealed, /^v1:/);
  assert.ok(!sealed.includes('access-sandbox'));
  assert.deepEqual(openJSON(sealed, 'k'.repeat(40)), { accessToken: 'access-sandbox-123' });
  assert.throws(() => openJSON(sealed, 'wrong-key'), /TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => openJSON(sealed, undefined), /not set/);
  assert.deepEqual(openJSON(sealJSON({ a: 1 }, undefined), undefined), { a: 1 });
});

test('ids are firestore-safe', () => {
  assert.match(newId('b'), /^b_[0-9a-z]{12}$/);
  assert.equal(hashId('t', 'plaid', 'x'), hashId('t', 'plaid', 'x'));
  assert.notEqual(hashId('t', 'plaid', 'x'), hashId('t', 'plaidx', ''));
  assert.match(hashId('t', 'a'), /^t_[0-9a-f]{24}$/);
});
