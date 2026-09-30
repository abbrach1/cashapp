// Tiny global store: the app state from /api/state plus UI notifications.

import { useEffect, useState } from '../vendor/preact.js';
import { get } from './api.js';

const listeners = new Set();
let current = { state: null, loading: true, error: null, syncing: false, toasts: [], config: null, user: null };

export function getStore() {
  return current;
}

export function setStore(patch) {
  current = { ...current, ...patch };
  for (const l of listeners) l(current);
}

export function useStore() {
  const [value, setValue] = useState(current);
  useEffect(() => {
    listeners.add(setValue);
    setValue(current);
    return () => listeners.delete(setValue);
  }, []);
  return value;
}

/** Replace the app state with a fresh copy from the server (or a response). */
export async function refresh(state) {
  if (state) {
    setStore({ state, loading: false, error: null });
    return state;
  }
  try {
    const fresh = await get('/state');
    setStore({ state: fresh, loading: false, error: null });
    return fresh;
  } catch (err) {
    setStore({ loading: false, error: err.message });
    throw err;
  }
}

let toastId = 0;
export function toast(message, kind = 'info', ms = 3800) {
  const id = ++toastId;
  setStore({ toasts: [...current.toasts, { id, message, kind }] });
  setTimeout(() => setStore({ toasts: current.toasts.filter((t) => t.id !== id) }), ms);
}

/** Run an async action, report errors as toasts, return its result. */
export async function attempt(fn, success) {
  try {
    const result = await fn();
    if (success) toast(typeof success === 'function' ? success(result) : success);
    return result;
  } catch (err) {
    toast(err.message || 'Something went wrong', 'error', 6000);
    return undefined;
  }
}
