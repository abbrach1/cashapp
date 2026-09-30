// Builds the app from environment variables. Used by the Vercel function
// (api/index.js) and by the local server (scripts/dev.js).

import { loadConfig } from './config.js';
import { createApp } from './httpApp.js';
import { MemoryStore } from './store/memory.js';
import { createPlaidClient } from './providers/plaid.js';
import { UserError } from './core/errors.js';

/**
 * Create the real store on first use. If Firebase cannot load or the key is
 * broken, only requests that need data fail (with a clear message) while the
 * setup screen (/api/config) keeps working.
 * @param {() => Promise<any>} factory
 */
function lazyStore(factory) {
  let pending;
  const get = () =>
    (pending ??= factory().catch((err) => {
      throw new UserError(`Server configuration: ${err.message}`, 500);
    }));
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined; // not a promise itself
        return async (...args) => {
          const store = await get();
          return store[prop](...args);
        };
      },
    },
  );
}

/** @param {{ env?: NodeJS.ProcessEnv, serveStatic?: boolean }} [opts] */
export async function buildApp({ env = process.env, serveStatic = false } = {}) {
  const config = loadConfig(env);
  let store;
  let verifyToken;
  if (config.store === 'memory') {
    store = new MemoryStore();
  } else {
    store = lazyStore(async () => {
      const { firestore } = await import('./firebase.js');
      const { FirestoreStore } = await import('./store/firestore.js');
      return new FirestoreStore(firestore(config));
    });
  }
  if (!config.authDisabled) {
    verifyToken = async (token) => {
      const { firebaseAuth } = await import('./firebase.js');
      return firebaseAuth(config).verifyIdToken(token);
    };
  }
  let plaidClient;
  const plaid = async () => (plaidClient ??= await createPlaidClient(config));
  return { app: createApp({ config, store, plaid, verifyToken, serveStatic }), config, store };
}
