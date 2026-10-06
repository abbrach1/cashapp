import { html } from '../../vendor/preact.js';
import { navigate } from '../router.js';
import { period, shortDate } from '../format.js';
import { Money, Pill, Progress } from '../ui.js';

export function billSub(b, today) {
  if (b.status === 'open') return `Closes ${shortDate(b.end, today)}`;
  if (b.status === 'unpaid') return b.dueDate ? `Due ${shortDate(b.dueDate, today)}` : 'Not paid yet';
  if (b.status === 'ready') return b.paid.paidOn ? `Paid ${shortDate(b.paid.paidOn, today)}` : 'Paid';
  if (b.status === 'submitted') return `Submitted ${shortDate(b.submittedOn, today)}`;
  if (b.status === 'partial') return `Waiting on the rest`;
  return '';
}

/** "Marked reimbursed" when you said so yourself rather than a payment covering it. */
export function statusLabel(b) {
  return b.status === 'reimbursed' && b.settledOn && b.receivedCents < b.claimCents ? 'Marked reimbursed' : undefined;
}

export function BillsTable({ bills, today, showCard = true, compact = false }) {
  return html`<div class="table-wrap">
    <table class="data stack-mobile">
      <thead>
        <tr>
          <th>Statement</th>
          <th class="amount">To claim</th>
          ${compact ? null : html`<th class="amount hide-mobile">Received</th>`}
          <th class="amount">Still owed</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${bills.map(
          (b) => html`<tr key=${b.id} class="clickable" onClick=${() => navigate(`/bills/${b.id}`)}>
            <td data-label="Statement">
              ${showCard ? html`<div class="merchant">${b.accountLabel}</div>` : null}
              <a class="nowrap" href=${`#/bills/${b.id}`} onClick=${(e) => e.stopPropagation()}>${period(b.start, b.end)}</a>
              <span class="sub-desc"> · ${billSub(b, today) || 'Closed'}</span>
            </td>
            <td class="amount" data-label="To claim"><${Money} cents=${b.claimCents} /></td>
            ${compact
              ? null
              : html`<td class="amount hide-mobile">
                  <${Money} cents=${b.receivedCents} />
                  ${b.claimCents > 0 && b.receivedCents > 0 ? html`<${Progress} value=${b.receivedCents} max=${b.claimCents} />` : null}
                </td>`}
            <td class="amount" data-label="Still owed">${b.status === 'open' || b.status === 'nothing' ? html`<span class="muted">—</span>` : html`<${Money} cents=${Math.max(0, b.outstandingCents)} />`}</td>
            <td><${Pill} status=${b.status} label=${statusLabel(b)} /></td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}
