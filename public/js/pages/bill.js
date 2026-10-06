import { html, useCallback, useEffect, useMemo, useState } from '../../vendor/preact.js';
import { download, get, post } from '../api.js';
import { centsToInput, localToday, longDate, money, parseCents, period, plural, shortDate } from '../format.js';
import { attempt, refresh, useStore } from '../store.js';
import { AsyncButton, Empty, Field, LoadingPage, Menu, Money, Pill, Tile } from '../ui.js';
import { ChargeRow, KeyboardHint, mergeTxns, useChargeActions, useChargeKeys } from '../components/charges.js';
import { statusLabel } from '../components/bills.js';
import { SendRequestDialog, businessCount, canRequest } from '../components/request.js';

function Step({ n, title, done, current, sub, children }) {
  return html`<div class=${`step ${done ? 'done' : ''} ${current ? 'current' : ''}`}>
    <div class="step-title"><span class="dot">${done ? '✓' : n}</span>${title}</div>
    <div class="step-sub">${sub}</div>
    ${children ? html`<div class="step-actions">${children}</div>` : null}
  </div>`;
}

function paidText(b, today) {
  const p = b.paid;
  if (b.isOpen) return 'After the statement closes';
  if (p.source === 'none-due') return 'No payment was due';
  if (p.paid) return `Paid ${p.paidOn ? shortDate(p.paidOn, today) : ''}${p.source === 'manual' ? ' (marked by you)' : ' (from your card payments)'}`;
  if (p.paidCents > 0) return `${money(p.paidCents)} of ${money(p.neededCents)} paid`;
  return p.neededCents ? `Statement balance ${money(p.neededCents)}${b.dueDate ? ` · due ${shortDate(b.dueDate, today)}` : ''}` : 'Card not paid yet';
}

function StatementDetails({ bill, onSaved }) {
  const [form, setForm] = useState({});
  useEffect(() => {
    setForm({
      end: bill.end,
      dueDate: bill.dueDate ?? '',
      stmtBalance: bill.explicitStmtBalanceCents !== null ? centsToInput(bill.explicitStmtBalanceCents) : '',
      note: bill.note ?? '',
    });
  }, [bill.id, bill.end, bill.dueDate, bill.explicitStmtBalanceCents, bill.note]);
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.value });
  const save = () =>
    attempt(async () => {
      const body = { note: form.note || null, dueDate: form.dueDate || null, stmtBalanceCents: form.stmtBalance === '' ? null : parseCents(form.stmtBalance) };
      if (form.end !== bill.end) body.end = form.end;
      onSaved(await post(`/bills/${bill.id}`, body));
    }, 'Statement updated.');
  return html`<div class="card">
    <div class="card-head"><h2>Statement details</h2></div>
    <div class="card-body stack">
      <div class="form-grid">
        <${Field} label="Closing date" hint="Change it if your statement closed on a different day. The next statement adjusts.">
          <input type="date" value=${form.end} onInput=${set('end')} />
        <//>
        <${Field} label="Payment due date" hint=${bill.dueDateSource === 'setting' ? 'From the card’s due day setting' : bill.dueDateSource === 'bank' ? 'From your bank' : ''}>
          <input type="date" value=${form.dueDate} onInput=${set('dueDate')} />
        <//>
        <${Field} label="Statement balance" hint=${bill.stmtSource === 'statement' ? 'From your statement' : `Estimated: ${money(bill.stmtBalanceCents)}. Enter it to be exact.`}>
          <input inputmode="decimal" placeholder=${centsToInput(bill.stmtBalanceCents)} value=${form.stmtBalance} onInput=${set('stmtBalance')} />
        <//>
      </div>
      <${Field} label="Note"><input value=${form.note} placeholder="e.g. Request sent to Dana in AP" onInput=${set('note')} /><//>
      <div><${AsyncButton} class="btn" onClick=${save}>Save details<//></div>
    </div>
  </div>`;
}

const FILTERS = [
  ['all', 'All'],
  ['business', 'Business'],
  ['personal', 'Personal'],
  ['review', 'To review'],
];
const inFilter = (t, filter) =>
  filter === 'all' || (filter === 'business' ? t.claim.claimCents !== 0 : filter === 'personal' ? t.claim.claimCents === 0 : !t.reviewed);
const searchable = (t) =>
  `${t.merchant ?? ''} ${t.description} ${t.rawDescription ?? ''} ${t.note ?? ''} ${t.category ?? ''} ${(Math.abs(t.amountCents) / 100).toFixed(2)}`.toLowerCase();

export function BillPage({ id }) {
  const { state } = useStore();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  // Charges you just changed stay in view even if they no longer match the filter.
  const [keep, setKeep] = useState(() => new Set());
  const [requestOpen, setRequestOpen] = useState(false);
  const rulesById = useMemo(() => new Map(state.rules.map((r) => [r.id, r])), [state.rules]);

  const load = useCallback(async () => {
    try {
      setDetail(await get(`/bills/${id}`));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [id]);
  useEffect(() => {
    setDetail(null);
    setFilter('all');
    setQ('');
    load();
  }, [id]);
  // Refresh after a bank sync.
  useEffect(() => {
    if (detail) load();
  }, [state?.lastSyncedAt]);
  useEffect(() => setKeep(new Set()), [filter, q, id]);

  const onUpdated = useCallback(
    (res) => {
      if (res?.bill) setDetail(res.bill);
      else load();
      if (res?.state) refresh(res.state);
      else refresh();
    },
    [load],
  );

  const { act, bulk, onRule, dialogs } = useChargeActions({
    scope: 'open',
    onTxns: (list) => setDetail((d) => d && { ...d, transactions: mergeTxns(d.transactions, list) }),
    onSaved: onUpdated,
    onRulesChanged: load,
    onFailed: load,
  });
  const actKeep = (t, what, value) => {
    setKeep((k) => (k.has(t.id) ? k : new Set(k).add(t.id)));
    return act(t, what, value);
  };

  const shown = useMemo(() => {
    if (!detail) return [];
    const needle = q.trim().toLowerCase();
    return detail.transactions.filter((t) => keep.has(t.id) || (inFilter(t, filter) && (!needle || searchable(t).includes(needle))));
  }, [detail, filter, q, keep]);
  const [focusId, setFocusId] = useChargeKeys(shown, actKeep);

  if (error) return html`<div class="callout danger">${error} <a href="#/bills">Back to statements</a></div>`;
  if (!detail) return html`<${LoadingPage} />`;

  const b = detail.bill;
  const today = state.today;
  const all = detail.transactions;
  const posted = all.filter((t) => !t.pending);
  const count = (f) => all.filter((t) => inFilter(t, f)).length;
  const unreviewed = shown.filter((t) => !t.reviewed);
  const steps = {
    closed: !b.isOpen,
    paid: b.paid.paid,
    submitted: Boolean(b.submittedOn) || b.status === 'reimbursed' || b.status === 'partial',
    reimbursed: b.status === 'reimbursed' || b.status === 'nothing',
  };
  const currentStep = ['closed', 'paid', 'submitted', 'reimbursed'].find((k) => !steps[k]);
  const patchBill = (body, msg) => attempt(async () => onUpdated(await post(`/bills/${b.id}`, body)), msg);
  const ids = shown.map((t) => t.id);
  const many = (payload, msg) => bulk({ ids, ...payload }, msg);

  return html`<div class="stack-lg">
    <div>
      <div class="breadcrumb"><a href="#/bills">Statements</a> / ${b.accountLabel}</div>
      <div class="page-head" style="margin-bottom:0">
        <div>
          <div class="row wrap"><h1>${period(b.start, b.end)}</h1><${Pill} status=${b.status} label=${statusLabel(b)} /></div>
          <p class="muted">
            ${b.isOpen ? `Current cycle — closes ${longDate(b.end)}` : `Closed ${longDate(b.end)}`}${b.dueDate ? ` · payment due ${longDate(b.dueDate)}` : ''}
          </p>
        </div>
        <div class="row wrap">
          <a class=${`btn ghost ${detail.prevBillId ? '' : 'hidden'}`} href=${`#/bills/${detail.prevBillId}`} title="Previous statement">←</a>
          <a class=${`btn ghost ${detail.nextBillId ? '' : 'hidden'}`} href=${`#/bills/${detail.nextBillId}`} title="Next statement">→</a>
          <${Menu} class="btn" label="Download ▾">
            <div class="menu-label">Request for your company</div>
            <button onClick=${() => attempt(() => download(`/export/bills/${b.id}?format=pdf`))}>PDF report</button>
            <button onClick=${() => attempt(() => download(`/export/bills/${b.id}?format=xlsx`))}>Excel (.xlsx)</button>
            <button onClick=${() => attempt(() => download(`/export/bills/${b.id}?format=csv`))}>CSV</button>
            <hr />
            <div class="menu-label">For your records (every charge + status)</div>
            <button onClick=${() => attempt(() => download(`/export/bills/${b.id}?format=xlsx&audience=tracking`))}>Tracking workbook (.xlsx)</button>
            <button onClick=${() => attempt(() => download(`/export/bills/${b.id}?format=csv&audience=tracking`))}>Tracking CSV</button>
          <//>
          ${!b.isOpen && b.claimCents > 0
            ? html`<button class=${`btn ${canRequest(b) ? 'primary' : ''}`} onClick=${() => setRequestOpen(true)}>${canRequest(b) ? 'Send request' : 'Request'}</button>`
            : null}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="steps">
        <${Step} n="1" title="Statement closed" done=${steps.closed} current=${currentStep === 'closed'} sub=${b.isOpen ? `Closes ${shortDate(b.end, today)}` : shortDate(b.end, today)} />
        <${Step} n="2" title="Card paid" done=${steps.paid} current=${currentStep === 'paid'} sub=${paidText(b, today)}>
          ${!b.isOpen && !b.paid.paid ? html`<button class="btn sm" onClick=${() => patchBill({ paidState: 'paid', paidOn: localToday() }, 'Marked as paid.')}>Mark card paid</button>` : null}
          ${b.paid.source === 'manual' ? html`<button class="btn sm ghost" onClick=${() => patchBill({ paidState: null }, 'Using detected payments again.')}>Undo</button>` : null}
          ${b.paid.paid && b.paid.source === 'auto' ? html`<button class="btn sm ghost" onClick=${() => patchBill({ paidState: 'unpaid' }, 'Marked as not paid.')}>Not paid?</button>` : null}
        <//>
        <${Step} n="3" title="Request sent" done=${steps.submitted} current=${currentStep === 'submitted'} sub=${b.submittedOn ? `Sent ${shortDate(b.submittedOn, today)}` : b.claimCents > 0 ? 'Not sent yet' : 'Nothing to request'}>
          ${canRequest(b) ? html`<button class="btn sm" onClick=${() => setRequestOpen(true)}>Send request</button>` : null}
          ${b.submittedOn ? html`<button class="btn sm ghost" onClick=${() => patchBill({ submittedOn: null }, 'Marked as not sent.')}>Undo</button>` : null}
        <//>
        <${Step}
          n="4"
          title="Reimbursed"
          done=${steps.reimbursed}
          current=${currentStep === 'reimbursed'}
          sub=${b.settledOn
            ? `Marked as reimbursed ${shortDate(b.settledOn, today)}${b.receivedCents ? ` · ${money(b.receivedCents)} matched` : ''}`
            : b.claimCents > 0
              ? `${money(b.receivedCents)} of ${money(b.claimCents)} received`
              : 'Nothing to reimburse'}
        >
          ${b.claimCents > b.receivedCents && steps.submitted && !b.settledOn ? html`<a class="btn sm" href="#/reimbursements">Match a payment</a>` : null}
          ${!b.isOpen && !b.settledOn && b.claimCents > b.receivedCents
            ? html`<button class="btn sm ghost" title="For statements you were paid back for outside this app, e.g. before you started using it" onClick=${() => patchBill({ settledOn: localToday() }, 'Marked as already reimbursed.')}>
                Already reimbursed
              </button>`
            : null}
          ${b.settledOn ? html`<button class="btn sm ghost" onClick=${() => patchBill({ settledOn: null }, 'It counts as owed again.')}>Undo</button>` : null}
        <//>
      </div>
    </div>

    <div class="tiles">
      <${Tile} label="Charges" value=${money(b.chargesCents + b.creditsCents)} sub=${plural(posted.length, 'charge')} />
      <${Tile} label="Personal" value=${money(b.excludedCents)} sub=${b.counts.excluded ? `${plural(b.counts.excluded, 'charge')} left out` : 'Nothing personal'} />
      <${Tile} accent label="To request" value=${money(b.claimCents)} sub=${plural(businessCount(b), 'business charge')} onClick=${b.isOpen || b.claimCents <= 0 ? undefined : () => setRequestOpen(true)} />
      <${Tile} label="Still owed" value=${money(Math.max(0, b.outstandingCents))} sub=${b.receivedCents ? `${money(b.receivedCents)} received` : 'Nothing received yet'} />
    </div>

    <div class="card">
      <div class="card-head">
        <div class="chips">
          ${FILTERS.map(([k, label]) => html`<button class=${`chip ${filter === k ? 'active' : ''}`} onClick=${() => setFilter(k)}>${label} ${count(k)}</button>`)}
        </div>
        <div class="row wrap">
          <input type="search" placeholder="Search…" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} style="width:180px" />
          ${unreviewed.length
            ? html`<${AsyncButton}
                class="btn sm"
                title="Keep the current choice for the charges you haven't touched (business unless marked otherwise) and mark them reviewed."
                onClick=${() => bulk({ ids: unreviewed.map((t) => t.id), reviewed: true }, `Confirmed ${plural(unreviewed.length, 'charge')}.`)}
              >
                ✓ Confirm the rest (${unreviewed.length})
              <//>`
            : null}
          ${(q || filter !== 'all') && shown.length
            ? html`<${Menu} class="btn sm" label=${`${shown.length} shown ▾`}>
                <button onClick=${() => many({ override: 'claim' }, `Business: ${plural(shown.length, 'charge')}.`)}>Business — all ${shown.length} shown</button>
                <button onClick=${() => many({ override: 'unclaim' }, `Personal: ${plural(shown.length, 'charge')}.`)}>Personal — all ${shown.length} shown</button>
                <button onClick=${() => many({ override: null }, 'Back to the default.')}>Back to the default</button>
              <//>`
            : null}
        </div>
      </div>
      ${shown.length
        ? html`<div class="cl-rows">
            ${shown.map(
              (t) => html`<${ChargeRow}
                key=${t.id}
                t=${t}
                today=${today}
                focused=${t.id === focusId}
                onFocus=${setFocusId}
                act=${actKeep}
                onRule=${onRule}
                rulesById=${rulesById}
                showStatementLink=${false}
              />`,
            )}
          </div>`
        : html`<${Empty} title=${all.length ? 'No matches' : 'No charges on this statement'}>${all.length ? 'Try another filter.' : ''}<//>`}
      <div class="card-foot small muted">Everything on this card is business unless you mark it personal. Notes appear on the request as the business purpose.</div>
    </div>
    ${shown.length ? html`<${KeyboardHint} />` : null}

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h2>Reimbursements for this statement</h2><a class="small" href="#/reimbursements">Manage →</a></div>
        ${b.allocations.length
          ? html`<ul class="list">
              ${b.allocations.map(
                (a) => html`<li key=${a.reimbursementId}>
                  <div class="grow"><div class="merchant">${a.sender ?? 'Payment'}</div><div class="sub-desc">${longDate(a.date)} · ${a.auto ? 'matched automatically' : 'applied by you'}</div></div>
                  <${Money} cents=${a.amountCents} className="merchant" />
                </li>`,
              )}
            </ul>`
          : html`<div class="card-body muted small">No money received for this statement yet. When your company pays exactly ${money(b.claimCents)}, the Zelle is matched here automatically.</div>`}
      </div>
      <div class="card">
        <div class="card-head"><h2>Card payments</h2></div>
        ${detail.payments.length
          ? html`<ul class="list">
              ${detail.payments.map(
                (p) => html`<li key=${p.id}><div class="grow"><div class="merchant">${p.description}</div><div class="sub-desc">${longDate(p.date)}</div></div><${Money} cents=${p.amountCents} /></li>`,
              )}
            </ul>`
          : html`<div class="card-body muted small">${b.isOpen ? 'Payments show up after the statement closes.' : 'No payments found after the closing date yet.'}</div>`}
      </div>
    </div>

    <${StatementDetails} bill=${b} onSaved=${onUpdated} />

    ${dialogs}
    <${SendRequestDialog} bill=${b} open=${requestOpen} onClose=${() => setRequestOpen(false)} onChanged=${onUpdated} />
  </div>`;
}
