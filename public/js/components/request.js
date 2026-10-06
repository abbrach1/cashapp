// One reimbursement request per statement: its own total, report and email.

import { html, useState } from '../../vendor/preact.js';
import { download, post } from '../api.js';
import { centsToInput, localToday, longDate, money, period, plural } from '../format.js';
import { attempt, refresh, useStore } from '../store.js';
import { AsyncButton, Modal, copyText } from '../ui.js';

/** Statements you can send a request for: closed, not sent, something to claim. */
export const canRequest = (b) => !b.isOpen && b.claimCents > 0 && !b.submittedOn && !['reimbursed', 'partial', 'nothing'].includes(b.status);

export const businessCount = (b) => b.counts.claimed + b.counts.partial;

export function requestSubject(b) {
  return `Expense reimbursement request: ${b.accountLabel} statement ${period(b.start, b.end)} (${money(b.claimCents)})`;
}

export function requestMessage(settings, b) {
  const lines = [
    'Hi,',
    '',
    `Attached is my expense reimbursement request for my ${b.accountLabel} statement ${period(b.start, b.end)}: ${plural(businessCount(b), 'business charge')}, total ${money(b.claimCents)}.`,
  ];
  if (settings.zelleHandle) lines.push(`Please send it by Zelle to ${settings.zelleHandle}.`);
  lines.push('', 'Thanks,');
  if (settings.yourName) lines.push(settings.yourName);
  return lines.join('\n');
}

/**
 * Everything needed to send one statement's request. `bill` is a statement as
 * in state.bills; `onChanged(response)` runs after marking it sent or not.
 */
export function SendRequestDialog({ bill: b, open, onClose, onChanged }) {
  const { state } = useStore();
  const [personal, setPersonal] = useState(false);
  if (!b) return null;
  const s = state.settings;
  const extra = personal ? '&personal=1' : '';
  const get = (format) => attempt(() => download(`/export/bills/${b.id}?format=${format}${extra}`));
  const email = () => {
    window.location.href = `mailto:${encodeURIComponent(s.companyEmail)}?subject=${encodeURIComponent(requestSubject(b))}&body=${encodeURIComponent(requestMessage(s, b))}`;
  };
  const markSent = (on) =>
    attempt(
      async () => {
        const res = await post(`/bills/${b.id}`, { submittedOn: on ? localToday() : null });
        refresh(res.state);
        onChanged?.(res);
      },
      on ? 'Marked as sent. The Zelle that pays it is matched automatically.' : 'Marked as not sent.',
    );

  return html`<${Modal}
    open=${open}
    onClose=${onClose}
    title="Send request"
    footer=${html`<button class="btn" onClick=${onClose}>Done</button>`}
  >
    <div class="stack">
      <div class="request-total">
        <div class="grow">
          <div class="small muted">${b.accountLabel} · statement ${period(b.start, b.end)}</div>
          <div class="request-amount">${money(b.claimCents)}</div>
          <div class="small muted">
            ${plural(businessCount(b), 'business charge')}${b.excludedCents ? ` · ${money(b.excludedCents)} personal left out` : ''}
          </div>
        </div>
        <button class="btn sm" onClick=${() => copyText(centsToInput(b.claimCents), `Copied ${money(b.claimCents)}.`)}>Copy total</button>
      </div>
      ${b.status === 'unpaid' ? html`<div class="callout small">This card statement isn't paid yet. If your company wants requests after you pay, pay it first.</div>` : null}
      <ol class="request-steps">
        <li>
          <b>Download the report</b>
          <div class="row wrap">
            <${AsyncButton} class="btn sm primary" onClick=${() => get('pdf')}>PDF<//>
            <${AsyncButton} class="btn sm" onClick=${() => get('xlsx')}>Excel<//>
            <${AsyncButton} class="btn sm" onClick=${() => get('csv')}>CSV<//>
          </div>
          <label class="check small muted"><input type="checkbox" checked=${personal} onChange=${(e) => setPersonal(e.currentTarget.checked)} /> Also list the personal charges, marked “not claimed”</label>
        </li>
        <li>
          <b>Send it to your company</b>
          <div class="row wrap">
            ${s.companyEmail ? html`<button class="btn sm" onClick=${email}>Email ${s.companyEmail}</button>` : null}
            <button class="btn sm" onClick=${() => copyText(`${requestSubject(b)}\n\n${requestMessage(s, b)}`, 'Message copied.')}>Copy message</button>
          </div>
          <div class="tiny muted">
            ${s.companyEmail ? 'Attach the PDF you downloaded.' : html`Add your company's expenses email in <a href="#/settings">Settings</a> to get a ready-made email.`}
          </div>
        </li>
        <li>
          <b>Mark it as sent</b>
          ${b.submittedOn
            ? html`<div class="row wrap"><span class="small">Sent ${longDate(b.submittedOn)}</span><${AsyncButton} class="btn sm ghost" onClick=${() => markSent(false)}>Undo<//></div>`
            : html`<div><${AsyncButton} class="btn sm" onClick=${() => markSent(true)}>Mark request as sent<//></div>`}
          <div class="tiny muted">When the company pays exactly ${money(b.claimCents)}, the Zelle is matched to this statement automatically.</div>
        </li>
      </ol>
    </div>
  <//>`;
}

/** Holds which statement's request is open; renders the dialog for it. */
export function useSendRequest(onChanged) {
  const { state } = useStore();
  const [billId, setBillId] = useState(null);
  const bill = billId ? state.bills.find((b) => b.id === billId) : null;
  const dialog = html`<${SendRequestDialog} bill=${bill} open=${Boolean(bill)} onClose=${() => setBillId(null)} onChanged=${onChanged} />`;
  return [setBillId, dialog];
}
