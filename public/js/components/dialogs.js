import { html, useEffect, useMemo, useState } from '../../vendor/preact.js';
import { post, put } from '../api.js';
import { centsToInput, localToday, longDate, money, parseCents, period } from '../format.js';
import { attempt, refresh, toast, useStore } from '../store.js';
import { AsyncButton, Field, Modal, Money } from '../ui.js';

// ---------------------------------------------------------------------------
// SimpleFIN

export function SimplefinDialog({ open, onClose }) {
  const [token, setToken] = useState('');
  useEffect(() => open && setToken(''), [open]);
  const connect = () =>
    attempt(async () => {
      const res = await post('/simplefin/connect', { setupToken: token.trim() });
      refresh(res.state);
      if (res.sync?.ok === false) throw new Error(res.sync.error);
      onClose();
      return res;
    }, (res) => `Connected. Imported ${res.sync?.added ?? 0} transactions.`);
  return html`<${Modal}
    open=${open}
    onClose=${onClose}
    title="Connect with SimpleFIN Bridge"
    footer=${html`<button class="btn" onClick=${onClose}>Cancel</button>
      <${AsyncButton} class="btn primary" disabled=${token.trim().length < 20} onClick=${connect}>Connect<//>`}
  >
    <div class="stack">
      <ol class="small" style="padding-left:18px;margin:0">
        <li>Sign up at <a href="https://beta-bridge.simplefin.org" target="_blank" rel="noopener">beta-bridge.simplefin.org</a> ($1.50/month or $15/year).</li>
        <li>Add Chase under <b>Institutions</b> and log in there.</li>
        <li>Under <b>Apps</b> choose <b>New connection</b> and copy the <b>setup token</b>.</li>
        <li>Paste it below. It can only be used once.</li>
      </ol>
      <${Field} label="Setup token">
        <textarea rows="4" placeholder="aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3JnL3NpbXBsZWZpbi9jbGFpbS8..." value=${token} onInput=${(e) => setToken(e.currentTarget.value)}></textarea>
      <//>
      <p class="tiny muted" style="margin:0">SimpleFIN refreshes bank data about once a day. The access link it returns is stored encrypted.</p>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------
// CSV import

export function ImportDialog({ open, onClose }) {
  const { state } = useStore();
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [accountId, setAccountId] = useState('');
  const [name, setName] = useState('');
  const [closingDay, setClosingDay] = useState('');

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setPreview(null);
    setError(null);
    setAccountId('');
    setName('');
    setClosingDay('');
  }, [open]);

  const pick = async (e) => {
    const f = e.currentTarget.files?.[0];
    setPreview(null);
    setError(null);
    if (!f) return;
    if (f.size > 3_500_000) return setError('That file is too large. Download a shorter date range.');
    const content = await f.text();
    setFile({ name: f.name, content });
    try {
      const p = await post('/import/csv/preview', { filename: f.name, content });
      setPreview(p);
      setAccountId(p.suggestedAccountId ?? '');
      setName(p.kind === 'checking' ? 'Chase checking' : 'Chase card');
    } catch (err) {
      setError(err.message);
    }
  };

  const doImport = () =>
    attempt(async () => {
      const body = { filename: file.name, content: file.content };
      if (accountId) body.accountId = accountId;
      else body.newAccount = { name, kind: preview.kind === 'other' ? 'credit' : preview.kind, mask: preview.mask, closingDay: closingDay ? Number(closingDay) : undefined };
      const res = await post('/import/csv', body);
      refresh(res.state);
      onClose();
      return res;
    }, (res) => `Imported ${res.added} transactions${res.skippedDuplicates ? `, skipped ${res.skippedDuplicates} already known` : ''}.`);

  const accounts = state?.accounts ?? [];
  return html`<${Modal}
    open=${open}
    onClose=${onClose}
    title="Import a Chase CSV file"
    footer=${html`<button class="btn" onClick=${onClose}>Cancel</button>
      <${AsyncButton} class="btn primary" disabled=${!preview || (!accountId && !name.trim())} onClick=${doImport}>Import<//>`}
  >
    <div class="stack">
      <p class="small muted" style="margin:0">
        On chase.com open the card, choose <b>Download account activity</b>, pick <b>Spreadsheet (Excel, CSV)</b> and a statement or date range.
        Importing the same file twice is safe; duplicates are skipped.
      </p>
      <input type="file" accept=".csv,text/csv" onChange=${pick} />
      ${error ? html`<div class="callout danger">${error}</div>` : null}
      ${preview
        ? html`<div class="callout">
              Found <b>${preview.rows}</b> ${preview.kind === 'checking' ? 'bank' : 'card'} transactions from ${preview.from} to ${preview.to}${preview.mask ? html` for the account ending <b>${preview.mask}</b>` : ''}.
              ${preview.warnings?.length ? html`<div class="tiny" style="margin-top:6px">${preview.warnings.join(' · ')}</div>` : null}
            </div>
            <${Field} label="Add to account">
              <select value=${accountId} onChange=${(e) => setAccountId(e.currentTarget.value)}>
                <option value="">+ New account</option>
                ${accounts.map((a) => html`<option value=${a.id}>${a.label}</option>`)}
              </select>
            <//>
            ${!accountId
              ? html`<div class="form-grid">
                  <${Field} label="Account name"><input value=${name} onInput=${(e) => setName(e.currentTarget.value)} /><//>
                  ${preview.kind !== 'checking'
                    ? html`<${Field} label="Statement closing day" hint=${'Printed on your statement as the “Closing Date”'}>
                        <select value=${closingDay} onChange=${(e) => setClosingDay(e.currentTarget.value)}>
                          <option value="">Choose…</option>
                          ${Array.from({ length: 31 }, (_, i) => html`<option value=${i + 1}>${i + 1}</option>`)}
                        </select>
                      <//>`
                    : null}
                </div>`
              : null}`
        : null}
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------
// Split a reimbursement across bills

export function AllocationDialog({ reimbursement: r, open, onClose }) {
  const { state } = useStore();
  const [amounts, setAmounts] = useState({});

  const candidates = useMemo(() => {
    if (!r || !state) return [];
    const allocated = new Set(r.allocations.map((a) => a.billId));
    return state.bills
      .filter((b) => allocated.has(b.id) || (b.visible && !b.isOpen && b.outstandingCents > 0) || (b.isOpen && b.claimCents > 0 && allocated.has(b.id)))
      .sort((a, b) => (a.end < b.end ? -1 : 1));
  }, [r, state]);

  useEffect(() => {
    if (!open || !r) return;
    const init = {};
    for (const a of r.allocations) init[a.billId] = centsToInput(a.amountCents);
    setAmounts(init);
  }, [open, r?.id]);

  if (!r) return null;
  const entered = Object.entries(amounts).map(([billId, v]) => ({ billId, amountCents: parseCents(v) ?? 0 }));
  const total = entered.reduce((s, a) => s + Math.max(0, a.amountCents), 0);
  const left = r.amountCents - total;
  const invalid = entered.some((a) => a.amountCents < 0) || left < 0;

  const fillOldest = () => {
    let remaining = r.amountCents;
    const next = {};
    for (const b of candidates) {
      const already = r.allocations.find((a) => a.billId === b.id)?.amountCents ?? 0;
      const room = b.outstandingCents + already;
      if (remaining <= 0 || room <= 0) continue;
      const use = Math.min(room, remaining);
      next[b.id] = centsToInput(use);
      remaining -= use;
    }
    setAmounts(next);
  };

  const save = () =>
    attempt(async () => {
      const res = await put(`/reimbursements/${r.id}/allocations`, { allocations: entered.filter((a) => a.amountCents > 0) });
      refresh(res.state);
      onClose();
    }, 'Payment applied.');

  return html`<${Modal}
    open=${open}
    onClose=${onClose}
    wide
    title=${`Apply ${money(r.amountCents)} from ${r.sender ?? 'payment'}`}
    footer=${html`<span class=${`grow small ${left < 0 ? 'neg' : 'muted'}`} style=${left < 0 ? 'color:var(--danger)' : ''}>
        ${left === 0 ? 'Fully applied' : left > 0 ? `${money(left)} left to apply` : `${money(-left)} more than the payment`}
      </span>
      <button class="btn" onClick=${onClose}>Cancel</button>
      <${AsyncButton} class="btn primary" disabled=${invalid} onClick=${save}>Save<//>`}
  >
    <div class="stack">
      <div class="spread">
        <span class="small muted">Received ${longDate(r.date)}${r.description ? ` · ${r.description}` : ''}</span>
        <button class="btn sm" onClick=${fillOldest}>Fill oldest first</button>
      </div>
      ${candidates.length
        ? html`<div class="table-wrap"><table class="data">
            <thead><tr><th>Statement</th><th class="amount">Claimed</th><th class="amount">Still owed</th><th class="amount">Apply</th></tr></thead>
            <tbody>
              ${candidates.map(
                (b) => html`<tr key=${b.id}>
                  <td><div class="merchant">${b.accountLabel}</div><div class="sub-desc">${period(b.start, b.end)}${b.submittedOn ? ' · submitted' : ''}</div></td>
                  <td class="amount"><${Money} cents=${b.claimCents} /></td>
                  <td class="amount"><${Money} cents=${b.outstandingCents} /></td>
                  <td class="amount">
                    <input class="claim-input" inputmode="decimal" placeholder="0.00" value=${amounts[b.id] ?? ''}
                      onInput=${(e) => setAmounts({ ...amounts, [b.id]: e.currentTarget.value })} />
                  </td>
                </tr>`,
              )}
            </tbody>
          </table></div>`
        : html`<p class="muted">No statements are waiting for money right now.</p>`}
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------
// Record a reimbursement by hand

export function ManualReimbursementDialog({ open, onClose }) {
  const [form, setForm] = useState({});
  useEffect(() => open && setForm({ date: localToday(), amount: '', sender: '', method: 'zelle', note: '' }), [open]);
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.value });
  const cents = parseCents(form.amount);
  const save = () =>
    attempt(async () => {
      const res = await post('/reimbursements', { date: form.date, amountCents: cents, sender: form.sender, method: form.method, note: form.note });
      refresh(res.state);
      onClose();
    }, 'Reimbursement recorded.');
  return html`<${Modal}
    open=${open}
    onClose=${onClose}
    title="Record a reimbursement"
    footer=${html`<button class="btn" onClick=${onClose}>Cancel</button>
      <${AsyncButton} class="btn primary" disabled=${!cents || cents <= 0 || !form.date} onClick=${save}>Save<//>`}
  >
    <div class="stack">
      <p class="small muted" style="margin:0">For money that didn't arrive in a connected account: a check, payroll, or a Zelle to another bank.</p>
      <div class="form-grid">
        <${Field} label="Date received"><input type="date" value=${form.date} onInput=${set('date')} /><//>
        <${Field} label="Amount"><input inputmode="decimal" placeholder="0.00" value=${form.amount} onInput=${set('amount')} /><//>
        <${Field} label="From"><input placeholder="Company name" value=${form.sender} onInput=${set('sender')} /><//>
        <${Field} label="Method">
          <select value=${form.method} onChange=${set('method')}>
            ${['zelle', 'check', 'payroll', 'ach', 'cash', 'other'].map((m) => html`<option value=${m}>${m[0].toUpperCase() + m.slice(1)}</option>`)}
          </select>
        <//>
      </div>
      <${Field} label="Note"><input value=${form.note} onInput=${set('note')} /><//>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------
// Claim only part of a transaction

export function PartialDialog({ txn, open, onClose, onSaved }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!open || !txn) return;
    setAmount(centsToInput(txn.claim.status === 'partial' ? txn.claim.claimCents : txn.amountCents));
    setNote(txn.note ?? '');
  }, [open, txn?.id]);
  if (!txn) return null;
  const cents = parseCents(amount);
  const save = () =>
    attempt(async () => {
      const res = await post(`/transactions/${txn.id}`, { override: 'partial', claimCents: cents, note: note || null });
      onSaved?.(res);
      onClose();
    }, 'Saved.');
  return html`<${Modal}
    open=${open}
    onClose=${onClose}
    title="Claim part of this charge"
    footer=${html`<button class="btn" onClick=${onClose}>Cancel</button>
      <${AsyncButton} class="btn primary" disabled=${cents === null} onClick=${save}>Save<//>`}
  >
    <div class="stack">
      <div><div class="merchant">${txn.merchant ?? txn.description}</div><div class="sub-desc">${txn.date} · charged ${money(txn.amountCents)}</div></div>
      <div class="form-grid">
        <${Field} label="Amount to claim"><input inputmode="decimal" value=${amount} onInput=${(e) => setAmount(e.currentTarget.value)} /><//>
        <${Field} label="Business purpose / note"><input value=${note} placeholder="e.g. Client dinner, my guest not claimed" onInput=${(e) => setNote(e.currentTarget.value)} /><//>
      </div>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------
// Always exclude a merchant

export function RuleDialog({ open, onClose, initialPattern = '', accountId = null }) {
  const { state } = useStore();
  const [pattern, setPattern] = useState('');
  const [scope, setScope] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!open) return;
    setPattern(initialPattern);
    setScope(accountId ?? '');
    setNote('');
  }, [open]);
  const save = () =>
    attempt(async () => {
      const res = await post('/rules', { pattern, accountId: scope || null, note: note || null });
      refresh(res.state);
      onClose(true);
    }, `Transactions containing "${pattern}" will be excluded.`);
  return html`<${Modal}
    open=${open}
    onClose=${() => onClose(false)}
    title="Always exclude…"
    footer=${html`<button class="btn" onClick=${() => onClose(false)}>Cancel</button>
      <${AsyncButton} class="btn primary" disabled=${pattern.trim().length < 2} onClick=${save}>Create rule<//>`}
  >
    <div class="stack">
      <p class="small muted" style="margin:0">Use this for personal things on your work card, like streaming or groceries. It applies to past and future transactions; you can still include a single one by hand.</p>
      <${Field} label="Description contains" hint="Not case sensitive"><input value=${pattern} onInput=${(e) => setPattern(e.currentTarget.value)} /><//>
      <div class="form-grid">
        <${Field} label="On">
          <select value=${scope} onChange=${(e) => setScope(e.currentTarget.value)}>
            <option value="">All cards</option>
            ${(state?.accounts ?? []).filter((a) => a.role === 'expenses').map((a) => html`<option value=${a.id}>${a.label}</option>`)}
          </select>
        <//>
        <${Field} label="Note (optional)"><input value=${note} onInput=${(e) => setNote(e.currentTarget.value)} /><//>
      </div>
    </div>
  <//>`;
}

export function notifyError(err) {
  toast(err.message, 'error');
}
