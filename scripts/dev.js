// Local server: serves the web app and the API on http://localhost:3000
//
//   npm run demo   – sample data in memory, no accounts or keys needed
//   npm run dev    – your real data (reads .env; Firestore or the emulator)

import { existsSync } from 'node:fs';
import { buildApp } from '../src/bootstrap.js';
import { configProblems } from '../src/config.js';

if (existsSync('.env') && !process.argv.includes('--no-env')) process.loadEnvFile('.env');
if (process.argv.includes('--demo')) {
  process.env.DEMO = '1';
  process.env.STORE = 'memory';
}

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
const { app, config } = await buildApp({ serveStatic: true });

for (const p of configProblems(config)) console.warn(`! ${p}`);
app.listen(port, host, () => {
  const mode = config.demo ? 'demo data (in memory)' : `${config.store}${config.authDisabled ? ', sign-in disabled' : ''}`;
  console.log(`Reimbursement Tracker running at http://localhost:${port}  [${mode}]`);
});
