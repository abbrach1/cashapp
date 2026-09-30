import { cert, getApps, initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

/**
 * Parse FIREBASE_SERVICE_ACCOUNT, which may hold the service-account JSON
 * itself or the same JSON base64-encoded (easier to paste into Vercel).
 * @param {string|undefined} raw
 */
export function parseServiceAccount(raw) {
  if (!raw) return null;
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  try {
    const json = JSON.parse(text);
    if (!json.client_email || !json.private_key) throw new Error('missing fields');
    return json;
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT must be the service account JSON (or that JSON base64-encoded)');
  }
}

let app;

/** @param {ReturnType<typeof import('./config.js').loadConfig>} config */
export function firebaseApp(config) {
  if (app) return app;
  if (getApps().length) {
    app = getApps()[0];
    return app;
  }
  const { projectId, serviceAccount, clientEmail, privateKey } = config.firebase;
  const sa = parseServiceAccount(serviceAccount);
  let credential;
  if (sa) credential = cert(sa);
  else if (clientEmail && privateKey) {
    credential = cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') });
  } else if (!process.env.FIRESTORE_EMULATOR_HOST) {
    credential = applicationDefault();
  }
  app = initializeApp({ ...(credential ? { credential } : {}), projectId: projectId ?? sa?.project_id });
  return app;
}

let db;

/** @param {ReturnType<typeof import('./config.js').loadConfig>} config */
export function firestore(config) {
  if (db) return db;
  db = getFirestore(firebaseApp(config));
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

/** @param {ReturnType<typeof import('./config.js').loadConfig>} config */
export function firebaseAuth(config) {
  return getAuth(firebaseApp(config));
}
