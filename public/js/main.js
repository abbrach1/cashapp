import { html, render, useEffect } from '../vendor/preact.js';
import { configureApi } from './api.js';
import { relativeTime } from './format.js';
import { useRoute } from './router.js';
import { getStore, refresh, setStore, useStore } from './store.js';
import { AsyncButton, LoadingPage, Toasts } from './ui.js';
import { historyLoading, isStale, resumeOAuthIfNeeded, syncNow, watchHistory } from './connect.js';
import { SetupStatus } from './components/setup.js';
import { OverviewPage } from './pages/overview.js';
import { BillsPage } from './pages/bills.js';
import { BillPage } from './pages/bill.js';
import { ReimbursementsPage } from './pages/reimbursements.js';
import { TransactionsPage } from './pages/transactions.js';
import { ClassifyPage } from './pages/classify.js';
import { AccountsPage } from './pages/accounts.js';
import { SettingsPage } from './pages/settings.js';

const NAV = [
  ['/', 'Overview'],
  ['/bills', 'Statements'],
  ['/classify', 'Classify'],
  ['/reimbursements', 'Reimbursements'],
  ['/transactions', 'Transactions'],
  ['/accounts', 'Accounts'],
  ['/settings', 'Settings'],
];

function TopBar({ route }) {
  const { state, syncing, config } = useStore();
  const unmatched = state?.dashboard?.unmatchedCount ?? 0;
  const ready = state?.dashboard?.readyCount ?? 0;
  const unreviewed = state?.dashboard?.unreviewedCount ?? 0;
  const active = (path) => (path === '/' ? route.path === '/' : route.path.startsWith(path));
  return html`<header class="topbar">
    ${config?.demo ? html`<div class="demo-banner">Demo data — nothing here is real. Connect your own accounts by deploying the app (see README).</div>` : null}
    <div class="topbar-inner">
      <a class="brand" href="#/"><span class="brand-mark">$</span><span>${config?.appName ?? 'Reimbursements'}</span></a>
      <nav class="nav">
        ${NAV.map(
          ([path, label]) => html`<a href=${`#${path}`} class=${active(path) ? 'active' : ''}>
            ${label}${path === '/reimbursements' && unmatched ? html`<span class="count">${unmatched}</span>` : null}${path === '/bills' && ready ? html`<span class="count" style="background:var(--info)">${ready}</span>` : null}${path === '/classify' && unreviewed
              ? html`<span class="count" style="background:var(--muted)" title=${`${unreviewed} not reviewed yet`}>${unreviewed > 99 ? '99+' : unreviewed}</span>`
              : null}
          </a>`,
        )}
      </nav>
      <div class="topbar-actions">
        ${state?.connections?.length
          ? html`<${AsyncButton} class="btn sm" onClick=${() => syncNow()} disabled=${syncing} title=${`Last synced ${relativeTime(state.lastSyncedAt)}`}>
              ${syncing ? 'Syncing…' : html`↻ Sync <span class="muted hide-mobile" style="font-weight:500">${relativeTime(state.lastSyncedAt)}</span>`}
            <//>`
          : null}
      </div>
    </div>
  </header>`;
}

function Page({ route }) {
  const [section, id] = route.parts;
  if (!section) return html`<${OverviewPage} />`;
  if (section === 'bills' && id) return html`<${BillPage} id=${id} />`;
  if (section === 'bills') return html`<${BillsPage} query=${route.query} />`;
  if (section === 'reimbursements') return html`<${ReimbursementsPage} />`;
  if (section === 'transactions') return html`<${TransactionsPage} />`;
  if (section === 'classify') return html`<${ClassifyPage} key=${route.query.toString()} query=${route.query} />`;
  if (section === 'accounts') return html`<${AccountsPage} />`;
  if (section === 'settings') return html`<${SettingsPage} />`;
  return html`<div class="empty"><h3>Page not found</h3><a href="#/">Go to overview</a></div>`;
}

function App() {
  const route = useRoute();
  const { state, loading, error, user } = useStore();
  useEffect(() => {
    refresh()
      .then((s) => {
        resumeOAuthIfNeeded();
        if (isStale(s)) syncNow({ auto: true });
        if (historyLoading(s).length) watchHistory();
      })
      .catch(() => {});
  }, []);
  return html`<${TopBar} route=${route} />
    <main>
      ${error && !state
        ? html`<div class="callout danger row wrap">
            <span class="grow">${error}</span>
            <button class="btn sm" onClick=${() => refresh().catch(() => {})}>Retry</button>
            ${user ? html`<button class="btn sm" onClick=${() => import('./auth.js').then((a) => a.signOut())}>Sign out</button>` : null}
          </div>`
        : loading || !state
          ? html`<${LoadingPage} />`
          : html`<${Page} route=${route} />`}
    </main>
    <${Toasts} />`;
}

function SignIn({ problem }) {
  const { config } = useStore();
  const signIn = async () => {
    try {
      const auth = await import('./auth.js');
      await auth.signIn();
    } catch (err) {
      setStore({ authError: err.message });
    }
  };
  const { authError } = useStore();
  return html`<div class="signin">
    <div class="card stack">
      <div class="brand" style="justify-content:center"><span class="brand-mark">$</span><span>${config?.appName ?? 'Reimbursements'}</span></div>
      <p class="muted">Track card statements, what your company owes you, and the Zelle payments that settle them.</p>
      ${problem ? html`<div class="callout danger small">${problem}</div>` : null}
      <${SetupProblems} config=${config} />
      ${authError ? html`<div class="callout danger small">${authError}</div>` : null}
      <${AsyncButton} class="btn primary" onClick=${signIn}>Sign in with Google<//>
      ${config?.problems?.length ? null : html`<details class="small muted" style="text-align:left"><summary>Server setup</summary><${SetupStatus} config=${config} /></details>`}
    </div>
    <${Toasts} />
  </div>`;
}

function SetupProblems({ config }) {
  if (!config?.problems?.length) return null;
  return html`<div class="callout warn small stack" style="text-align:left">
    <div>
      <b>Setup needed:</b>
      <ul style="margin:6px 0 0;padding-left:18px">${config.problems.map((p) => html`<li>${p}</li>`)}</ul>
    </div>
    <${SetupStatus} config=${config} />
  </div>`;
}

function Fatal({ message, config }) {
  return html`<div class="signin"><div class="card stack" style="text-align:left;width:min(560px,100%)">
    <h2>Can't start yet</h2>
    ${message ? html`<p class="muted" style="margin:0">${message}</p>` : null}
    <${SetupProblems} config=${config} />
  </div></div>`;
}

async function start() {
  const root = document.getElementById('app');
  let config;
  try {
    const res = await fetch('/api/config');
    config = await res.json();
    if (!res.ok) throw new Error(config?.error ?? `Server error ${res.status}`);
  } catch (err) {
    render(html`<${Fatal} message=${`Could not reach the server: ${err.message}`} />`, root);
    return;
  }
  setStore({ config });
  document.title = config.appName;

  if (!config.authRequired) {
    configureApi({ getToken: async () => null });
    render(html`<${App} />`, root);
    return;
  }

  if (!config.firebase?.apiKey) {
    render(html`<${Fatal} config=${config} message=${config.problems?.length ? '' : 'Sign-in is not configured on the server.'} />`, root);
    return;
  }
  const auth = await import('./auth.js');
  await auth.initAuth(config.firebase);
  configureApi({ getToken: auth.getToken, unauthorized: () => setStore({ user: null }) });
  let shownFor = null;
  auth.onUserChanged((user) => {
    const key = user?.uid ?? 'signed-out';
    if (key === shownFor) return;
    shownFor = key;
    setStore({ user: user ? { email: user.email, uid: user.uid } : null, state: null, loading: true, error: null });
    if (user) render(html`<${App} key=${user.uid} />`, root);
    else render(html`<${SignIn} problem=${getStore().error} />`, root);
  });
}

start();
