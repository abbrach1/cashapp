import { html, useState } from '../../vendor/preact.js';
import { longDate, money, period, plural, shortDate } from '../format.js';
import { navigate } from '../router.js';
import { useStore } from '../store.js';
import { Money, Tile, Empty } from '../ui.js';
import { BillsTable } from '../components/bills.js';
import { AllocationDialog } from '../components/dialogs.js';
import { ConnectOptions } from './accounts.js';
import { reconnectPlaid } from '../connect.js';

function Attention({ state }) {
  const [allocating, setAllocating] = useState(null);
  const items = [];
  const today = state.today;
  for (const c of state.connections) {
    if (c.status === 'reauth' || c.status === 'error') {
      items.push(html`<li key=${`c-${c.id}`}>
        <div class="icon-dot error">!</div>
        <div class="grow"><div class="merchant">${c.institution ?? 'Bank'} connection needs attention</div><div class="sub-desc">${c.lastError}</div></div>
        ${c.provider === 'plaid' && c.status === 'reauth'
          ? html`<button class="btn sm primary" onClick=${() => reconnectPlaid(c.id)}>Reconnect</button>`
          : html`<a class="btn sm" href="#/accounts">Open</a>`}
      </li>`);
    }
  }
  for (const id of state.dashboard.accountsNeedingSetup) {
    const a = state.accounts.find((x) => x.id === id);
    items.push(html`<li key=${`a-${id}`}>
      <div class="icon-dot setup">⚙</div>
      <div class="grow"><div class="merchant">Set the statement closing day for ${a?.label}</div><div class="sub-desc">Needed to group transactions into bills. It's on your statement.</div></div>
      <a class="btn sm primary" href="#/accounts">Set it</a>
    </li>`);
  }
  const visible = state.bills.filter((b) => b.visible);
  for (const b of visible.filter((x) => x.status === 'ready').reverse()) {
    items.push(html`<li key=${`r-${b.id}`}>
      <div class="icon-dot ready">↗</div>
      <div class="grow"><div class="merchant">Send ${b.accountLabel} · ${period(b.start, b.end)}</div><div class="sub-desc">Paid ${b.paid.paidOn ? shortDate(b.paid.paidOn, today) : ''} — ${money(b.claimCents)} to claim</div></div>
      <a class="btn sm primary" href=${`#/bills/${b.id}`}>Export & submit</a>
    </li>`);
  }
  for (const b of visible.filter((x) => x.status === 'unpaid')) {
    const overdue = b.dueDate && b.dueDate < today;
    items.push(html`<li key=${`u-${b.id}`}>
      <div class="icon-dot unpaid">$</div>
      <div class="grow"><div class="merchant">Pay ${b.accountLabel} · statement closed ${shortDate(b.end, today)}</div>
        <div class="sub-desc">${b.dueDate ? `${overdue ? 'Was due' : 'Due'} ${shortDate(b.dueDate, today)} · ` : ''}${b.paid.neededCents ? `statement ${money(b.paid.neededCents)}` : ''}${b.paid.paidCents ? ` · ${money(b.paid.paidCents)} paid so far` : ''}</div></div>
      <a class="btn sm" href=${`#/bills/${b.id}`}>Open</a>
    </li>`);
  }
  for (const r of state.reimbursements.filter((x) => x.status === 'active' && x.unallocatedCents > 0)) {
    items.push(html`<li key=${`z-${r.id}`}>
      <div class="icon-dot match">⇄</div>
      <div class="grow"><div class="merchant">Match ${money(r.unallocatedCents)} from ${r.sender ?? 'Zelle'}</div><div class="sub-desc">Received ${longDate(r.date)} — which bill does it pay?</div></div>
      <button class="btn sm primary" onClick=${() => setAllocating(r)}>Match</button>
    </li>`);
  }
  if (!items.length) return null;
  return html`<div class="card">
    <div class="card-head"><h2>Needs your attention</h2><span class="muted small">${plural(items.length, 'item')}</span></div>
    <ul class="list">${items}</ul>
    <${AllocationDialog} open=${Boolean(allocating)} reimbursement=${allocating} onClose=${() => setAllocating(null)} />
  </div>`;
}

export function OverviewPage() {
  const { state } = useStore();
  const d = state.dashboard;
  const hasAccounts = state.accounts.length > 0;
  const visible = state.bills.filter((b) => b.visible && b.status !== 'nothing');
  const recent = visible.slice(0, 8);
  const reimbursements = state.reimbursements.filter((r) => r.status === 'active').slice(0, 5);
  const outstandingBills = visible.filter((b) => ['unpaid', 'ready', 'submitted', 'partial'].includes(b.status) && b.outstandingCents > 0);

  if (!hasAccounts) {
    return html`<div class="stack-lg">
      <div class="page-head"><div><h1>Welcome${state.settings.yourName ? `, ${state.settings.yourName.split(' ')[0]}` : ''}</h1>
        <p class="muted">Connect the Chase cards you pay work expenses with. Everything on them counts as reimbursable unless you mark it personal.</p></div></div>
      <${ConnectOptions} />
      <div class="card"><div class="card-body small muted">
        Tip: fill in your name, company and Zelle details in <a href="#/settings">Settings</a> — they are printed on the reports you send.
      </div></div>
    </div>`;
  }

  return html`<div class="stack-lg">
    <div class="page-head">
      <div>
        <h1>Overview</h1>
        <p class="muted">${state.settings.trackingStartDate ? `Tracking statements closing since ${longDate(state.settings.trackingStartDate)}` : 'Tracking all statements'}</p>
      </div>
    </div>

    <div class="tiles">
      <${Tile} accent label="Owed to you" value=${money(d.owedCents)} sub=${`${plural(outstandingBills.length, 'statement')} not fully reimbursed`} onClick=${() => navigate('/bills?filter=owed')} />
      <${Tile} label="Waiting on company" value=${money(d.awaitingCompanyCents)} sub="Submitted, not paid back yet" onClick=${() => navigate('/bills?filter=submitted')} />
      <${Tile} label="Ready to submit" value=${money(d.readyCents)} sub=${d.readyCount ? `${plural(d.readyCount, 'paid statement')} to send` : 'Nothing waiting'} onClick=${() => navigate('/bills?filter=ready')} />
      <${Tile} label="Current cycle" value=${money(d.currentCycleCents)} sub="Claimable so far this month" />
    </div>

    <${Attention} state=${state} />

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h2>Statements</h2><a class="small" href="#/bills">All statements →</a></div>
        ${recent.length ? html`<${BillsTable} bills=${recent} today=${state.today} compact />` : html`<${Empty} title="No statements yet">Transactions will be grouped into statements once your cards have a closing day.<//>`}
      </div>
      <div class="card">
        <div class="card-head"><h2>Reimbursements</h2><a class="small" href="#/reimbursements">All →</a></div>
        ${reimbursements.length
          ? html`<ul class="list">
              ${reimbursements.map(
                (r) => html`<li key=${r.id}>
                  <div class="grow">
                    <div class="merchant">${r.sender ?? 'Payment'}</div>
                    <div class="sub-desc">${longDate(r.date)} · ${r.unallocatedCents > 0 ? `${money(r.unallocatedCents)} not matched` : r.allocations.length > 1 ? `split across ${r.allocations.length} statements` : 'matched'}</div>
                  </div>
                  <${Money} cents=${r.amountCents} className="merchant" />
                </li>`,
              )}
            </ul>`
          : html`<${Empty} title="No reimbursements yet" icon="⇄">Incoming Zelle payments from your company show up here automatically.<//>`}
        <div class="card-foot small muted">Received this year: <b>${money(d.receivedYtdCents)}</b></div>
      </div>
    </div>
  </div>`;
}
