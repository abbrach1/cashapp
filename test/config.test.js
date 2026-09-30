import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cleanEnv, configProblems, envChecklist, loadConfig, parseServiceAccount, parseWebConfig } from '../src/config.js';
import { buildApp } from '../src/bootstrap.js';

const SA = {
  type: 'service_account',
  project_id: 'my-reimbursements',
  private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  client_email: 'firebase-adminsdk@my-reimbursements.iam.gserviceaccount.com',
};

test('values pasted with quotes or spaces are cleaned', () => {
  assert.equal(cleanEnv('  "abc"  '), 'abc');
  assert.equal(cleanEnv("'abc'"), 'abc');
  assert.equal(cleanEnv('   '), null);
  assert.equal(cleanEnv(undefined), null);
  const c = loadConfig({ ALLOWED_EMAILS: ' "Me@Gmail.com; other@x.com  third@y.com" ', PLAID_ENV: ' Production ' });
  assert.deepEqual(c.allowedEmails, ['me@gmail.com', 'other@x.com', 'third@y.com']);
  assert.equal(c.plaid.env, 'production');
  assert.equal(c.plaid.envError, null);
});

test('Plaid defaults to production; a wrong PLAID_ENV is reported instead of crashing', () => {
  assert.equal(loadConfig({}).plaid.env, 'production');
  assert.equal(loadConfig({ PLAID_ENV: 'Sandbox' }).plaid.env, 'sandbox');
  const c = loadConfig({ PLAID_ENV: 'development' });
  assert.equal(c.plaid.env, 'production');
  assert.match(configProblems(c).join('\n'), /PLAID_ENV is "development"/);
});

test('service account: JSON or base64; invalid values become a readable problem', () => {
  assert.equal(parseServiceAccount(JSON.stringify(SA)).json.project_id, 'my-reimbursements');
  assert.equal(parseServiceAccount(Buffer.from(JSON.stringify(SA)).toString('base64')).json.client_email, SA.client_email);
  assert.match(parseServiceAccount('{not json').error, /not valid/);
  assert.match(parseServiceAccount(JSON.stringify({ project_id: 'x' })).error, /missing client_email/);
  const c = loadConfig({ FIREBASE_SERVICE_ACCOUNT: 'garbage', VERCEL: '1' });
  assert.match(configProblems(c).join('\n'), /FIREBASE_SERVICE_ACCOUNT is not valid/);
});

test('project id and auth domain come from the service account when not set', () => {
  const c = loadConfig({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SA), FIREBASE_WEB_API_KEY: 'AIzaX' });
  assert.equal(c.firebase.projectId, 'my-reimbursements');
  assert.equal(c.firebase.web.projectId, 'my-reimbursements');
  assert.equal(c.firebase.web.authDomain, 'my-reimbursements.firebaseapp.com');
});

test('FIREBASE_WEB_CONFIG accepts the snippet copied from the Firebase console', () => {
  const snippet = `const firebaseConfig = {
    apiKey: "AIzaSyExample",
    authDomain: "my-reimbursements.firebaseapp.com",
    projectId: "my-reimbursements",
    storageBucket: "my-reimbursements.firebasestorage.app",
    messagingSenderId: "1234",
    appId: "1:1234:web:abcd"
  };`;
  assert.equal(parseWebConfig(snippet).appId, '1:1234:web:abcd');
  assert.equal(parseWebConfig(JSON.stringify({ apiKey: 'k', projectId: 'p' })).projectId, 'p');
  const c = loadConfig({ FIREBASE_WEB_CONFIG: snippet });
  assert.deepEqual(c.firebase.web, {
    apiKey: 'AIzaSyExample',
    authDomain: 'my-reimbursements.firebaseapp.com',
    projectId: 'my-reimbursements',
    appId: '1:1234:web:abcd',
  });
  assert.equal(c.firebase.projectId, 'my-reimbursements');
  // Individual variables still win.
  assert.equal(loadConfig({ FIREBASE_WEB_CONFIG: snippet, FIREBASE_WEB_API_KEY: 'override' }).firebase.web.apiKey, 'override');
});

test('web config and service account from different projects are flagged', () => {
  const c = loadConfig({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SA), FIREBASE_WEB_CONFIG: '{"apiKey":"k","projectId":"another-project"}' });
  assert.match(configProblems(c).join('\n'), /"another-project" but the service account is for "my-reimbursements"/);
});

test('preview deployments explain Production-only variables', () => {
  const c = loadConfig({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_COMMIT_SHA: 'f18c2a00de99' });
  assert.deepEqual(c.deployment, { vercelEnv: 'preview', branch: 'main', commit: 'f18c2a0', node: process.version });
  assert.match(configProblems(c).at(-1), /Preview deployment \(branch "main"\).*enable them for Preview too/);
  const ok = loadConfig({
    VERCEL: '1',
    VERCEL_ENV: 'preview',
    ALLOWED_EMAILS: 'me@x.com',
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SA),
    FIREBASE_WEB_API_KEY: 'k',
    TOKEN_ENCRYPTION_KEY: 't',
    CRON_SECRET: 'c',
  });
  assert.deepEqual(configProblems(ok), []);
});

test('the checklist never includes secret values', () => {
  const env = {
    ALLOWED_EMAILS: 'me@x.com',
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SA),
    FIREBASE_WEB_API_KEY: 'AIza-secret-ish',
    TOKEN_ENCRYPTION_KEY: 'super-secret-key',
    CRON_SECRET: 'cron-secret-value',
    PLAID_CLIENT_ID: 'plaid-id-value',
    PLAID_SECRET: 'plaid-secret-value',
    PLAID_ENV: 'production',
  };
  const text = JSON.stringify(envChecklist(loadConfig(env)));
  for (const v of ['AIza-secret-ish', 'super-secret-key', 'cron-secret-value', 'plaid-id-value', 'plaid-secret-value', 'BEGIN PRIVATE KEY', 'me@x.com']) {
    assert.ok(!text.includes(v), `checklist leaks ${v}`);
  }
  assert.ok(envChecklist(loadConfig(env)).every((i) => i.set || !i.required));
});

test('a broken Firebase key keeps the setup screen working', async (t) => {
  const { app } = await buildApp({ env: { STORE: 'firestore', AUTH_DISABLED: '1', FIREBASE_SERVICE_ACCOUNT: '{broken', TOKEN_ENCRYPTION_KEY: 'x' } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.match(cfg.problems.join('\n'), /FIREBASE_SERVICE_ACCOUNT is not valid/);
  assert.ok(cfg.setup.checklist.find((i) => i.name === 'FIREBASE_SERVICE_ACCOUNT').invalid);
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /Server configuration: FIREBASE_SERVICE_ACCOUNT is not valid/);
});
