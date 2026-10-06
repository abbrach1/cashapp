// Sorting card charges into business and personal. The Classify page and every
// statement page use these, so it looks and works the same everywhere.

import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { post } from '../api.js';
import { money, shortDate } from '../format.js';
import { navigate } from '../router.js';
import { attempt, toast } from '../store.js';
import { Menu, Money } from '../ui.js';
import { PartialDialog, RuleDialog } from './dialogs.js';

const CHOICE = { claimed: 'business', excluded: 'personal', partial: 'split' };
export const choiceOf = (t) => CHOICE[t.claim.status] ?? 'business';

const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

/** Why a charge is personal without you choosing it. */
function reasonHint(t, rulesById) {
  if (t.claim.reason === 'rule') return `Always personal: “${rulesById?.get(t.claim.ruleId)?.pattern ?? 'rule'}”`;
  if (t.claim.reason === 'fee') return 'Card fee: personal unless you mark it business';
  if (t.claim.reason === 'reward') return 'Rewards credit: personal unless you mark it business';
  return null;
}

/** Second line under the merchant, unless it just repeats the merchant. */
export function subLine(t) {
  const title = (t.merchant ?? t.description ?? '').trim().toLowerCase();
  for (const candidate of [t.rawDescription, t.description]) {
    if (candidate && candidate.trim().toLowerCase() !== title) return candidate;
  }
  return null;
}

export function NoteInput({ t, onSave }) {
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
    aria-label="Business purpose"
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

export function ChargeRow({ t, today, focused, onFocus, act, onRule, rulesById, showStatementLink = true }) {
  const choice = choiceOf(t);
  const name = t.merchant ?? t.description;
  const short = name.length > 22 ? `${name.slice(0, 22)}…` : name;
  const hint = reasonHint(t, rulesById);
  const pick = (what) => (e) => {
    e.stopPropagation();
    onFocus(t.id);
    act(t, what);
  };
  const button = (what, label, key) =>
    html`<button
      type="button"
      class=${choice === what ? 'on' : ''}
      aria-pressed=${choice === what}
      title=${`${label} (${key})${choice === what && !t.reviewed ? ' — the default; click to confirm' : ''}`}
      onClick=${pick(what)}
    >
      ${label}
    </button>`;
  return html`<div
    class=${`cl-row ${choice} ${t.reviewed ? 'is-reviewed' : 'is-new'} ${t.pending ? 'is-pending' : ''} ${focused ? 'focused' : ''}`}
    data-id=${t.id}
    onClick=${() => onFocus(t.id)}
  >
    <span class="cl-dot" title=${t.reviewed ? 'Reviewed' : 'Not reviewed yet'}>${t.reviewed ? '✓' : ''}</span>
    <span class="cl-date nowrap small">${shortDate(t.authDate ?? t.date, today)}</span>
    <div class="cl-merchant">
      <div class="merchant">${name}${t.pending ? html` <span class="badge">Pending</span>` : null}</div>
      <div class="sub-desc">
        <span class="show-mobile-inline">${shortDate(t.authDate ?? t.date, today)} · </span>${hint ?? [t.category, subLine(t)].filter(Boolean).join(' · ')}
      </div>
    </div>
    <div class="cl-amount">
      <${Money} cents=${t.amountCents} />
      ${choice === 'split' ? html`<div class="tiny" style="color:var(--info)">business ${money(t.claim.claimCents)}</div>` : null}
    </div>
    <div class="seg" role="group" aria-label="Business or personal">
      ${button('business', 'Business', 'B')} ${button('personal', 'Personal', 'P')} ${button('split', 'Split', 'S')}
    </div>
    <div class="cl-note" onClick=${(e) => e.stopPropagation()}>
      <${NoteInput} t=${t} onSave=${(note) => act(t, 'note', note)} />
    </div>
    <div class="cl-menu" onClick=${(e) => e.stopPropagation()}>
      <${Menu} class="btn ghost icon sm" label="⋯" title="More">
        ${t.similarCount > 1
          ? html`<div class="menu-label">All ${t.similarCount} from ${short}</div>
              <button onClick=${() => act(t, 'similar-business')}>Business — all ${t.similarCount}</button>
              <button onClick=${() => act(t, 'similar-personal')}>Personal — all ${t.similarCount}</button>
              <hr />`
          : null}
        <button onClick=${() => onRule(t)}>Always personal: “${short}”…</button>
        ${t.override ? html`<button onClick=${() => act(t, 'reset')}>Back to the default</button>` : null}
        ${showStatementLink && t.billId ? html`<button onClick=${() => navigate(`/bills/${t.billId}`)}>Open statement</button>` : null}
      <//>
    </div>
  </div>`;
}

/** What a row looks like right after a click, before the server answers. */
function optimistic(t, what) {
  if (what === 'business') return { ...t, reviewed: true, claim: { ...t.claim, status: 'claimed', claimCents: t.amountCents } };
  if (what === 'personal') return { ...t, reviewed: true, claim: { ...t.claim, status: 'excluded', claimCents: 0 } };
  return t;
}

const BODIES = {
  business: { override: 'claim' },
  personal: { override: 'unclaim' },
  reset: { override: null },
};

/**
 * Business / personal / split / note actions on charges, sent one at a time
 * and in order so quick clicks never arrive out of order.
 *   onTxns(list)      put the server's version of these rows in place
 *   onSaved(response) every response (fresh totals and app state)
 *   onRulesChanged()  after an "always personal" rule was added
 *   onFailed()        after an error (reload to undo the optimistic change)
 */
export function useChargeActions({ scope = 'open', onTxns, onSaved, onRulesChanged, onFailed }) {
  const [splitFor, setSplitFor] = useState(null);
  const [ruleFor, setRuleFor] = useState(null);
  const queue = useRef(Promise.resolve());
  const enqueue = (fn) => {
    queue.current = queue.current.then(fn).catch((err) => toast(err?.message || 'Something went wrong', 'error', 6000));
    return queue.current;
  };

  /** Change many charges (resolves to the response, or undefined on error). */
  const bulk = (payload, message) =>
    enqueue(async () => {
      const res = await attempt(() => post('/transactions/bulk', { scope, ...payload }), message);
      if (!res) return onFailed?.();
      onTxns(res.transactions);
      onSaved?.(res);
      return res;
    });

  const act = (t, what, value) => {
    if (what === 'split') return setSplitFor(t);
    if (what === 'similar-business' || what === 'similar-personal') {
      const personal = what === 'similar-personal';
      return bulk(
        { similarTo: t.id, override: personal ? 'unclaim' : 'claim' },
        (res) => `${personal ? 'Personal' : 'Business'}: ${res.changed === 1 ? '1 charge' : `${res.changed} charges`} from ${t.merchant ?? t.description}.`,
      );
    }
    const body = what === 'note' ? { note: value, reviewed: true } : BODIES[what];
    if (!body) return undefined;
    if (what === 'business' || what === 'personal') onTxns([optimistic(t, what)]);
    return enqueue(async () => {
      const res = await attempt(() => post(`/transactions/${t.id}`, body));
      if (!res) return onFailed?.();
      onTxns([res.transaction]);
      onSaved?.(res);
    });
  };

  const dialogs = html`<${PartialDialog}
      open=${Boolean(splitFor)}
      txn=${splitFor}
      onClose=${() => setSplitFor(null)}
      onSaved=${(res) => {
        onTxns([res.transaction]);
        onSaved?.(res);
      }}
    />
    <${RuleDialog}
      open=${Boolean(ruleFor)}
      initialPattern=${ruleFor ? (ruleFor.merchant ?? ruleFor.description).toUpperCase().replace(/\s+\S*\d\S*$/, '').slice(0, 30) : ''}
      onClose=${(created) => {
        setRuleFor(null);
        if (created) onRulesChanged?.();
      }}
    />`;

  return { act, bulk, enqueue, onRule: setRuleFor, dialogs };
}

/**
 * Keyboard: J/K or arrows to move, B business, P personal, S split, N note.
 * Returns [focusedId, setFocusedId].
 */
export function useChargeKeys(rows, act) {
  const [focusId, setFocusId] = useState(null);
  const current = useRef({});
  current.current = { rows, focusId, act };
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector('dialog[open]')) return;
      const { rows: list, focusId: id, act: run } = current.current;
      if (!list.length) return;
      const idx = list.findIndex((t) => t.id === id);
      const row = idx >= 0 ? list[idx] : null;
      const moveTo = (i) => setFocusId(list[Math.max(0, Math.min(list.length - 1, i))].id);
      const key = e.key.toLowerCase();
      if (key === 'j' || (e.key === 'ArrowDown' && row)) moveTo(idx + 1);
      else if (key === 'k' || (e.key === 'ArrowUp' && row)) moveTo(idx < 0 ? 0 : idx - 1);
      else if ((key === 'b' || key === 'p') && row) {
        run(row, key === 'b' ? 'business' : 'personal');
        moveTo(idx + 1);
      } else if (key === 's' && row) run(row, 'split');
      else if (key === 'n' && row) document.querySelector(`.cl-row[data-id="${row.id}"] .note-input`)?.focus();
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (focusId) document.querySelector(`.cl-row[data-id="${focusId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focusId]);
  return [focusId, setFocusId];
}

/** Put the server's version of these rows into a list (rows keep their place). */
export function mergeTxns(rows, updated) {
  if (!updated?.length) return rows;
  const byId = new Map(updated.map((t) => [t.id, t]));
  if (!rows.some((t) => byId.has(t.id))) return rows;
  return rows.map((t) => (byId.has(t.id) ? { ...t, ...byId.get(t.id), similarCount: t.similarCount } : t));
}

export function KeyboardHint() {
  return html`<p class="small muted hide-mobile" style="text-align:center;margin:0">
    Keyboard: <kbd>J</kbd>/<kbd>K</kbd> move · <kbd>B</kbd> business · <kbd>P</kbd> personal · <kbd>S</kbd> split · <kbd>N</kbd> note
  </p>`;
}
