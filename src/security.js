// Request guards.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * When the app runs without sign-in (local use), only accept requests whose
 * Host is this machine. Stops "DNS rebinding" pages from reaching the API.
 * @param {import('./config.js').Config} config
 */
export function hostGuard(config) {
  return (req, res, next) => {
    if (!config.authDisabled) return next();
    const host = String(req.headers.host ?? '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    if (LOCAL_HOSTS.has(host) || config.allowedHosts.includes(host)) return next();
    res.status(403).json({ error: `Host ${host || '(none)'} is not allowed. Add it to ALLOWED_HOSTS.` });
  };
}

/**
 * State-changing requests must carry a header that browsers never send on
 * cross-site form posts (and cannot send cross-origin without CORS approval).
 */
export function csrfGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.get('x-requested-with') === 'reimbursement-tracker') return next();
  res.status(403).json({ error: 'Missing request header' });
}

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * Verify the Firebase ID token and the allow-list.
 * @param {import('./config.js').Config} config
 * @param {(token: string) => Promise<{ uid: string, email?: string, email_verified?: boolean }>} verifyToken
 */
export function authGuard(config, verifyToken) {
  return async (req, res, next) => {
    if (config.authDisabled) {
      req.uid = config.localUserId;
      req.email = null;
      return next();
    }
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
    if (!m) return res.status(401).json({ error: 'Please sign in' });
    let decoded;
    try {
      decoded = await verifyToken(m[1]);
    } catch {
      return res.status(401).json({ error: 'Your session expired, please sign in again' });
    }
    const email = String(decoded.email ?? '').toLowerCase();
    if (!email || decoded.email_verified === false || !config.allowedEmails.includes(email)) {
      return res.status(403).json({ error: `${email || 'This account'} is not allowed to use this app` });
    }
    req.uid = decoded.uid;
    req.email = email;
    next();
  };
}
