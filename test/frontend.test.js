// The browser code has no build step, so at least make sure every module
// parses and exports what the app shell imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js');

function modules(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? modules(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}

test('every browser module loads', async () => {
  const files = modules(root).filter((f) => !f.endsWith('main.js')); // main.js starts the app
  assert.ok(files.length > 10);
  for (const file of files) {
    await assert.doesNotReject(import(file), file);
  }
});

test('pages export their components', async () => {
  const expected = {
    'pages/overview.js': 'OverviewPage',
    'pages/bills.js': 'BillsPage',
    'pages/bill.js': 'BillPage',
    'pages/reimbursements.js': 'ReimbursementsPage',
    'pages/transactions.js': 'TransactionsPage',
    'pages/classify.js': 'ClassifyPage',
    'pages/accounts.js': 'AccountsPage',
    'pages/settings.js': 'SettingsPage',
  };
  for (const [file, name] of Object.entries(expected)) {
    const mod = await import(path.join(root, file));
    assert.equal(typeof mod[name], 'function', `${file} exports ${name}`);
  }
});

test('client money helpers agree with the server', async () => {
  const client = await import(path.join(root, 'format.js'));
  const { parseMoney, formatMoney } = await import('../src/lib/money.js');
  for (const v of ['12.34', '-0.5', '1,234.56', '0.005', '100']) assert.equal(client.parseCents(v), parseMoney(v), v);
  for (const c of [0, 5, -5, 123456, -99999]) assert.equal(client.money(c), formatMoney(c));
});
