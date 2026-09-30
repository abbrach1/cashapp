import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { apiRouter } from './routes/api.js';
import { authGuard, csrfGuard, hostGuard, securityHeaders } from './security.js';
import { configProblems, envChecklist } from './config.js';
import { UserError } from './core/errors.js';
import { ConflictError } from './store/model.js';
import { syncAll } from './core/sync.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * @param {{
 *   config: import('./config.js').Config,
 *   store: import('./store/base.js').BaseStore,
 *   plaid: () => Promise<any>,
 *   verifyToken?: (token: string) => Promise<any>,
 *   fetch?: typeof fetch,
 *   today?: () => string,
 *   serveStatic?: boolean,
 * }} deps
 */
export function createApp(deps) {
  const { config } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(securityHeaders);

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Public: what the page needs before sign-in.
  app.get('/api/config', hostGuard(config), (req, res) => {
    res.json({
      appName: config.appName,
      authRequired: !config.authDisabled,
      demo: config.demo,
      firebase: config.authDisabled ? null : { ...config.firebase.web, authEmulatorHost: config.firebase.authEmulatorHost },
      plaid: { enabled: Boolean(config.plaid.clientId && config.plaid.secret), env: config.plaid.env, redirectUri: config.plaid.redirectUri },
      problems: configProblems(config),
      // Names only (never values), so a misconfigured deployment can be diagnosed.
      setup: { deployment: config.deployment, checklist: envChecklist(config) },
    });
  });

  // Vercel Cron: daily bank sync for every user of this deployment.
  app.get('/api/cron/sync', async (req, res) => {
    const expected = config.cronSecret ? `Bearer ${config.cronSecret}` : null;
    const got = req.get('authorization') ?? '';
    const ok = expected && got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
    if (!ok) return res.status(401).json({ error: 'Unauthorized' });
    const started = Date.now();
    const summary = [];
    for (const uid of await deps.store.listUserIds()) {
      if (Date.now() - started > 240_000) break; // stay inside the function time limit
      const snapshot = await deps.store.load(uid);
      const email = snapshot.meta?.email;
      if (!config.authDisabled && (!email || !config.allowedEmails.includes(email))) continue;
      const results = await syncAll(deps, uid, { staleMinutes: 60 });
      summary.push({ uid, results: results.map((r) => ({ ok: r.ok, skipped: r.skipped, error: r.error })) });
    }
    res.json({ ok: true, users: summary.length, summary });
  });

  app.use(
    '/api',
    hostGuard(config),
    csrfGuard,
    express.json({ limit: '4mb' }),
    authGuard(config, deps.verifyToken ?? (() => Promise.reject(new Error('No token verifier')))),
    apiRouter(deps),
  );

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  if (deps.serveStatic) {
    app.use(hostGuard(config), express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));
  }

  app.use((err, req, res, next) => {
    if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
    if (err instanceof ConflictError) return res.status(409).json({ error: err.message });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large (max 4 MB)' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Check the server logs for details.' });
  });
  return app;
}
