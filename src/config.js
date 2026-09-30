// All configuration comes from environment variables (see .env.example).
//
// Values are read forgivingly: surrounding whitespace and quotes are removed,
// and small mistakes are reported through configProblems() (shown on the
// sign-in page) instead of crashing the server.

/** Trim a value and drop quotes pasted around it ("abc" or 'abc'). */
export function cleanEnv(value) {
  if (value === undefined || value === null) return null;
  let s = String(value).trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) s = s.slice(1, -1).trim();
  return s || null;
}

const list = (v) =>
  String(v ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * FIREBASE_SERVICE_ACCOUNT: the service-account JSON, or that JSON
 * base64-encoded (easier to paste). Returns { json } or { error }.
 */
export function parseServiceAccount(raw) {
  if (!raw) return { json: null, error: null };
  const trimmed = raw.trim();
  const text = trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
  try {
    const json = JSON.parse(text);
    if (!json.client_email || !json.private_key) {
      return { json: null, error: 'FIREBASE_SERVICE_ACCOUNT is missing client_email/private_key. Use the key file from Project settings → Service accounts → Generate new private key.' };
    }
    return { json, error: null };
  } catch {
    return { json: null, error: 'FIREBASE_SERVICE_ACCOUNT is not valid: paste the whole service-account JSON file, or the output of `base64 -w0 key.json`.' };
  }
}

/**
 * FIREBASE_WEB_CONFIG: the web-app config from the Firebase console, pasted
 * as JSON or exactly as shown there (`const firebaseConfig = { apiKey: "…", … };`).
 */
export function parseWebConfig(raw) {
  if (!raw) return {};
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const body = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  try {
    const json = JSON.parse(body);
    if (json && typeof json === 'object') return json;
  } catch {
    // Not JSON: read `key: "value"` pairs from the JavaScript snippet.
  }
  const out = {};
  for (const m of body.matchAll(/["']?(\w+)["']?\s*:\s*["']([^"']*)["']/g)) out[m[1]] = m[2];
  return out;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function loadConfig(env = process.env) {
  const e = (name) => cleanEnv(env[name]);
  const onVercel = Boolean(env.VERCEL);
  const truthy = (name) => ['1', 'true', 'yes'].includes((e(name) ?? '').toLowerCase());
  const demo = truthy('DEMO');
  const store = e('STORE') || (demo ? 'memory' : 'firestore');
  const authDisabled = !onVercel && (demo || truthy('AUTH_DISABLED'));

  const rawPlaidEnv = (e('PLAID_ENV') ?? 'sandbox').toLowerCase();
  const plaidEnvValid = ['sandbox', 'production'].includes(rawPlaidEnv);

  const sa = parseServiceAccount(e('FIREBASE_SERVICE_ACCOUNT'));
  const webConfig = parseWebConfig(e('FIREBASE_WEB_CONFIG') ?? e('FIREBASE_CONFIG'));
  const projectId =
    e('FIREBASE_PROJECT_ID') ?? cleanEnv(webConfig.projectId) ?? sa.json?.project_id ?? e('GCLOUD_PROJECT') ?? e('GOOGLE_CLOUD_PROJECT');
  const web = {
    apiKey: e('FIREBASE_WEB_API_KEY') ?? e('FIREBASE_API_KEY') ?? cleanEnv(webConfig.apiKey),
    authDomain: e('FIREBASE_AUTH_DOMAIN') ?? cleanEnv(webConfig.authDomain) ?? (projectId ? `${projectId}.firebaseapp.com` : null),
    projectId: cleanEnv(webConfig.projectId) ?? projectId,
    appId: e('FIREBASE_APP_ID') ?? cleanEnv(webConfig.appId),
  };

  return {
    appName: e('APP_NAME') ?? 'Reimbursement Tracker',
    onVercel,
    demo,
    store,
    authDisabled,
    localUserId: e('LOCAL_USER_ID') ?? (demo ? 'demo' : 'local'),
    allowedEmails: list(e('ALLOWED_EMAILS')).map((x) => x.toLowerCase()),
    allowedHosts: list(e('ALLOWED_HOSTS')).map((h) => h.toLowerCase()),
    timezone: e('BANK_TIMEZONE') ?? 'America/New_York',
    tokenKey: e('TOKEN_ENCRYPTION_KEY'),
    cronSecret: e('CRON_SECRET'),
    firebase: {
      projectId,
      serviceAccount: sa.json,
      serviceAccountError: sa.error,
      clientEmail: e('FIREBASE_CLIENT_EMAIL'),
      privateKey: e('FIREBASE_PRIVATE_KEY'),
      web,
      authEmulatorHost: e('FIREBASE_AUTH_EMULATOR_HOST'),
    },
    plaid: {
      clientId: e('PLAID_CLIENT_ID'),
      secret: e('PLAID_SECRET'),
      env: plaidEnvValid ? rawPlaidEnv : 'sandbox',
      envError: plaidEnvValid ? null : rawPlaidEnv,
      redirectUri: e('PLAID_REDIRECT_URI'),
      daysRequested: Math.min(730, Math.max(30, Number(e('PLAID_DAYS_REQUESTED')) || 365)),
    },
    deployment: {
      vercelEnv: e('VERCEL_ENV'),
      branch: e('VERCEL_GIT_COMMIT_REF'),
      commit: e('VERCEL_GIT_COMMIT_SHA')?.slice(0, 7) ?? null,
    },
  };
}

/** @typedef {ReturnType<typeof loadConfig>} Config */

/**
 * Which settings this server can see (names only, never values), for the
 * setup screen.
 * @param {Config} config
 */
export function envChecklist(config) {
  const f = config.firebase;
  const items = [
    { name: 'ALLOWED_EMAILS', set: config.allowedEmails.length > 0, required: !config.authDisabled, detail: config.allowedEmails.length ? `${config.allowedEmails.length} email(s)` : null },
    { name: 'FIREBASE_SERVICE_ACCOUNT', set: Boolean(f.serviceAccount || (f.clientEmail && f.privateKey)), required: config.store === 'firestore' && config.onVercel, invalid: Boolean(f.serviceAccountError) },
    { name: 'FIREBASE_WEB_API_KEY (or FIREBASE_WEB_CONFIG)', set: Boolean(f.web.apiKey), required: !config.authDisabled },
    { name: 'FIREBASE_PROJECT_ID', set: Boolean(f.projectId), required: config.store === 'firestore', detail: f.projectId },
    { name: 'TOKEN_ENCRYPTION_KEY', set: Boolean(config.tokenKey), required: config.store === 'firestore' },
    { name: 'CRON_SECRET', set: Boolean(config.cronSecret), required: config.onVercel },
    { name: 'PLAID_CLIENT_ID + PLAID_SECRET', set: Boolean(config.plaid.clientId && config.plaid.secret), required: false, detail: config.plaid.clientId && config.plaid.secret ? config.plaid.env : 'optional' },
  ];
  return items;
}

/** Problems that would make a deployment unsafe or broken. */
export function configProblems(config) {
  const problems = [];
  const f = config.firebase;
  if (!config.authDisabled && !config.allowedEmails.length) {
    problems.push('ALLOWED_EMAILS is empty: nobody can sign in. Set it to your Google account email.');
  }
  if (!config.authDisabled && !f.web.apiKey) {
    problems.push('FIREBASE_WEB_API_KEY is not set, so the sign-in page cannot load. (You can instead paste the whole web config as FIREBASE_WEB_CONFIG.)');
  }
  if (f.serviceAccountError) problems.push(f.serviceAccountError);
  const hasKey = f.serviceAccount || (f.clientEmail && f.privateKey);
  if (config.store === 'firestore' && config.onVercel && !hasKey && !f.serviceAccountError) {
    problems.push('FIREBASE_SERVICE_ACCOUNT is not set, so the app cannot reach Firestore.');
  } else if (config.store === 'firestore' && !f.projectId && !hasKey) {
    problems.push('Firestore is not configured: set FIREBASE_SERVICE_ACCOUNT (or FIREBASE_PROJECT_ID for the emulator).');
  }
  const saProject = f.serviceAccount?.project_id;
  if (saProject && f.web.projectId && saProject !== f.web.projectId) {
    problems.push(`The Firebase web config is for project "${f.web.projectId}" but the service account is for "${saProject}". Both must come from the same Firebase project.`);
  }
  if (config.plaid.envError) {
    problems.push(`PLAID_ENV is "${config.plaid.envError}", but it must be "production" or "sandbox". Plaid is using sandbox until you fix it.`);
  }
  if (config.onVercel && !config.cronSecret) {
    problems.push('CRON_SECRET is not set, so the daily bank sync cannot run.');
  }
  if (config.store === 'firestore' && !config.tokenKey) {
    problems.push('TOKEN_ENCRYPTION_KEY is not set: bank access tokens would be stored unencrypted.');
  }
  if (problems.length && config.deployment.vercelEnv === 'preview') {
    problems.push(
      `This is a Preview deployment (branch "${config.deployment.branch ?? 'unknown'}"). Variables enabled only for "Production" are not used here: enable them for Preview too, or open the Production deployment.`,
    );
  }
  return problems;
}
