import { html, useEffect, useState } from '../../vendor/preact.js';
import { post } from '../api.js';
import { money, REASON, shortDate } from '../format.js';
import { attempt } from '../store.js';
import { Menu, Money, Toggle } from '../ui.js';
import { PartialDialog, RuleDialog } from './dialogs.js';

function ReasonBadge({ t, rulesById }) {
  const reason = t.claim.reason;
  if (!reason || reason === 'default') return null;
  let label = REASON[reason] ?? reason;
  let cls = 'badge';
  if (reason === 'rule') {
    const rule = rulesById?.get(t.claim.ruleId);
    label = rule ? `Rule: ${rule.pattern}` : 'Rule';
  }
  if (reason === 'fee' || reason === 'reward') cls = 'badge warn';
  if (reason === 'partial' || reason === 'included') cls = 'badge info';
  const title = {
    fee: 'Card fees and interest are excluded by default (Settings). Switch on to claim it.',
    reward: 'Rewards redemptions are excluded by default (Settings).',
    rule: 'Excluded by an "always exclude" rule (Settings → Rules).',
    excluded: 'You marked this as personal.',
  }[reason];
  return html`<span class=${cls} title=${title}>${label}</span>`;
}

function NoteInput({ t, onSave }) {
  const [value, setValue] = useState(t.note ?? '');
  useEffect(() => setValue(t.note ?? ''), [t.note]);
  const commit = () => {
    const next = value.trim();
    if (next === (t.note ?? '')) return;
    onSave(next || null);
  };
  return html`<input
    class="note-input"
    placeholder="Add business purpose…"
    value=${value}
    maxlength="500"
    aria-label="Note"
    onInput=${(e) => setValue(e.currentTarget.value)}
    onBlur=${commit}
    onKeyDown=${(e) => {
      if (e.key === 'Enter') e.currentTarget.blur();
      if (e.key === 'Escape') {
        setValue(t.note ?? '');
        e.currentTarget.blur();
      }
    }}
  />`;
}

/** Second line under the merchant, unless it just repeats the merchant. */
function subLine(t) {
  const title = (t.merchant ?? t.description ?? '').trim().toLowerCase();
  for (const candidate of [t.rawDescription, t.description]) {
    if (candidate && candidate.trim().toLowerCase() !== title) return candidate;
  }
  return null;
}

function TxnRow({ t, today, onUpdated, onPartial, onRule, rulesById, extraColumns }) {
  const [optimistic, setOptimistic] = useState(null);
  const claimed = t.claim.claimCents !== 0;
  const checked = optimistic ?? claimed;
  const update = (body, success) =>
    attempt(async () => {
      const res = await post(`/transactions/${t.id}`, body);
      onUpdated(res);
      return res;
    }, success);
  const toggle = async (on) => {
    setOptimistic(on);
    await update({ override: on ? 'claim' : 'unclaim' });
    setOptimistic(null);
  };
  const applicable = t.claim.applicable;
  const excluded = applicable && !checked;
  return html`<tr class=${`${excluded ? 'excluded' : ''} ${t.pending ? 'pending' : ''}`}>
    <td class="c-claim" style="width:46px">
      ${applicable
        ? html`<${Toggle} checked=${checked} label=${checked ? 'Claimed – click to exclude' : 'Not claimed – click to claim'} onChange=${toggle} />`
        : html`<span class="muted" title=${t.kind === 'payment' ? 'Card payments are not expenses' : 'Not an expense card'}>—</span>`}
    </td>
    <td class="nowrap c-date">${shortDate(t.authDate ?? t.date, today)}</td>
    <td class="c-merchant">
      <div class="merchant">${t.merchant ?? t.description} ${t.pending ? html`<span class="badge">Pending</span>` : null}</div>
      ${subLine(t) ? html`<div class="sub-desc">${subLine(t)}</div>` : null}
      <div class="sub-desc show-mobile">${shortDate(t.authDate ?? t.date, today)}</div>
      <div class="row wrap" style="gap:4px;margin-top:2px">
        <${ReasonBadge} t=${t} rulesById=${rulesById} />
        ${t.category ? html`<span class="tiny muted hide-mobile">${t.category}</span>` : null}
      </div>
    </td>
    ${extraColumns?.(t)}
    <td class="amount c-amount">
      <div class="charged"><${Money} cents=${t.amountCents} /></div>
      ${t.claim.status === 'partial' ? html`<div class="tiny" style="color:var(--info)">claiming ${money(t.claim.claimCents)}</div>` : null}
    </td>
    <td class="c-note" style="min-width:170px"><${NoteInput} t=${t} onSave=${(note) => update({ note })} /></td>
    <td class="c-menu" style="width:40px">
      ${applicable
        ? html`<${Menu} class="btn ghost icon" label="⋯" title="More">
            <button onClick=${() => onPartial(t)}>Claim part of it…</button>
            <button onClick=${() => onRule(t)}>Always exclude "${(t.merchant ?? t.description).slice(0, 24)}"…</button>
            ${t.override ? html`<button onClick=${() => update({ override: null }, 'Back to the default.')}>Reset to default</button>` : null}
          <//>`
        : null}
    </td>
  </tr>`;
}

/**
 * Transaction list with claim switches, notes and per-row actions.
 * `onUpdated(response)` receives the server response after each change.
 */
export function TxnTable({ transactions, today, onUpdated, rules, extraHead, extraColumns, empty }) {
  const [partialFor, setPartialFor] = useState(null);
  const [ruleFor, setRuleFor] = useState(null);
  const rulesById = new Map((rules ?? []).map((r) => [r.id, r]));
  if (!transactions.length) return empty ?? html`<div class="empty">No transactions.</div>`;
  return html`<div class="table-wrap">
      <table class="data txn-table">
        <thead>
          <tr>
            <th title="Claim from company">Claim</th>
            <th>Date</th>
            <th>Merchant</th>
            ${extraHead}
            <th class="amount">Amount</th>
            <th>Business purpose</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${transactions.map(
            (t) => html`<${TxnRow}
              key=${t.id}
              t=${t}
              today=${today}
              rulesById=${rulesById}
              onUpdated=${onUpdated}
              onPartial=${setPartialFor}
              onRule=${setRuleFor}
              extraColumns=${extraColumns}
            />`,
          )}
        </tbody>
      </table>
    </div>
    <${PartialDialog} open=${Boolean(partialFor)} txn=${partialFor} onClose=${() => setPartialFor(null)} onSaved=${onUpdated} />
    <${RuleDialog}
      open=${Boolean(ruleFor)}
      initialPattern=${ruleFor ? (ruleFor.merchant ?? ruleFor.description).toUpperCase().replace(/\s+\S*\d\S*$/, '').slice(0, 30) : ''}
      onClose=${(created) => {
        setRuleFor(null);
        if (created) onUpdated({});
      }}
    />`;
}
