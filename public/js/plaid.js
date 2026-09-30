// Plaid Link: the window where you log in to Chase. The script must be loaded
// from Plaid's own CDN.

import { post } from './api.js';

const PLAID_SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
const STORAGE_KEY = 'plaid-link-pending';
let loading;

function loadPlaid() {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PLAID_SRC;
    s.async = true;
    s.onload = () => resolve(window.Plaid);
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load Plaid Link. Check your connection or ad blocker.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

function runLink(Plaid, options) {
  return new Promise((resolve, reject) => {
    const handler = Plaid.create({
      ...options,
      onSuccess: (publicToken, metadata) => resolve({ publicToken, metadata }),
      onExit: (err) => {
        handler.destroy?.();
        if (err) reject(new Error(err.display_message || err.error_message || 'The bank connection was not completed'));
        else resolve(null);
      },
    });
    handler.open();
  });
}

/**
 * Open Plaid Link. With a connectionId it re-authenticates that connection.
 * Resolves to { publicToken, metadata } or null when the user closes it.
 */
export async function openPlaidLink({ connectionId = null } = {}) {
  const [{ linkToken }, Plaid] = await Promise.all([post('/plaid/link-token', { connectionId }), loadPlaid()]);
  // Remembered for banks that send you back to this page (OAuth on mobile).
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ linkToken, connectionId }));
  try {
    return await runLink(Plaid, { token: linkToken });
  } finally {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

/** After Chase's OAuth page redirects back here, finish the Link flow. */
export async function resumePlaidOAuth() {
  const params = new URLSearchParams(location.search);
  if (!params.has('oauth_state_id')) return null;
  const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
  const receivedRedirectUri = location.href;
  history.replaceState(null, '', location.pathname + location.hash);
  if (!saved?.linkToken) return null;
  const Plaid = await loadPlaid();
  try {
    const result = await runLink(Plaid, { token: saved.linkToken, receivedRedirectUri });
    return result ? { ...result, connectionId: saved.connectionId } : null;
  } finally {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}
