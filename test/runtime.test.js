// Some Node.js runtimes (including Vercel's) cannot require() ES modules.
// Load the server the way Vercel does, with that feature switched off, so a
// dependency that relies on it fails here instead of in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the API loads without require() of ES modules', () => {
  const script = `
    const m = await import('./api/index.js');
    await import('firebase-admin/auth');
    await import('firebase-admin/firestore');
    await import('./src/firebase.js');
    await import('./src/store/firestore.js');
    await import('./src/exports/pdf.js');
    await import('./src/exports/xlsx.js');
    await import('plaid');
    await import('exceljs');
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, end(b) { this.body = String(b); } };
    await new Promise((resolve) => { res.end = (b) => { res.body = String(b); resolve(); }; m.default({ url: '/api/health', method: 'GET', headers: {} }, res); });
    if (!res.body.includes('"ok":true')) throw new Error('health check failed: ' + res.body);
  `;
  const out = execFileSync(process.execPath, ['--no-experimental-require-module', '--input-type=module', '-e', script], {
    cwd: root,
    env: { ...process.env, STORE: 'firestore', FIREBASE_PROJECT_ID: 'demo-test', ALLOWED_EMAILS: 'a@b.c', NODE_OPTIONS: '' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(out, '');
});
