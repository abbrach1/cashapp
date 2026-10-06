import { html, useEffect, useState } from '../../vendor/preact.js';
import { del, get, post } from '../api.js';
import { longDate, money, period, plural } from '../format.js';
import { attempt, refresh, useStore } from '../store.js';
import { AsyncButton, Empty, Menu, Money, Skeleton } from '../ui.js';
import { AllocationDialog, ManualReimbursementDialog } from '../components/dialogs.js';

function billLabel(state, billId) {
  const b = state.bills.find((x) => x.id === billId);
  return b ? `${b.accountLabel} · ${period(b.start, b.end)}` : 'Deleted statement';
}

function NeedsMatching({ r, state, onAllocate }) {
  const accept = () =>
    attempt(async () => refresh((await post(`/reimbursements/${r.id}/accept-suggestion`)).state), 'Payment applied.');
  const ignore = () =>
    attempt(async () => refresh((await post(`/reimbursements/${r.id}`, { status: 'ignored' })).state), 'Marked as not a reimbursement.');
  return html`<div class="card">
    <div class="card-body stack">
      <div class="spread">
        <div>
          <div class="merchant" style="font-size:1.05rem">${money(r.unallocatedCents)} ${r.allocatedCents ? html`<span class="muted small">left of ${money(r.amountCents)}</span>` : null}</div>
          <div class="sub-desc">${r.sender ?? 'Unknown sender'} · ${longDate(r.date)}${r.description ? ` · ${r.description}` : ''}</div>
        </div>
        <div class="row wrap">
          <button class="btn sm" onClick=${() => onAllocate(r)}>Split / choose…</button>
          <${AsyncButton} class="btn sm ghost" onClick=${ignore}>Not a reimbursement<//>
        </div>
      </div>
      ${r.suggestion.length
        ? html`<div class="callout">
            <div class="small" style="margin-bottom:6px">Suggested (oldest statements first):</div>
            ${r.suggestion.map((s) => html`<div class="spread small" key=${s.billId}><span>${billLabel(state, s.billId)}</span><b><${Money} cents=${s.amountCents} /></b></div>`)}
            <div style="margin-top:10px"><${AsyncButton} class="btn sm primary" onClick=${accept}>Apply suggestion<//></div>
          </div>`
        : html`<div class="small muted">No statement is waiting for money. If it pays a statement from before you started tracking, mark that statement as already reimbursed, or mark this as not a reimbursement.</div>`}
    </div>
  </div>`;
}

/**
 * Deposits that weren't picked up as reimbursements (a different sender name,
 * a bank transfer instead of Zelle...), so a missed payment is easy to find.
 */
function OtherDeposits() {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(null);
  const load = () =>
    get('/deposits')
      .then((res) => setList(res.deposits))
      .catch(() => setList([]));
  useEffect(() => {
    if (open) load();
  }, [open, state.lastSyncedAt]);
  const count = (d) =>
    attempt(async () => {
      const res = await post('/reimbursements/from-txn', { txnId: d.id });
      refresh(res.state);
      await load();
    }, `Counted ${money(d.amountCents)} as a reimbursement.`);
  return html`<div class="card">
    <div class="card-head">
      <div>
        <h2>Other money received</h2>
        <div class="small muted">Deposits from the last 90 days that aren't counted as reimbursements. Company payment missing? Count it here.</div>
      </div>
      <button class="btn sm" onClick=${() => setOpen(!open)}>${open ? 'Hide' : 'Show'}</button>
    </div>
    ${!open
      ? null
      : !list
        ? html`<div class="card-body stack"><${Skeleton} height=${18} /><${Skeleton} height=${18} /></div>`
        : list.length
          ? html`<ul class="list">
              ${list.map(
                (d) => html`<li key=${d.id}>
                  <div class="grow"><div class="merchant">${d.description}</div><div class="sub-desc">${longDate(d.date)} · ${d.accountLabel}</div></div>
                  <${Money} cents=${d.amountCents} className="merchant" />
                  <${AsyncButton} class="btn sm" onClick=${() => count(d)}>Count as reimbursement<//>
                </li>`,
              )}
            </ul>`
          : html`<div class="card-body small muted">Nothing else arrived in the last 90 days.</div>`}
  </div>`;
}

export function ReimbursementsPage() {
  const { state } = useStore();
  const [allocating, setAllocating] = useState(null);
  const [adding, setAdding] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const active = state.reimbursements.filter((r) => r.status === 'active');
  const unmatched = active.filter((r) => r.unallocatedCents > 0);
  const ignored = state.reimbursements.filter((r) => r.status === 'ignored');
  const list = showIgnored ? state.reimbursements : active;
  const watched = state.accounts.filter((a) => a.role === 'reimbursements');
  const s = state.settings;

  const restore = (r) => attempt(async () => refresh((await post(`/reimbursements/${r.id}`, { status: 'active' })).state), 'Restored.');
  const remove = (r) => attempt(async () => refresh((await del(`/reimbursements/${r.id}`)).state), 'Deleted.');

  return html`<div class="stack-lg">
    <div class="page-head">
      <div>
        <h1>Reimbursements</h1>
        <p class="muted">Zelle payments from your company, and which statements they paid.</p>
      </div>
      <button class="btn" onClick=${() => setAdding(true)}>+ Record a payment</button>
    </div>

    <div class="callout small">
      ${watched.length
        ? html`Watching ${watched.map((a, i) => html`${i ? ', ' : ''}<b>${a.label}</b>`)} for incoming payments containing${' '}
            ${s.reimbursementKeywords.map((k, i) => html`${i ? ' or ' : ''}"${k}"`)}${s.senderFilters.length
              ? html` from ${s.senderFilters.map((k, i) => html`${i ? ' or ' : ''}"${k}"`)}`
              : html` from <b>anyone</b> — add your company's name in <a href="#/settings">Settings</a> to skip Zelles from friends`}.
            Exact amounts are matched to statements automatically.`
        : html`No account is set to receive reimbursements. In <a href="#/accounts">Accounts</a>, set your checking account to "Receives Zelle".`}
    </div>

    ${unmatched.length
      ? html`<div class="stack">
          <h2>Needs matching <span class="muted small">(${unmatched.length})</span></h2>
          ${unmatched.map((r) => html`<${NeedsMatching} key=${r.id} r=${r} state=${state} onAllocate=${setAllocating} />`)}
        </div>`
      : null}

    <div class="card">
      <div class="card-head">
        <h2>All payments</h2>
        ${ignored.length
          ? html`<label class="check small"><input type="checkbox" checked=${showIgnored} onChange=${(e) => setShowIgnored(e.currentTarget.checked)} /> Show ${plural(ignored.length, 'ignored payment')}</label>`
          : null}
      </div>
      ${list.length
        ? html`<div class="table-wrap"><table class="data stack-mobile">
            <thead><tr><th>Date</th><th>From</th><th>Applied to</th><th class="amount">Amount</th><th></th></tr></thead>
            <tbody>
              ${list.map(
                (r) => html`<tr key=${r.id} class=${r.status === 'ignored' ? 'excluded' : ''}>
                  <td class="nowrap" data-label="Date">${longDate(r.date)}</td>
                  <td>
                    <div class="merchant">${r.sender ?? 'Unknown'}</div>
                    <div class="sub-desc">${r.method === 'zelle' ? 'Zelle' : r.method}${r.txnId ? '' : ' · recorded by you'}${r.note ? ` · ${r.note}` : ''}</div>
                  </td>
                  <td>
                    ${r.status === 'ignored'
                      ? html`<span class="badge">Not a reimbursement</span>`
                      : html`${r.allocations.map(
                          (a) => html`<div class="small" key=${a.billId}><a href=${`#/bills/${a.billId}`}>${billLabel(state, a.billId)}</a> · ${money(a.amountCents)}${a.auto ? html` <span class="badge">auto</span>` : null}</div>`,
                        )}
                        ${r.unallocatedCents > 0 ? html`<div class="small" style="color:var(--warn)">${money(r.unallocatedCents)} not matched</div>` : null}`}
                  </td>
                  <td class="amount" data-label="Amount"><${Money} cents=${r.amountCents} className="merchant" /></td>
                  <td style="width:40px">
                    <${Menu} class="btn ghost icon" label="⋯">
                      ${r.status === 'active' ? html`<button onClick=${() => setAllocating(r)}>Change statements…</button>` : html`<button onClick=${() => restore(r)}>It is a reimbursement</button>`}
                      ${r.status === 'active' && r.txnId ? html`<button onClick=${() => attempt(async () => refresh((await post(`/reimbursements/${r.id}`, { status: 'ignored' })).state))}>Not a reimbursement</button>` : null}
                      ${!r.txnId ? html`<button class="danger" onClick=${() => remove(r)}>Delete</button>` : null}
                    <//>
                  </td>
                </tr>`,
              )}
            </tbody>
          </table></div>`
        : html`<${Empty} title="No reimbursements yet" icon="⇄">When your company pays you back by Zelle, the payment shows up here after the next bank sync.<//>`}
      <div class="card-foot small muted">Received this year: <b>${money(state.dashboard.receivedYtdCents)}</b></div>
    </div>

    <${OtherDeposits} />

    <${AllocationDialog} open=${Boolean(allocating)} reimbursement=${allocating && state.reimbursements.find((r) => r.id === allocating.id)} onClose=${() => setAllocating(null)} />
    <${ManualReimbursementDialog} open=${adding} onClose=${() => setAdding(false)} />
  </div>`;
}
