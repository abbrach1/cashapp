// Go back through card history, statement by statement, and mark what was
// personal. Everything is business (claimed) until you say otherwise.

import { html, useCallback, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { get, post } from '../api.js';
import { localToday, longDate, money, period, plural, shortDate } from '../format.js';
import { navigate } from '../router.js';
import { attempt, refresh, toast, useStore } from '../store.js';
import { AsyncButton, Empty, Menu, Money, Pill, Progress, Skeleton } from '../ui.js';
import { ImportDialog, PartialDialog, RuleDialog } from '../components/dialogs.js';
import { NoteInput, subLine } from '../components/txns.js';
import { statusLabel } from '../components/bills.js';
import { historyLoading } from '../connect.js';

const SHOW = [
  ['review', 'To review'],
  ['all', 'All'],
  ['business', 'Business'],
  ['personal', 'Personal'],
];

const CHOICE = { claimed: 'business', excluded: 'personal', partial: 'split' };
const choiceOf = (t) => CHOICE[t.claim.status] ?? 'business';

const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

/** What a row looks like right after a click, before the server answers. */
function optimistic(t, what) {
  if (what === 'business') return { ...t, reviewed: true, claim: { ...t.claim, status: 'claimed', claimCents: t.amountCents } };
  if (what === 'personal') return { ...t, reviewed: true, claim: { ...t.claim, status: 'excluded', claimCents: 0 } };
  return t;
}

function Row({ t, today, focused, onFocus, act, onRule }) {
  const choice = choiceOf(t);
  const name = t.merchant ?? t.description;
  const short = name.length > 22 ? `${name.slice(0, 22)}…` : name;
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
    class=${`cl-row ${choice} ${t.reviewed ? 'is-reviewed' : 'is-new'} ${focused ? 'focused' : ''}`}
    data-id=${t.id}
    onClick=${() => onFocus(t.id)}
  >
    <span class="cl-dot" title=${t.reviewed ? 'Reviewed' : 'Not reviewed yet'}>${t.reviewed ? '✓' : ''}</span>
    <span class="cl-date nowrap small">${shortDate(t.authDate ?? t.date, today)}</span>
    <div class="cl-merchant">
      <div class="merchant">${name}</div>
      <div class="sub-desc">
        <span class="show-mobile-inline">${shortDate(t.authDate ?? t.date, today)} · </span>${[t.category, subLine(t)].filter(Boolean).join(' · ')}
      </div>
    </div>
    <div class="cl-amount">
      <${Money} cents=${t.amountCents} />
      ${choice === 'split' ? html`<div class="tiny" style="color:var(--info)">claiming ${money(t.claim.claimCents)}</div>` : null}
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
        <button onClick=${() => onRule(t)}>Always personal: "${short}"…</button>
        ${t.override ? html`<button onClick=${() => act(t, 'reset')}>Reset to default</button>` : null}
        ${t.billId ? html`<button onClick=${() => navigate(`/bills/${t.billId}`)}>Open statement</button>` : null}
      <//>
    </div>
  </div>`;
}

function GroupHead({ g, collapsed, onToggle, onConfirmRest, onSettle }) {
  const unreviewed = g.transactions.filter((t) => !t.reviewed).length;
  const canSettle = g.billId && !g.isOpen && !g.settledOn && !['reimbursed', 'nothing'].includes(g.status) && g.claimCents > 0;
  return html`<div class="cl-group-head">
    <div class="grow" style="min-width:0">
      <div class="row wrap" style="gap:6px 10px">
        <h2 class="cl-title">${g.billId ? html`<a href=${`#/bills/${g.billId}`}>${period(g.start, g.end)}</a>` : period(g.start, g.end)}</h2>
        ${g.status ? html`<${Pill} status=${g.status} label=${statusLabel(g)} />` : null}
        ${!g.tracked ? html`<span class="badge" title="Statements before your tracking start date don't count as owed (Settings).">Before tracking start</span>` : null}
        ${!g.billId && g.tracked ? html`<span class="badge warn" title="Set the card's statement closing day on the Accounts page.">No closing day set</span>` : null}
      </div>
      <div class="small muted">
        ${g.accountLabel} · <b class="money" style="color:var(--text)">${money(g.claimCents)}</b> to claim${g.claimCents !== g.amountCents ? ` of ${money(g.amountCents)}` : ''} · ${g.counts.reviewed} of ${g.counts.total} reviewed
      </div>
    </div>
    <div class="row cl-group-actions">
      ${collapsed ? html`<button class="btn sm ghost" onClick=${onToggle}>Show ${plural(g.transactions.length, 'transaction')}</button>` : null}
      ${unreviewed && !collapsed
        ? html`<${AsyncButton}
            class="btn sm"
            onClick=${onConfirmRest}
            title=${`Keep the current choice for the ${plural(unreviewed, 'transaction')} you haven't touched (business unless marked otherwise) and mark them reviewed.`}
          >
            ✓ Confirm the rest (${unreviewed})
          <//>`
        : null}
      <${Menu} class="btn sm ghost icon" label="⋯" title="Statement actions">
        ${g.billId ? html`<button onClick=${() => navigate(`/bills/${g.billId}`)}>Open statement</button>` : null}
        ${canSettle ? html`<button onClick=${() => onSettle(true)}>Already reimbursed — stop counting it as owed</button>` : null}
        ${g.settledOn ? html`<button onClick=${() => onSettle(false)}>Undo "already reimbursed"</button>` : null}
        <button onClick=${onToggle}>${collapsed ? 'Show transactions' : 'Hide transactions'}</button>
      <//>
    </div>
  </div>`;
}

function HistoryNote({ state, onImport }) {
  const cards = state.accounts.filter((a) => a.role === 'expenses' && a.firstDate);
  if (!cards.length) return null;
  const first = cards.map((a) => a.firstDate).sort()[0];
  return html`<span>
    Your card history goes back to <b>${longDate(first)}</b>.${' '}
    <button type="button" class="link" onClick=${onImport}>Import older statements (CSV)</button>
  </span>`;
}

export function ClassifyPage({ query }) {
  const { state } = useStore();
  const cards = state.accounts.filter((a) => a.role === 'expenses');
  const [show, setShow] = useState(SHOW.some(([k]) => k === query.get('show')) ? query.get('show') : 'review');
  const [scope, setScope] = useState(query.get('scope') === 'all' ? 'all' : 'open');
  const [accountId, setAccountId] = useState(query.get('account') ?? '');
  const [billId, setBillId] = useState(query.get('bill') ?? '');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [focusId, setFocusId] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [splitFor, setSplitFor] = useState(null);
  const [ruleFor, setRuleFor] = useState(null);
  const [importing, setImporting] = useState(false);

  const params = useCallback(
    (extra = {}) => {
      const p = new URLSearchParams({ show, scope, limit: '200' });
      if (accountId) p.set('accountId', accountId);
      if (billId) p.set('billId', billId);
      if (q.trim()) p.set('q', q.trim());
      for (const [k, v] of Object.entries(extra)) p.set(k, v);
      return p;
    },
    [show, scope, accountId, billId, q],
  );

  const load = useCallback(async () => {
    try {
      setData(await get(`/classify?${params()}`));
      setError(null);
      setCollapsed(new Set());
    } catch (err) {
      setError(err.message);
    }
  }, [params]);

  const timer = useRef(null);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(timer.current);
  }, [load]);

  // Reload when a sync brings new transactions (e.g. older history arriving).
  const lastSync = useRef(state.lastSyncedAt);
  useEffect(() => {
    if (lastSync.current === state.lastSyncedAt) return;
    lastSync.current = state.lastSyncedAt;
    load();
  }, [state.lastSyncedAt]);

  const loadMore = async () => {
    if (!data?.nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await get(`/classify?${params({ cursor: data.nextCursor })}`);
      setData((d) => ({ ...res, groups: [...(d?.groups ?? []), ...res.groups] }));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  /** Fresh totals and statement headers after a change (debounced). */
  const summaryTimer = useRef(null);
  const refreshSummary = useCallback(() => {
    clearTimeout(summaryTimer.current);
    summaryTimer.current = setTimeout(async () => {
      let s;
      try {
        s = await get(`/classify?${params({ summary: '1' })}`);
      } catch {
        return;
      }
      const heads = new Map(s.groups.map((g) => [g.key, g]));
      setData((d) => {
        if (!d) return d;
        for (const g of d.groups) {
          const h = heads.get(g.key);
          if (h && h.status === 'reimbursed' && g.status !== 'reimbursed' && !h.settledOn) {
            toast(`${g.accountLabel} · ${period(g.start, g.end)} now matches a reimbursement you received.`, 'info', 6000);
          }
        }
        return { ...d, stats: s.stats, groups: d.groups.map((g) => (heads.has(g.key) ? { ...g, ...heads.get(g.key), transactions: g.transactions } : g)) };
      });
    }, 400);
  }, [params]);

  /** Put the server's version of these transactions in place (rows stay where they are). */
  const applyTxns = useCallback((list) => {
    if (!list?.length) return;
    const byId = new Map(list.map((t) => [t.id, t]));
    setData(
      (d) =>
        d && {
          ...d,
          groups: d.groups.map((g) =>
            g.transactions.some((t) => byId.has(t.id))
              ? { ...g, transactions: g.transactions.map((t) => (byId.has(t.id) ? { ...t, ...byId.get(t.id), similarCount: t.similarCount } : t)) }
              : g,
          ),
        },
    );
  }, []);

  // One change at a time, in order, so quick clicks never arrive out of order.
  const queue = useRef(Promise.resolve());
  const enqueue = (fn) => {
    queue.current = queue.current.then(fn).catch((err) => toast(err?.message || 'Something went wrong', 'error', 6000));
    return queue.current;
  };

  const act = (t, what, value) => {
    if (what === 'split') return setSplitFor(t);
    const bodies = {
      business: { override: 'claim' },
      personal: { override: 'unclaim' },
      reset: { override: null },
      note: { note: value, reviewed: true },
    };
    if (what === 'similar-business' || what === 'similar-personal') {
      const personal = what === 'similar-personal';
      return enqueue(() =>
        bulk(
          { similarTo: t.id, override: personal ? 'unclaim' : 'claim' },
          (res) => `${personal ? 'Personal' : 'Business'}: ${plural(res.changed, 'transaction')} from ${t.merchant ?? t.description}.`,
        ),
      );
    }
    if (what === 'business' || what === 'personal') applyTxns([optimistic(t, what)]);
    return enqueue(async () => {
      const res = await attempt(() => post(`/transactions/${t.id}`, bodies[what]));
      if (!res) return load();
      applyTxns([res.transaction]);
      refresh(res.state);
      refreshSummary();
    });
  };

  const bulk = async (payload, message) => {
    const res = await attempt(() => post('/transactions/bulk', { scope: data?.scope ?? scope, ...payload }), message);
    if (!res) return null;
    applyTxns(res.transactions);
    refresh(res.state);
    refreshSummary();
    return res;
  };

  const confirmRest = (g) =>
    enqueue(async () => {
      const ids = g.transactions.filter((t) => !t.reviewed).map((t) => t.id);
      if (!ids.length) return;
      const res = await bulk({ ids, reviewed: true }, `Confirmed ${plural(ids.length, 'transaction')}.`);
      if (res) setCollapsed((c) => new Set(c).add(g.key));
    });

  const confirmAllShown = () => {
    const ids = (data?.groups ?? []).flatMap((g) => g.transactions.filter((t) => !t.reviewed).map((t) => t.id));
    if (!ids.length) return;
    if (!window.confirm(`Mark ${plural(ids.length, 'transaction')} as reviewed, keeping their current choice (business unless marked otherwise)?`)) return;
    enqueue(() => bulk({ ids, reviewed: true }, `Confirmed ${plural(ids.length, 'transaction')}.`));
  };

  const settle = (g, on) =>
    enqueue(async () => {
      const res = await attempt(
        () => post(`/bills/${g.billId}`, { settledOn: on ? localToday() : null }),
        on ? 'Marked as already reimbursed. It no longer counts as owed.' : 'It counts as owed again.',
      );
      if (!res) return;
      const b = res.bill?.bill;
      if (b) setData((d) => d && { ...d, groups: d.groups.map((x) => (x.key === g.key ? { ...x, status: b.status, settledOn: b.settledOn, receivedCents: b.receivedCents } : x)) });
      refresh(res.state);
      refreshSummary();
    });

  const toggle = (key) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Keyboard: J/K or arrows to move, B business, P personal, S split, N note.
  const visibleRows = useMemo(() => (data ? data.groups.filter((g) => !collapsed.has(g.key)).flatMap((g) => g.transactions) : []), [data, collapsed]);
  const keyState = useRef({});
  keyState.current = { rows: visibleRows, focusId, act };
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector('dialog[open]')) return;
      const { rows, focusId: id, act: run } = keyState.current;
      if (!rows.length) return;
      const idx = rows.findIndex((t) => t.id === id);
      const current = idx >= 0 ? rows[idx] : null;
      const moveTo = (i) => setFocusId(rows[Math.max(0, Math.min(rows.length - 1, i))].id);
      const key = e.key.toLowerCase();
      if (key === 'j' || (e.key === 'ArrowDown' && current)) moveTo(idx + 1);
      else if (key === 'k' || (e.key === 'ArrowUp' && current)) moveTo(idx < 0 ? 0 : idx - 1);
      else if ((key === 'b' || key === 'p') && current) {
        run(current, key === 'b' ? 'business' : 'personal');
        moveTo(idx + 1);
      } else if (key === 's' && current) run(current, 'split');
      else if (key === 'n' && current) document.querySelector(`.cl-row[data-id="${current.id}"] .note-input`)?.focus();
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (focusId) document.querySelector(`.cl-row[data-id="${focusId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focusId]);

  if (!cards.length) {
    return html`<div class="stack-lg">
      <div class="page-head"><div><h1>Classify</h1></div></div>
      <div class="card"><${Empty} title="No expense cards yet">Connect your Chase card on the <a href="#/accounts">Accounts</a> page first.<//></div>
    </div>`;
  }

  const stats = data?.stats;
  const loadingFrom = historyLoading(state);
  const trackingStart = state.settings.trackingStartDate;
  const bill = billId ? state.bills.find((b) => b.id === billId) : null;
  const unreviewedShown = (data?.groups ?? []).reduce((n, g) => n + g.transactions.filter((t) => !t.reviewed).length, 0);
  const trackAll = () =>
    attempt(async () => {
      refresh((await post('/settings', { trackingStartDate: null })).state);
      await load();
    }, 'Tracking all statements. Mark the ones you were already paid back for as reimbursed.');

  return html`<div class="stack-lg">
    <div class="page-head">
      <div>
        <h1>Classify</h1>
        <p class="muted">Go through your card history and mark anything personal. Everything else stays reimbursable.</p>
      </div>
      ${billId
        ? null
        : html`<select value=${scope} onChange=${(e) => setScope(e.currentTarget.value)} aria-label="Which statements">
            <option value="open">Statements not sent yet</option>
            <option value="all">All history</option>
          </select>`}
    </div>

    ${loadingFrom.length
      ? html`<div class="callout row">
          <span class="spinner" aria-hidden="true"></span>
          <span>${loadingFrom.map((c) => c.institution ?? 'Your bank').join(', ')} is still sending your older transactions (up to a year). They appear here automatically.</span>
        </div>`
      : null}

    <div class="card">
      <div class="card-body stack">
        ${stats
          ? html`<div class="spread">
                <b>${stats.total ? `${stats.reviewed} of ${plural(stats.total, 'transaction')} reviewed` : 'Nothing to review'}</b>
                <span class="small muted">${money(stats.claimCents)} to claim${stats.amountCents !== stats.claimCents ? ` · ${money(stats.amountCents - stats.claimCents)} personal` : ''}</span>
              </div>
              <${Progress} value=${stats.reviewed} max=${stats.total} />`
          : html`<${Skeleton} height=${18} />`}
        <div class="small muted">
          ${scope === 'open'
            ? 'Showing statements you haven’t sent to your company or been reimbursed for. '
            : 'Showing all card history, including statements already sent or reimbursed. '}
          <${HistoryNote} state=${state} onImport=${() => setImporting(true)} />
        </div>
        ${trackingStart && scope === 'all'
          ? html`<div class="callout small row wrap">
              <span class="grow">Statements closing before <b>${longDate(trackingStart)}</b> aren’t tracked, so they don’t count as owed. Track them too if some were never reimbursed.</span>
              <${AsyncButton} class="btn sm" onClick=${trackAll}>Track all statements<//>
            </div>`
          : null}
      </div>
    </div>

    <div class="cl-toolbar">
      <div class="chips">
        ${SHOW.map(([k, label]) => html`<button class=${`chip ${show === k ? 'active' : ''}`} onClick=${() => setShow(k)}>${label}</button>`)}
      </div>
      ${cards.length > 1 && !billId
        ? html`<select value=${accountId} onChange=${(e) => setAccountId(e.currentTarget.value)} aria-label="Card">
            <option value="">All cards</option>
            ${cards.map((a) => html`<option value=${a.id}>${a.label}</option>`)}
          </select>`
        : null}
      <input type="search" class="grow" style="max-width:260px" placeholder="Search merchant or amount…" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} />
      ${billId
        ? html`<button class="chip active" title="Show all statements" onClick=${() => setBillId('')}>
            ${bill ? `${bill.accountLabel} · ${period(bill.start, bill.end)}` : 'One statement'} ✕
          </button>`
        : null}
      ${unreviewedShown > 1
        ? html`<button class="btn sm" onClick=${confirmAllShown} title="Mark every transaction shown as reviewed, keeping its current choice">
            ✓ Confirm all ${unreviewedShown} shown
          </button>`
        : null}
    </div>

    ${error ? html`<div class="callout danger">${error}</div>` : null}

    ${!data
      ? html`<div class="card"><div class="card-body stack">${[1, 2, 3, 4].map((i) => html`<${Skeleton} key=${i} height=${22} />`)}</div></div>`
      : data.groups.length
        ? data.groups.map(
            (g) => html`<section class="card cl-group" key=${g.key}>
              <${GroupHead}
                g=${g}
                collapsed=${collapsed.has(g.key)}
                onToggle=${() => toggle(g.key)}
                onConfirmRest=${() => confirmRest(g)}
                onSettle=${(on) => settle(g, on)}
              />
              ${collapsed.has(g.key)
                ? null
                : html`<div class="cl-rows">
                    ${g.transactions.map(
                      (t) => html`<${Row} key=${t.id} t=${t} today=${state.today} focused=${t.id === focusId} onFocus=${setFocusId} act=${act} onRule=${setRuleFor} />`,
                    )}
                  </div>`}
            </section>`,
          )
        : html`<div class="card">
            ${show === 'review' && !q
              ? html`<${Empty} title="All caught up" icon="✓">
                  Every transaction ${scope === 'open' ? 'in statements you haven’t sent yet ' : ''}has been reviewed.
                  ${scope === 'open' ? html`<div style="margin-top:10px"><button class="btn sm" onClick=${() => setScope('all')}>Go further back: all history</button></div>` : null}
                <//>`
              : html`<${Empty} title="Nothing here">No transactions match these filters.<//>`}
          </div>`}

    ${data?.nextCursor
      ? html`<div class="row" style="justify-content:center">
          <${AsyncButton} class="btn" disabled=${loadingMore} onClick=${loadMore}>
            Load older statements (${plural(data.more.statements, 'more statement')}, ${data.more.transactions} transactions)
          <//>
        </div>`
      : null}

    ${data?.groups.length
      ? html`<p class="small muted hide-mobile" style="text-align:center">
          Keyboard: <kbd>J</kbd>/<kbd>K</kbd> move · <kbd>B</kbd> business · <kbd>P</kbd> personal · <kbd>S</kbd> split · <kbd>N</kbd> note
        </p>`
      : null}

    <${PartialDialog}
      open=${Boolean(splitFor)}
      txn=${splitFor}
      onClose=${() => setSplitFor(null)}
      onSaved=${(res) => {
        applyTxns([res.transaction]);
        refresh(res.state);
        refreshSummary();
      }}
    />
    <${RuleDialog}
      open=${Boolean(ruleFor)}
      initialPattern=${ruleFor ? (ruleFor.merchant ?? ruleFor.description).toUpperCase().replace(/\s+\S*\d\S*$/, '').slice(0, 30) : ''}
      onClose=${(created) => {
        setRuleFor(null);
        if (created) load();
      }}
    />
    <${ImportDialog}
      open=${importing}
      onClose=${() => {
        setImporting(false);
        load();
      }}
    />
  </div>`;
}
