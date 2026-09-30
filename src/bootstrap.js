// Builds the app from environment variables. Used by the Vercel function
// (api/index.js) and by the local server (scripts/dev.js).

import { loadConfig } from './config.js';
import { createApp } from './httpApp.js';
import { MemoryStore } from './store/memory.js';
import { createPlaidClient } from './providers/plaid.js';
import { UserError } from './core/errors.js';

/**
 * Create the real store on first use. A broken Firebase key then fails only
 * the requests that need data (with a clear message) while the setup screen
 * (/api/config) keeps working.
 */
function lazyStore(factory) {
  let instance;
  let failure;
  const get = () => {
    if (instance) return instance;
    if (failure) throw failure;
    try {
      instance = factory();
      return instance;
    } catch (err) {
      failure = new UserError(`Server configuration: ${err.message}`, 500);
      throw failure;
    }
  };
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const target = get();
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
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
    const { firestore } = await import('./firebase.js');
    const { FirestoreStore } = await import('./store/firestore.js');
    store = lazyStore(() => new FirestoreStore(firestore(config)));
  }
  if (!config.authDisabled) {
    const { firebaseAuth } = await import('./firebase.js');
    verifyToken = (token) => firebaseAuth(config).verifyIdToken(token);
  }
  let plaidClient;
  const plaid = async () => (plaidClient ??= await createPlaidClient(config));
  return { app: createApp({ config, store, plaid, verifyToken, serveStatic }), config, store };
}
