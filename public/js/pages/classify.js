// Go back through card history, statement by statement, and mark what was
// personal. Everything is business until you say otherwise.

import { html, useCallback, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { get, post } from '../api.js';
import { localToday, longDate, money, period, plural } from '../format.js';
import { navigate } from '../router.js';
import { attempt, refresh, toast, useStore } from '../store.js';
import { AsyncButton, Empty, Menu, Pill, Progress, Skeleton } from '../ui.js';
import { ImportDialog } from '../components/dialogs.js';
import { ChargeRow, KeyboardHint, mergeTxns, useChargeActions, useChargeKeys } from '../components/charges.js';
import { statusLabel } from '../components/bills.js';
import { canRequest, useSendRequest } from '../components/request.js';
import { historyLoading } from '../connect.js';

const SHOW = [
  ['review', 'To review'],
  ['all', 'All'],
  ['business', 'Business'],
  ['personal', 'Personal'],
];

function GroupHead({ g, collapsed, onToggle, onConfirmRest, onSettle, onRequest }) {
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
        ${g.accountLabel} · <b class="money" style="color:var(--text)">${money(g.claimCents)}</b> to request${g.claimCents !== g.amountCents ? ` of ${money(g.amountCents)}` : ''} · ${g.counts.reviewed} of ${g.counts.total} reviewed
      </div>
    </div>
    <div class="row wrap cl-group-actions">
      ${collapsed ? html`<button class="btn sm ghost" onClick=${onToggle}>Show ${plural(g.transactions.length, 'charge')}</button>` : null}
      ${unreviewed && !collapsed
        ? html`<${AsyncButton}
            class="btn sm"
            onClick=${onConfirmRest}
            title=${`Keep the current choice for the ${plural(unreviewed, 'charge')} you haven't touched (business unless marked otherwise) and mark them reviewed.`}
          >
            ✓ Confirm the rest (${unreviewed})
          <//>`
        : null}
      ${g.billId && canRequest(g) ? html`<button class="btn sm primary" onClick=${onRequest}>Send request</button>` : null}
      <${Menu} class="btn sm ghost icon" label="⋯" title="Statement actions">
        ${g.billId ? html`<button onClick=${() => navigate(`/bills/${g.billId}`)}>Open statement</button>` : null}
        ${canSettle ? html`<button onClick=${() => onSettle(true)}>Already reimbursed — stop counting it as owed</button>` : null}
        ${g.settledOn ? html`<button onClick=${() => onSettle(false)}>Undo "already reimbursed"</button>` : null}
        <button onClick=${onToggle}>${collapsed ? 'Show charges' : 'Hide charges'}</button>
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
  const [q, setQ] = useState(query.get('q') ?? '');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [importing, setImporting] = useState(false);
  const rulesById = useMemo(() => new Map(state.rules.map((r) => [r.id, r])), [state.rules]);

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

  const applyTxns = useCallback((list) => {
    setData((d) => d && { ...d, groups: d.groups.map((g) => {
      const transactions = mergeTxns(g.transactions, list);
      return transactions === g.transactions ? g : { ...g, transactions };
    }) });
  }, []);

  const { act, bulk, enqueue, onRule, dialogs } = useChargeActions({
    scope: data?.scope ?? scope,
    onTxns: applyTxns,
    onSaved: (res) => {
      refresh(res.state);
      refreshSummary();
    },
    onRulesChanged: load,
    onFailed: load,
  });

  const [openRequest, requestDialog] = useSendRequest(() => refreshSummary());

  const confirmRest = (g) => {
    const ids = g.transactions.filter((t) => !t.reviewed).map((t) => t.id);
    if (!ids.length) return undefined;
    return bulk({ ids, reviewed: true }, `Confirmed ${plural(ids.length, 'charge')}.`).then((res) => {
      if (res) setCollapsed((c) => new Set(c).add(g.key));
    });
  };

  const confirmAllShown = () => {
    const ids = (data?.groups ?? []).flatMap((g) => g.transactions.filter((t) => !t.reviewed).map((t) => t.id));
    if (!ids.length) return;
    if (!window.confirm(`Mark ${plural(ids.length, 'charge')} as reviewed, keeping their current choice (business unless marked otherwise)?`)) return;
    bulk({ ids, reviewed: true }, `Confirmed ${plural(ids.length, 'charge')}.`);
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

  const visibleRows = useMemo(() => (data ? data.groups.filter((g) => !collapsed.has(g.key)).flatMap((g) => g.transactions) : []), [data, collapsed]);
  const [focusId, setFocusId] = useChargeKeys(visibleRows, act);

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
        <p class="muted">Mark each charge on your work cards as business or personal. Everything is business until you say otherwise.</p>
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
                <b>${stats.total ? `${stats.reviewed} of ${plural(stats.total, 'charge')} reviewed` : 'Nothing to review'}</b>
                <span class="small muted">${money(stats.claimCents)} business${stats.amountCents !== stats.claimCents ? ` · ${money(stats.amountCents - stats.claimCents)} personal` : ''}</span>
              </div>
              <${Progress} value=${stats.reviewed} max=${stats.total} />`
          : html`<${Skeleton} height=${18} />`}
        <div class="small muted">
          ${scope === 'open' && !billId
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
        ? html`<button class="btn sm" onClick=${confirmAllShown} title="Mark every charge shown as reviewed, keeping its current choice">
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
                onRequest=${() => openRequest(g.billId)}
              />
              ${collapsed.has(g.key)
                ? null
                : html`<div class="cl-rows">
                    ${g.transactions.map(
                      (t) => html`<${ChargeRow}
                        key=${t.id}
                        t=${t}
                        today=${state.today}
                        focused=${t.id === focusId}
                        onFocus=${setFocusId}
                        act=${act}
                        onRule=${onRule}
                        rulesById=${rulesById}
                      />`,
                    )}
                  </div>`}
            </section>`,
          )
        : html`<div class="card">
            ${show === 'review' && !q
              ? html`<${Empty} title="All caught up" icon="✓">
                  Every charge ${scope === 'open' && !billId ? 'in statements you haven’t sent yet ' : ''}has been reviewed.
                  ${scope === 'open' && !billId ? html`<div style="margin-top:10px"><button class="btn sm" onClick=${() => setScope('all')}>Go further back: all history</button></div>` : null}
                <//>`
              : html`<${Empty} title="Nothing here">No charges match these filters.<//>`}
          </div>`}

    ${data?.nextCursor
      ? html`<div class="row" style="justify-content:center">
          <${AsyncButton} class="btn" disabled=${loadingMore} onClick=${loadMore}>
            Load older statements (${plural(data.more.statements, 'more statement')}, ${plural(data.more.transactions, 'charge')})
          <//>
        </div>`
      : null}

    ${data?.groups.length ? html`<${KeyboardHint} />` : null}

    ${dialogs}
    ${requestDialog}
    <${ImportDialog}
      open=${importing}
      onClose=${() => {
        setImporting(false);
        load();
      }}
    />
  </div>`;
}
