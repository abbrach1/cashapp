// Vercel serverless function: every /api/* request is routed here (see
// vercel.json). The Express app is built once per warm instance.
import { buildApp } from '../src/bootstrap.js';

const ready = buildApp().then(({ app, config }) => {
  if (config.onVercel && config.authDisabled) throw new Error('Refusing to run on Vercel without sign-in');
  return app;
});
// Keep the rejection handled; each request reports it below.
ready.catch(() => {});

export default async function handler(req, res) {
  let app;
  try {
    app = await ready;
  } catch (err) {
    console.error('Startup failed:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Server configuration error: ${err.message}` }));
    return;
  }
  return app(req, res);
}
