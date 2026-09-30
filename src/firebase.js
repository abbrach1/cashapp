import { cert, getApps, initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

let app;

/** @param {import('./config.js').Config} config */
export function firebaseApp(config) {
  if (app) return app;
  if (getApps().length) {
    app = getApps()[0];
    return app;
  }
  const { projectId, serviceAccount, serviceAccountError, clientEmail, privateKey } = config.firebase;
  if (serviceAccountError) throw new Error(serviceAccountError);
  let credential;
  if (serviceAccount) credential = cert(serviceAccount);
  else if (clientEmail && privateKey) {
    credential = cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') });
  } else if (!process.env.FIRESTORE_EMULATOR_HOST) {
    credential = applicationDefault();
  }
  app = initializeApp({ ...(credential ? { credential } : {}), projectId: projectId ?? serviceAccount?.project_id });
  return app;
}

let db;

/** @param {import('./config.js').Config} config */
export function firestore(config) {
  if (db) return db;
  db = getFirestore(firebaseApp(config));
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

/** @param {import('./config.js').Config} config */
export function firebaseAuth(config) {
  return getAuth(firebaseApp(config));
}
