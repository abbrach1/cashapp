// Google sign-in through Firebase Authentication.

let fb;
let auth;

export async function initAuth(config) {
  fb = await import('../vendor/firebase-auth.js');
  const app = fb.initializeApp({
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    appId: config.appId ?? undefined,
  });
  auth = fb.getAuth(app);
  if (config.authEmulatorHost) fb.connectAuthEmulator(auth, `http://${config.authEmulatorHost}`, { disableWarnings: true });
  await fb.setPersistence(auth, fb.browserLocalPersistence);
  try {
    await fb.getRedirectResult(auth);
  } catch {
    // no pending redirect
  }
}

export function onUserChanged(callback) {
  return fb.onAuthStateChanged(auth, callback);
}

export async function signIn() {
  const provider = new fb.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await fb.signInWithPopup(auth, provider);
  } catch (err) {
    if (err?.code === 'auth/popup-blocked' || err?.code === 'auth/operation-not-supported-in-this-environment') {
      await fb.signInWithRedirect(auth, provider);
      return;
    }
    if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return;
    throw err;
  }
}

export async function signOut() {
  if (auth) await fb.signOut(auth);
}

export async function getToken() {
  return auth?.currentUser ? auth.currentUser.getIdToken() : null;
}
