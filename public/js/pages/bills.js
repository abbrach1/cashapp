import { html, useState } from '../../vendor/preact.js';
import { money, plural } from '../format.js';
import { download } from '../api.js';
import { attempt, useStore } from '../store.js';
import { Empty, Menu } from '../ui.js';
import { BillsTable } from '../components/bills.js';

const FILTERS = [
  ['all', 'All'],
  ['owed', 'Still owed'],
  ['ready', 'Ready to submit'],
  ['submitted', 'Submitted'],
  ['unpaid', 'Not paid'],
  ['reimbursed', 'Reimbursed'],
  ['open', 'Current'],
];

function matches(b, filter) {
  if (filter === 'all') return true;
  if (filter === 'owed') return ['unpaid', 'ready', 'submitted', 'partial'].includes(b.status) && b.outstandingCents > 0;
  if (filter === 'submitted') return b.status === 'submitted' || b.status === 'partial';
  return b.status === filter;
}

export function BillsPage({ query }) {
  const { state } = useStore();
  const [filter, setFilter] = useState(query.get('filter') ?? 'all');
  const [accountId, setAccountId] = useState(query.get('account') ?? '');
  const [showOld, setShowOld] = useState(false);
  const cards = state.accounts.filter((a) => a.role === 'expenses');
  const bills = state.bills.filter((b) => (showOld || b.visible) && (!accountId || b.accountId === accountId) && matches(b, filter));
  const hiddenCount = state.bills.filter((b) => !b.visible).length;
  const owed = bills.reduce((s, b) => s + (['unpaid', 'ready', 'submitted', 'partial'].includes(b.status) ? Math.max(0, b.outstandingCents) : 0), 0);

  return html`<div class="stack-lg">
    <div class="page-head">
      <div>
        <h1>Statements</h1>
        <p class="muted">Each card statement is one bill. Pay it, send the report, get reimbursed.</p>
      </div>
      <${Menu} class="btn" label="Export all ▾">
        <div class="menu-label">Everything, for your records</div>
        <button onClick=${() => attempt(() => download('/export/ledger?format=xlsx'))}>Excel workbook (bills, transactions, payments)</button>
        <button onClick=${() => attempt(() => download('/export/ledger?format=csv'))}>CSV summary of all statements</button>
      <//>
    </div>
    <div class="card">
      <div class="card-head">
        <div class="chips">
          ${FILTERS.map(([key, label]) => html`<button class=${`chip ${filter === key ? 'active' : ''}`} onClick=${() => setFilter(key)}>${label}</button>`)}
        </div>
        ${cards.length > 1
          ? html`<select value=${accountId} onChange=${(e) => setAccountId(e.currentTarget.value)}>
              <option value="">All cards</option>
              ${cards.map((a) => html`<option value=${a.id}>${a.label}</option>`)}
            </select>`
          : null}
      </div>
      ${bills.length
        ? html`<${BillsTable} bills=${bills} today=${state.today} showCard=${!accountId && cards.length > 1} />`
        : html`<${Empty} title="Nothing here">No statements match this filter.<//>`}
      <div class="card-foot spread small">
        <span class="muted">${plural(bills.length, 'statement')}${owed ? html` · <b style="color:var(--text)">${money(owed)}</b> still owed` : ''}</span>
        ${hiddenCount
          ? html`<label class="check small"><input type="checkbox" checked=${showOld} onChange=${(e) => setShowOld(e.currentTarget.checked)} /> Show ${plural(hiddenCount, 'statement')} before tracking start</label>`
          : null}
      </div>
    </div>
  </div>`;
}
