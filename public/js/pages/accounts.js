import { html, useState } from '../../vendor/preact.js';
import { del, post } from '../api.js';
import { longDate, money, plural, relativeTime, ROLE_LABEL } from '../format.js';
import { attempt, refresh, useStore } from '../store.js';
import { AsyncButton, Empty, Menu, Modal } from '../ui.js';
import { ImportDialog, SimplefinDialog } from '../components/dialogs.js';
import { connectWithPlaid, reconnectPlaid } from '../connect.js';

export function ConnectOptions() {
  const { config } = useStore();
  const [simplefin, setSimplefin] = useState(false);
  const [importing, setImporting] = useState(false);
  const plaidReady = config?.plaid?.enabled;
  return html`<div class="options">
    <div class="option">
      <span class="badge info tag">Recommended</span>
      <h3>Connect Chase with Plaid</h3>
      <p>Log in to Chase in a secure Plaid window. New transactions arrive automatically, and statement dates and balances come straight from Chase.</p>
      ${plaidReady
        ? html`<${AsyncButton} class="btn primary" onClick=${connectWithPlaid}>Connect Chase<//>`
        : html`<button class="btn" disabled title="Set PLAID_CLIENT_ID and PLAID_SECRET on the server">Connect Chase</button>
            <span class="tiny muted">Needs Plaid keys on the server (free Plaid Trial plan) — see README.</span>`}
    </div>
    <div class="option">
      <h3>SimpleFIN Bridge</h3>
      <p>A low-cost alternative ($15/year). Connect Chase on their site, then paste a setup token here. Updates once a day.</p>
      <button class="btn" onClick=${() => setSimplefin(true)}>Paste setup token</button>
    </div>
    <div class="option">
      <h3>Import a CSV from chase.com</h3>
      <p>No connection needed: download "account activity" from Chase and import it. Great for older statements too.</p>
      <button class="btn" onClick=${() => setImporting(true)}>Import CSV</button>
    </div>
    <${SimplefinDialog} open=${simplefin} onClose=${() => setSimplefin(false)} />
    <${ImportDialog} open=${importing} onClose=${() => setImporting(false)} />
  </div>`;
}

function ConnectionCard({ c, accounts }) {
  const [confirm, setConfirm] = useState(false);
  const linked = accounts.filter((a) => a.connectionId === c.id);
  const sync = () =>
    attempt(async () => {
      const res = await post(`/connections/${c.id}/sync`);
      refresh(res.state);
      if (res.result?.ok === false) throw new Error(res.result.error);
      return res.result;
    }, (r) => (r?.added ? `${plural(r.added, 'new transaction')}.` : 'Up to date.'));
  const remove = () =>
    attempt(async () => {
      refresh((await del(`/connections/${c.id}`)).state);
      setConfirm(false);
    }, 'Disconnected. Your history was kept.');
  const statusPill =
    c.status === 'ok'
      ? html`<span class="pill ok">Connected</span>`
      : c.status === 'reauth'
        ? html`<span class="pill reauth">Log in again</span>`
        : html`<span class="pill error">Error</span>`;
  return html`<div class="card">
    <div class="card-head">
      <div>
        <div class="row wrap"><h3>${c.institution ?? 'Bank'}</h3>${statusPill}</div>
        <div class="small muted">via ${c.provider === 'plaid' ? 'Plaid' : 'SimpleFIN Bridge'} · synced ${relativeTime(c.lastSyncedAt)}${linked.length ? ` · ${plural(linked.length, 'account')}` : ''}</div>
      </div>
      <div class="row">
        ${c.provider === 'plaid' && c.status === 'reauth' ? html`<${AsyncButton} class="btn primary sm" onClick=${() => reconnectPlaid(c.id)}>Reconnect<//>` : null}
        <${AsyncButton} class="btn sm" onClick=${sync}>Sync now<//>
        <${Menu} class="btn sm ghost" label="⋯">
          ${c.provider === 'plaid' ? html`<button onClick=${() => reconnectPlaid(c.id)}>Update login / accounts</button>` : null}
          <button class="danger" onClick=${() => setConfirm(true)}>Disconnect…</button>
        <//>
      </div>
    </div>
    ${c.lastError ? html`<div class="card-body"><div class="callout danger small">${c.lastError}</div></div>` : null}
    ${c.historyStatus === 'NOT_READY' ? html`<div class="card-body"><div class="callout small">Your bank is still preparing transaction history. It will appear after the next sync.</div></div>` : null}
    ${c.warnings?.length ? html`<div class="card-body"><div class="callout warn small">${c.warnings.join(' · ')}</div></div>` : null}
    <${Modal}
      open=${confirm}
      onClose=${() => setConfirm(false)}
      title=${`Disconnect ${c.institution ?? 'this bank'}?`}
      footer=${html`<button class="btn" onClick=${() => setConfirm(false)}>Cancel</button><${AsyncButton} class="btn primary" onClick=${remove}>Disconnect<//>`}
    >
      <p style="margin-top:0">New transactions stop coming in and the stored access token is deleted. Your accounts, transactions, exceptions and reimbursements stay; you can reconnect later and they merge back.</p>
    <//>
  </div>`;
}

function AccountRow({ a }) {
  const [nick, setNick] = useState(a.nickname ?? a.name);
  const saveName = () => {
    const next = nick.trim();
    const nickname = !next || next === a.name ? null : next;
    if (!next) setNick(a.name);
    if (nickname !== (a.nickname ?? null)) save({ nickname }, 'Renamed.');
  };
  const save = (patch, msg) => attempt(async () => refresh((await post(`/accounts/${a.id}`, patch)).state), msg);
  const remove = () => attempt(async () => refresh((await del(`/accounts/${a.id}`)).state), 'Account deleted.');
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  return html`<tr>
    <td>
      <input class="note-input merchant" style="font-weight:600" value=${nick} placeholder=${a.name} aria-label="Nickname"
        onInput=${(e) => setNick(e.currentTarget.value)}
        title="Click to rename"
        onBlur=${saveName}
        onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      <div class="sub-desc" style="padding-left:6px">${a.institution ?? ''} ${a.mask ? `•••• ${a.mask}` : ''} · ${a.connectionId ? 'connected' : a.source === 'demo' ? 'demo data' : 'imported from CSV'} · ${plural(a.txnCount, 'transaction')}</div>
    </td>
    <td data-label="Type">
      <select value=${a.kind} onChange=${(e) => save({ kind: e.currentTarget.value }, 'Updated.')}>
        <option value="credit">Credit card</option><option value="checking">Checking</option><option value="savings">Savings</option><option value="other">Other</option>
      </select>
    </td>
    <td data-label="Use">
      <select value=${a.role} onChange=${(e) => save({ role: e.currentTarget.value }, 'Updated.')}>
        ${Object.entries(ROLE_LABEL).map(([k, v]) => html`<option value=${k}>${v}</option>`)}
      </select>
    </td>
    <td data-label="Closes on day">
      ${a.role === 'expenses'
        ? html`<select value=${a.closingDay ?? ''} style=${a.closingDay ? '' : 'border-color:var(--warn)'} onChange=${(e) => save({ closingDay: e.currentTarget.value ? Number(e.currentTarget.value) : null }, 'Statements regrouped.')}>
            <option value="">Set…</option>
            ${days.map((d) => html`<option value=${d}>${d}</option>`)}
          </select>`
        : html`<span class="muted">—</span>`}
    </td>
    <td data-label="Due on day">
      ${a.role === 'expenses'
        ? html`<select value=${a.dueDay ?? ''} onChange=${(e) => save({ dueDay: e.currentTarget.value ? Number(e.currentTarget.value) : null }, 'Updated.')}>
            <option value="">—</option>
            ${days.map((d) => html`<option value=${d}>${d}</option>`)}
          </select>`
        : html`<span class="muted">—</span>`}
    </td>
    <td class="amount" data-label="Balance">
      ${a.balanceCents !== null ? html`<span class="money">${money(a.balanceCents)}</span>` : html`<span class="muted">—</span>`}
      ${a.stmtDate ? html`<div class="tiny muted">last statement ${longDate(a.stmtDate)}</div>` : null}
    </td>
    <td style="width:40px">
      ${!a.connectionId
        ? html`<${Menu} class="btn ghost icon" label="⋯"><button class="danger" onClick=${remove}>Delete account and its history</button><//>`
        : null}
    </td>
  </tr>`;
}

export function AccountsPage() {
  const { state } = useStore();
  const [adding, setAdding] = useState(false);
  return html`<div class="stack-lg">
    <div class="page-head">
      <div><h1>Accounts</h1><p class="muted">Bank connections, and what each account is used for.</p></div>
      <button class="btn primary" onClick=${() => setAdding(!adding)}>${adding ? 'Close' : '+ Add account'}</button>
    </div>
    ${adding || !state.accounts.length ? html`<${ConnectOptions} />` : null}
    ${state.connections.length ? html`<div class="stack">${state.connections.map((c) => html`<${ConnectionCard} key=${c.id} c=${c} accounts=${state.accounts} />`)}</div>` : null}
    <div class="card">
      <div class="card-head"><h2>Your accounts</h2></div>
      ${state.accounts.length
        ? html`<div class="table-wrap"><table class="data stack-mobile">
            <thead><tr><th>Account</th><th>Type</th><th>Use</th><th>Closes on day</th><th>Due on day</th><th class="amount">Balance</th><th></th></tr></thead>
            <tbody>${state.accounts.map((a) => html`<${AccountRow} key=${`${a.id}-${a.nickname}`} a=${a} />`)}</tbody>
          </table></div>`
        : html`<${Empty} title="No accounts yet">Connect Chase or import a CSV above.<//>`}
      <div class="card-foot small muted">
        <b>Expense card</b>: every charge is claimed unless you exclude it; transactions are grouped into statements by the closing day.
        <b> Receives Zelle</b>: incoming Zelle payments here are treated as reimbursements.
      </div>
    </div>
  </div>`;
}
