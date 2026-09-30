// All configuration comes from environment variables (see .env.example).

const list = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** @param {NodeJS.ProcessEnv} [env] */
export function loadConfig(env = process.env) {
  const onVercel = Boolean(env.VERCEL);
  const demo = env.DEMO === '1' || env.DEMO === 'true';
  const store = env.STORE || (demo ? 'memory' : 'firestore');
  const authDisabled = !onVercel && (demo || env.AUTH_DISABLED === '1' || env.AUTH_DISABLED === 'true');
  const plaidEnv = env.PLAID_ENV || 'sandbox';
  if (!['sandbox', 'production'].includes(plaidEnv)) throw new Error('PLAID_ENV must be sandbox or production');
  const firebaseProjectId =
    env.FIREBASE_PROJECT_ID || env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || null;
  return {
    appName: env.APP_NAME || 'Reimbursement Tracker',
    onVercel,
    demo,
    store,
    authDisabled,
    localUserId: env.LOCAL_USER_ID || (demo ? 'demo' : 'local'),
    allowedEmails: list(env.ALLOWED_EMAILS).map((e) => e.toLowerCase()),
    allowedHosts: list(env.ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    timezone: env.BANK_TIMEZONE || 'America/New_York',
    tokenKey: env.TOKEN_ENCRYPTION_KEY || null,
    cronSecret: env.CRON_SECRET || null,
    firebase: {
      projectId: firebaseProjectId,
      serviceAccount: env.FIREBASE_SERVICE_ACCOUNT || null,
      clientEmail: env.FIREBASE_CLIENT_EMAIL || null,
      privateKey: env.FIREBASE_PRIVATE_KEY || null,
      web: {
        apiKey: env.FIREBASE_WEB_API_KEY || null,
        authDomain: env.FIREBASE_AUTH_DOMAIN || (firebaseProjectId ? `${firebaseProjectId}.firebaseapp.com` : null),
        projectId: firebaseProjectId,
        appId: env.FIREBASE_APP_ID || null,
      },
      authEmulatorHost: env.FIREBASE_AUTH_EMULATOR_HOST || null,
    },
    plaid: {
      clientId: env.PLAID_CLIENT_ID || null,
      secret: env.PLAID_SECRET || null,
      env: plaidEnv,
      redirectUri: env.PLAID_REDIRECT_URI || null,
      daysRequested: Math.min(730, Math.max(30, Number(env.PLAID_DAYS_REQUESTED) || 365)),
    },
  };
}

/** @typedef {ReturnType<typeof loadConfig>} Config */

/** Problems that would make a deployment unsafe or broken. */
export function configProblems(config) {
  const problems = [];
  if (!config.authDisabled && !config.allowedEmails.length) {
    problems.push('ALLOWED_EMAILS is empty: nobody can sign in. Set it to your Google account email.');
  }
  if (!config.authDisabled && !config.firebase.web.apiKey) {
    problems.push('FIREBASE_WEB_API_KEY is not set, so the sign-in page cannot load.');
  }
  const hasKey = config.firebase.serviceAccount || (config.firebase.clientEmail && config.firebase.privateKey);
  if (config.store === 'firestore' && config.onVercel && !hasKey) {
    problems.push('FIREBASE_SERVICE_ACCOUNT is not set, so the app cannot reach Firestore.');
  } else if (config.store === 'firestore' && !config.firebase.projectId && !hasKey) {
    problems.push('Firestore is not configured: set FIREBASE_SERVICE_ACCOUNT (or FIREBASE_PROJECT_ID for the emulator).');
  }
  if (config.onVercel && !config.cronSecret) {
    problems.push('CRON_SECRET is not set, so the daily bank sync cannot run.');
  }
  if (config.store === 'firestore' && !config.tokenKey) {
    problems.push('TOKEN_ENCRYPTION_KEY is not set: bank access tokens would be stored unencrypted.');
  }
  return problems;
}
