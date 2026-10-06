import { html, useState } from '../../vendor/preact.js';
import { post } from '../api.js';
import { daysBetween, longDate, money, period, plural, shortDate } from '../format.js';
import { navigate } from '../router.js';
import { attempt, refresh, useStore } from '../store.js';
import { AsyncButton, Money, Tile, Empty } from '../ui.js';
import { BillsTable } from '../components/bills.js';
import { AllocationDialog, ServicesDialog } from '../components/dialogs.js';
import { useSendRequest } from '../components/request.js';
import { ConnectOptions } from './accounts.js';
import { historyLoading, reconnectPlaid } from '../connect.js';

function Attention({ state }) {
  const [allocating, setAllocating] = useState(null);
  const [services, setServices] = useState(null);
  const [openRequest, requestDialog] = useSendRequest();
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
      <div class="grow"><div class="merchant">Set the statement closing day for ${a?.label}</div><div class="sub-desc">Needed to group charges into statements. It's printed on your statement.</div></div>
      <a class="btn sm primary" href="#/accounts">Set it</a>
    </li>`);
  }
  const visible = state.bills.filter((b) => b.visible);
  const toReview = state.dashboard.unreviewedClosedCount ?? 0;
  if (toReview) {
    items.push(html`<li key="classify">
      <div class="icon-dot setup">✎</div>
      <div class="grow"><div class="merchant">Review ${plural(toReview, 'charge')} on closed statements</div><div class="sub-desc">Mark anything personal before you send the requests. Everything else counts as business.</div></div>
      <a class="btn sm primary" href="#/classify">Classify</a>
    </li>`);
  }
  for (const b of visible.filter((x) => x.status === 'ready').reverse()) {
    items.push(html`<li key=${`r-${b.id}`}>
      <div class="icon-dot ready">↗</div>
      <div class="grow"><div class="merchant">Send the request for ${b.accountLabel} · ${period(b.start, b.end)}</div><div class="sub-desc">${money(b.claimCents)} to request · card paid ${b.paid.paidOn ? shortDate(b.paid.paidOn, today) : ''}</div></div>
      <button class="btn sm primary" onClick=${() => openRequest(b.id)}>Send request</button>
    </li>`);
  }
  for (const b of visible.filter((x) => x.status === 'unpaid')) {
    const overdue = b.dueDate && b.dueDate < today;
    items.push(html`<li key=${`u-${b.id}`}>
      <div class="icon-dot unpaid">$</div>
      <div class="grow"><div class="merchant">Pay the card: ${b.accountLabel} · statement closed ${shortDate(b.end, today)}</div>
        <div class="sub-desc">${b.dueDate ? `${overdue ? 'Was due' : 'Due'} ${shortDate(b.dueDate, today)} · ` : ''}${b.paid.neededCents ? `statement ${money(b.paid.neededCents)}` : ''}${b.paid.paidCents ? ` · ${money(b.paid.paidCents)} paid so far` : ''}</div></div>
      <a class="btn sm" href=${`#/bills/${b.id}`}>Open</a>
    </li>`);
  }
  for (const r of state.reimbursements.filter((x) => x.status === 'active' && x.unallocatedCents > 0)) {
    items.push(html`<li key=${`z-${r.id}`}>
      <div class="icon-dot match">⇄</div>
      <div class="grow"><div class="merchant">${money(r.unallocatedCents)} from ${r.sender ?? 'Zelle'} isn't matched yet</div><div class="sub-desc">Received ${longDate(r.date)} — a reimbursement for a statement, or a payment for your services?</div></div>
      <div class="row wrap actions">
        <button class="btn sm primary" onClick=${() => setAllocating(r)}>Match to statement</button>
        ${r.allocatedCents ? null : html`<button class="btn sm" onClick=${() => setServices(r)}>Payment for services</button>`}
      </div>
    </li>`);
  }
  if (!items.length) return null;
  const MAX = 6;
  const shown = items.length > MAX ? items.slice(0, MAX - 1) : items;
  return html`<div class="card">
    <div class="card-head"><h2>Needs your attention</h2><span class="muted small">${plural(items.length, 'item')}</span></div>
    <ul class="list attention">
      ${shown}
      ${items.length > MAX
        ? html`<li key="more"><span class="grow small muted">and ${items.length - shown.length} more</span><a class="btn sm" href="#/bills?filter=owed">See all statements</a></li>`
        : null}
    </ul>
    <${AllocationDialog} open=${Boolean(allocating)} reimbursement=${allocating} onClose=${() => setAllocating(null)} />
    <${ServicesDialog} open=${Boolean(services)} payment=${services} onClose=${() => setServices(null)} />
    ${requestDialog}
  </div>`;
}

/** First day of the month before today's month: covers the last closed statement or two. */
function suggestedStart(today) {
  const [y, m] = today.split('-').map(Number);
  const prev = m === 1 ? [y - 1, 12] : [y, m - 1];
  return `${prev[0]}-${String(prev[1]).padStart(2, '0')}-01`;
}

/** Shown when old history (e.g. a year pulled from the bank) counts as owed. */
function TrackingStartPrompt({ state }) {
  if (state.settings.trackingStartDate) return null;
  const old = state.bills.filter((b) => !b.isOpen && b.outstandingCents > 0 && daysBetween(b.end, state.today) > 75);
  if (old.length < 2) return null;
  const start = suggestedStart(state.today);
  const setStart = () =>
    attempt(async () => refresh((await post('/settings', { trackingStartDate: start })).state), `Tracking statements from ${longDate(start)}.`);
  return html`<div class="callout warn row wrap">
    <span class="grow">
      <b>${plural(old.length, 'older statement')}</b> (${money(old.reduce((s, b) => s + b.outstandingCents, 0))}) count as owed because past history was imported.
      Go through them to mark personal items and the ones you were already paid back for — or only track recent statements (you can change it any time in Settings).
    </span>
    <a class="btn sm primary" href="#/classify">Classify history</a>
    <${AsyncButton} class="btn sm" onClick=${setStart}>Track from ${longDate(start)}<//>
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
        <p class="muted">Connect the Chase cards you pay work expenses with. Everything on them counts as business unless you mark it personal.</p></div></div>
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

    ${historyLoading(state).length
      ? html`<div class="callout small row"><span class="spinner" aria-hidden="true"></span><span>Your bank is still sending older transactions. Totals will update as they arrive.</span></div>`
      : null}
    <${TrackingStartPrompt} state=${state} />

    <div class="tiles">
      <${Tile} accent label="Owed to you" value=${money(d.owedCents)} sub=${`${plural(outstandingBills.length, 'statement')} not fully reimbursed`} onClick=${() => navigate('/bills?filter=owed')} />
      <${Tile} label="Waiting on company" value=${money(d.awaitingCompanyCents)} sub="Requests sent, not paid back yet" onClick=${() => navigate('/bills?filter=submitted')} />
      <${Tile} label="Ready to send" value=${money(d.readyCents)} sub=${d.readyCount ? `${plural(d.readyCount, 'request')} to send` : 'Nothing waiting'} onClick=${() => navigate('/bills?filter=ready')} />
      <${Tile} label="Current cycle" value=${money(d.currentCycleCents)} sub="Business charges so far" />
    </div>

    <${Attention} state=${state} />

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h2>Statements</h2><a class="small" href="#/bills">All statements →</a></div>
        ${recent.length ? html`<${BillsTable} bills=${recent} today=${state.today} compact />` : html`<${Empty} title="No statements yet">Charges are grouped into statements once your cards have a closing day.<//>`}
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
        <div class="card-foot small muted">
          Reimbursed this year: <b>${money(d.receivedYtdCents)}</b>${d.incomeYtdCents ? html` · for your services: <b>${money(d.incomeYtdCents)}</b>` : null}
        </div>
      </div>
    </div>
  </div>`;
}
