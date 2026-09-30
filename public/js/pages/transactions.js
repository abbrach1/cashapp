import { html, useCallback, useEffect, useRef, useState } from '../../vendor/preact.js';
import { get } from '../api.js';
import { period, plural } from '../format.js';
import { refresh, useStore } from '../store.js';
import { Empty, Skeleton } from '../ui.js';
import { TxnTable } from '../components/txns.js';

export function TransactionsPage() {
  const { state } = useStore();
  const [q, setQ] = useState('');
  const [accountId, setAccountId] = useState('');
  const [status, setStatus] = useState('');
  const [result, setResult] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (accountId) params.set('accountId', accountId);
    if (status) params.set('status', status);
    params.set('limit', '300');
    setResult(await get(`/transactions?${params}`));
  }, [q, accountId, status]);

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(timer.current);
  }, [load]);

  const bills = new Map(state.bills.map((b) => [b.id, b]));
  const accounts = new Map(state.accounts.map((a) => [a.id, a]));
  const onUpdated = (res) => {
    load();
    if (res?.state) refresh(res.state);
    else refresh();
  };

  return html`<div class="stack-lg">
    <div class="page-head">
      <div><h1>Transactions</h1><p class="muted">Search everything on your connected accounts.</p></div>
    </div>
    <div class="card">
      <div class="card-head">
        <div class="row wrap grow">
          <input type="search" class="grow" style="max-width:320px" placeholder="Search merchant, note, amount…" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} />
          <select value=${accountId} onChange=${(e) => setAccountId(e.currentTarget.value)}>
            <option value="">All accounts</option>
            ${state.accounts.map((a) => html`<option value=${a.id}>${a.label}</option>`)}
          </select>
          <select value=${status} onChange=${(e) => setStatus(e.currentTarget.value)}>
            <option value="">Any claim status</option>
            <option value="claimed">Claimed</option>
            <option value="partial">Partly claimed</option>
            <option value="excluded">Not claimed</option>
          </select>
        </div>
        ${result ? html`<span class="muted small">${result.total > result.transactions.length ? `Showing ${result.transactions.length} of ${result.total}` : plural(result.total, 'transaction')}</span>` : null}
      </div>
      ${result
        ? html`<${TxnTable}
            transactions=${result.transactions}
            today=${state.today}
            rules=${state.rules}
            onUpdated=${onUpdated}
            extraHead=${html`<th class="hide-mobile">Account / statement</th>`}
            extraColumns=${(t) => {
              const b = t.billId ? bills.get(t.billId) : null;
              return html`<td class="hide-mobile small c-extra">
                <div>${accounts.get(t.accountId)?.label ?? ''}</div>
                ${b ? html`<a class="tiny" href=${`#/bills/${b.id}`}>${period(b.start, b.end)}</a>` : html`<span class="tiny muted">${t.kind === 'deposit' || t.kind === 'withdrawal' ? 'Bank account' : 'No statement'}</span>`}
              </td>`;
            }}
            empty=${html`<${Empty} title="No transactions found">Try a different search or filter.<//>`}
          />`
        : html`<div class="card-body stack"><${Skeleton} height=${18} /><${Skeleton} height=${18} /><${Skeleton} height=${18} /></div>`}
    </div>
  </div>`;
}
