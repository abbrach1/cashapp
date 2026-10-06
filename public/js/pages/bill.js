import { html, useCallback, useEffect, useMemo, useState } from '../../vendor/preact.js';
import { download, get, post } from '../api.js';
import { centsToInput, localToday, longDate, money, parseCents, period, plural, shortDate } from '../format.js';
import { attempt, refresh, useStore } from '../store.js';
import { AsyncButton, Empty, Field, LoadingPage, Menu, Modal, Money, Pill, Tile } from '../ui.js';
import { TxnTable } from '../components/txns.js';
import { statusLabel } from '../components/bills.js';

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
  if (p.paid) return `Paid ${p.paidOn ? shortDate(p.paidOn, today) : ''}${p.source === 'manual' ? ' (marked by you)' : ' (from card payments)'}`;
  if (p.paidCents > 0) return `${money(p.paidCents)} of ${money(p.neededCents)} paid`;
  return p.neededCents ? `Statement balance ${money(p.neededCents)}${b.dueDate ? ` · due ${shortDate(b.dueDate, today)}` : ''}` : 'Not paid yet';
}

function mailtoLink(settings, bill, detail) {
  const count = detail.transactions.filter((t) => t.claim.claimCents !== 0 && !t.pending).length;
  const subject = `Expense report: ${bill.accountLabel} statement ${period(bill.start, bill.end)} (${money(bill.claimCents)})`;
  const lines = [
    'Hi,',
    '',
    `Attached is my expense report for my ${bill.accountLabel} statement ${period(bill.start, bill.end)}: ${plural(count, 'item')} totaling ${money(bill.claimCents)}.`,
    settings.zelleHandle ? `Please reimburse via Zelle to ${settings.zelleHandle}.` : '',
    '',
    'Thanks,',
    settings.yourName || '',
  ];
  return `mailto:${encodeURIComponent(settings.companyEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
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
      <${Field} label="Note"><input value=${form.note} placeholder="e.g. Report sent to Dana in AP" onInput=${set('note')} /><//>
      <div><${AsyncButton} class="btn" onClick=${save}>Save details<//></div>
    </div>
  </div>`;
}

export function BillPage({ id }) {
  const { state } = useStore();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [includePersonal, setIncludePersonal] = useState(false);
  const [sentPrompt, setSentPrompt] = useState(false);

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

  const onUpdated = useCallback(
    (res) => {
      if (res?.bill) setDetail(res.bill);
      else load();
      if (res?.state) refresh(res.state);
      else refresh();
    },
    [load],
  );

  const shown = useMemo(() => {
    if (!detail) return [];
    const needle = q.trim().toLowerCase();
    return detail.transactions.filter((t) => {
      if (filter === 'claimed' && t.claim.claimCents === 0) return false;
      if (filter === 'excluded' && t.claim.claimCents !== 0) return false;
      if (!needle) return true;
      return `${t.merchant ?? ''} ${t.description} ${t.rawDescription ?? ''} ${t.note ?? ''} ${t.category ?? ''} ${(Math.abs(t.amountCents) / 100).toFixed(2)}`.toLowerCase().includes(needle);
    });
  }, [detail, filter, q]);

  if (error) return html`<div class="callout danger">${error} <a href="#/bills">Back to statements</a></div>`;
  if (!detail) return html`<${LoadingPage} />`;

  const b = detail.bill;
  const today = state.today;
  const settings = state.settings;
  const posted = detail.transactions.filter((t) => !t.pending);
  const unreviewedCount = posted.filter((t) => t.claim.applicable && !t.reviewed).length;
  const claimedCount = posted.filter((t) => t.claim.claimCents !== 0).length;
  const excludedCount = posted.length - claimedCount;
  const pdfPath = `/export/bills/${b.id}?format=pdf${includePersonal ? '&personal=1' : ''}`;
  const steps = {
    closed: !b.isOpen,
    paid: b.paid.paid,
    submitted: Boolean(b.submittedOn) || b.status === 'reimbursed' || b.status === 'partial',
    reimbursed: b.status === 'reimbursed' || b.status === 'nothing',
  };
  const currentStep = ['closed', 'paid', 'submitted', 'reimbursed'].find((k) => !steps[k]);

  const patchBill = (body, msg) => attempt(async () => onUpdated(await post(`/bills/${b.id}`, body)), msg);
  const bulk = (override) =>
    attempt(
      async () => onUpdated(await post('/transactions/bulk', { ids: shown.map((t) => t.id), override })),
      override === 'claim' ? `Claiming ${plural(shown.length, 'transaction')}.` : `Excluded ${plural(shown.length, 'transaction')}.`,
    );
  const sendToCompany = () =>
    attempt(async () => {
      await download(pdfPath);
      if (settings.companyEmail) window.location.href = mailtoLink(settings, b, detail);
      setSentPrompt(true);
    });

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
            <div class="menu-label">Report for your company</div>
            <button onClick=${() => attempt(() => download(pdfPath))}>PDF report</button>
            <button onClick=${() => attempt(() => download(`/export/bills/${b.id}?format=xlsx${includePersonal ? '&personal=1' : ''}`))}>Excel (.xlsx)</button>
            <button onClick=${() => attempt(() => download(`/export/bills/${b.id}?format=csv${includePersonal ? '&personal=1' : ''}`))}>CSV</button>
            <hr />
            <div class="menu-label">For your records (all transactions + status)</div>
            <button onClick=${() => attempt(() => download(`/export/bills/${b.id}?format=xlsx&audience=tracking`))}>Tracking workbook (.xlsx)</button>
            <button onClick=${() => attempt(() => download(`/export/bills/${b.id}?format=csv&audience=tracking`))}>Tracking CSV</button>
          <//>
          ${!b.submittedOn && !b.isOpen && b.claimCents > 0
            ? html`<${AsyncButton} class="btn primary" onClick=${sendToCompany}>${settings.companyEmail ? 'Email report to company' : 'Download report to send'}<//>`
            : null}
        </div>
      </div>
      <label class="check small muted" style="margin-top:8px">
        <input type="checkbox" checked=${includePersonal} onChange=${(e) => setIncludePersonal(e.currentTarget.checked)} />
        Also list personal (not claimed) items in the company report, marked "not claimed"
      </label>
    </div>

    <div class="card">
      <div class="steps">
        <${Step} n="1" title="Statement closed" done=${steps.closed} current=${currentStep === 'closed'} sub=${b.isOpen ? `Closes ${shortDate(b.end, today)}` : shortDate(b.end, today)} />
        <${Step} n="2" title="Card paid" done=${steps.paid} current=${currentStep === 'paid'} sub=${paidText(b, today)}>
          ${!b.isOpen && !b.paid.paid ? html`<button class="btn sm" onClick=${() => patchBill({ paidState: 'paid', paidOn: localToday() }, 'Marked as paid.')}>Mark paid</button>` : null}
          ${b.paid.source === 'manual' ? html`<button class="btn sm ghost" onClick=${() => patchBill({ paidState: null }, 'Using detected payments again.')}>Undo</button>` : null}
          ${b.paid.paid && b.paid.source === 'auto' ? html`<button class="btn sm ghost" onClick=${() => patchBill({ paidState: 'unpaid' }, 'Marked as not paid.')}>Not paid?</button>` : null}
        <//>
        <${Step} n="3" title="Sent to company" done=${steps.submitted} current=${currentStep === 'submitted'} sub=${b.submittedOn ? `Sent ${shortDate(b.submittedOn, today)}` : b.claimCents > 0 ? 'Not sent yet' : 'Nothing to send'}>
          ${!b.submittedOn && b.claimCents > 0 && !b.isOpen ? html`<button class="btn sm" onClick=${() => patchBill({ submittedOn: localToday() }, 'Marked as submitted.')}>Mark sent</button>` : null}
          ${b.submittedOn ? html`<button class="btn sm ghost" onClick=${() => patchBill({ submittedOn: null }, 'Marked as not submitted.')}>Undo</button>` : null}
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
      <${Tile} label="Charges & credits" value=${money(b.chargesCents + b.creditsCents)} sub=${plural(posted.length, 'transaction')} />
      <${Tile} label="Not claimed" value=${money(b.excludedCents)} sub=${excludedCount ? `${plural(excludedCount, 'item')} personal or excluded` : 'Everything is claimed'} />
      <${Tile} accent label="To claim" value=${money(b.claimCents)} sub=${plural(claimedCount, 'item')} />
      <${Tile} label="Still owed" value=${money(Math.max(0, b.outstandingCents))} sub=${b.receivedCents ? `${money(b.receivedCents)} received` : 'Nothing received yet'} />
    </div>

    <div class="card">
      <div class="card-head">
        <div class="chips">
          ${[
            ['all', `All ${posted.length}`],
            ['claimed', `Claimed ${claimedCount}`],
            ['excluded', `Not claimed ${excludedCount}`],
          ].map(([k, label]) => html`<button class=${`chip ${filter === k ? 'active' : ''}`} onClick=${() => setFilter(k)}>${label}</button>`)}
        </div>
        <div class="row">
          <input type="search" placeholder="Search…" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} style="width:180px" />
          ${(q || filter !== 'all') && shown.length
            ? html`<${Menu} class="btn sm" label=${`${shown.length} shown ▾`}>
                <button onClick=${() => bulk('claim')}>Claim all shown</button>
                <button onClick=${() => bulk('unclaim')}>Exclude all shown</button>
                <button onClick=${() => bulk(null)}>Reset shown to default</button>
              <//>`
            : null}
        </div>
      </div>
      <${TxnTable}
        transactions=${shown}
        today=${today}
        rules=${state.rules}
        onUpdated=${onUpdated}
        empty=${html`<${Empty} title=${detail.transactions.length ? 'No matches' : 'No transactions on this statement'}>${detail.transactions.length ? 'Try another filter.' : ''}<//>`}
      />
      <div class="card-foot small muted spread">
        <span>Switch off anything personal. Everything else on this card is claimed. Notes appear on the company report as the business purpose.</span>
        ${unreviewedCount && !b.submittedOn && !b.settledOn
          ? html`<a class="nowrap" href=${`#/classify?bill=${b.id}`}>Review ${plural(unreviewedCount, 'transaction')} one by one →</a>`
          : null}
      </div>
    </div>

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
          : html`<div class="card-body muted small">No money received for this statement yet. Zelle payments from your company are matched automatically when the amount fits.</div>`}
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

    <${Modal}
      open=${sentPrompt}
      onClose=${() => setSentPrompt(false)}
      title="Did you send the report?"
      footer=${html`<button class="btn" onClick=${() => setSentPrompt(false)}>Not yet</button>
        <${AsyncButton} class="btn primary" onClick=${async () => {
          await patchBill({ submittedOn: localToday() }, 'Marked as submitted.');
          setSentPrompt(false);
        }}>Yes, mark as submitted<//>`}
    >
      <p style="margin-top:0">The PDF report was downloaded${settings.companyEmail ? ' and an email draft opened' : ''}. Attach the PDF, send it, then mark this statement as submitted so you can track the reimbursement.</p>
      ${!settings.companyEmail ? html`<p class="small muted">Tip: add your company's expenses email in <a href="#/settings">Settings</a> to get a ready-to-send email draft.</p>` : null}
    <//>
  </div>`;
}
