import { html, useEffect, useState } from '../../vendor/preact.js';
import { del, download, post } from '../api.js';
import { attempt, refresh, useStore } from '../store.js';
import { AsyncButton, Field } from '../ui.js';
import { RuleDialog } from '../components/dialogs.js';
import { SetupStatus } from '../components/setup.js';
import { signOut } from '../auth.js';

const listText = (list) => (list ?? []).join(', ');

export function SettingsPage() {
  const { state, config, user } = useStore();
  const s = state.settings;
  const [form, setForm] = useState(null);
  const [ruleOpen, setRuleOpen] = useState(false);

  useEffect(() => {
    setForm({
      yourName: s.yourName,
      yourEmail: s.yourEmail,
      companyName: s.companyName,
      companyEmail: s.companyEmail,
      zelleHandle: s.zelleHandle,
      reportTitle: s.reportTitle,
      reimbursementKeywords: listText(s.reimbursementKeywords),
      senderFilters: listText(s.senderFilters),
      incomeSenders: listText(s.incomeSenders),
      trackingStartDate: s.trackingStartDate ?? '',
      excludeFeesByDefault: s.excludeFeesByDefault,
      excludeRewardsByDefault: s.excludeRewardsByDefault,
      autoMatch: s.autoMatch,
    });
  }, [state.settings]);

  if (!form) return null;
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.type === 'checkbox' ? e.currentTarget.checked : e.currentTarget.value });
  const save = (keys, msg = 'Settings saved.') =>
    attempt(async () => {
      const body = Object.fromEntries(keys.map((k) => [k, form[k]]));
      if ('trackingStartDate' in body) body.trackingStartDate = body.trackingStartDate || null;
      refresh((await post('/settings', body)).state);
    }, msg);
  const accountLabel = (id) => state.accounts.find((a) => a.id === id)?.label ?? 'All cards';

  return html`<div class="stack-lg">
    <div class="page-head"><div><h1>Settings</h1></div></div>

    <div class="card">
      <div class="card-head"><h2>You and your company</h2><span class="small muted">Printed on the requests you send</span></div>
      <div class="card-body stack">
        <div class="form-grid">
          <${Field} label="Your name"><input value=${form.yourName} onInput=${set('yourName')} /><//>
          <${Field} label="Your email"><input type="email" value=${form.yourEmail} onInput=${set('yourEmail')} /><//>
          <${Field} label="Company"><input value=${form.companyName} onInput=${set('companyName')} /><//>
          <${Field} label="Company expenses email" hint=${'Used by “Send request”'}><input type="email" value=${form.companyEmail} onInput=${set('companyEmail')} /><//>
          <${Field} label="Your Zelle email or phone" hint="Shown on the report so they know where to pay"><input value=${form.zelleHandle} onInput=${set('zelleHandle')} /><//>
          <${Field} label="Report title"><input value=${form.reportTitle} onInput=${set('reportTitle')} /><//>
        </div>
        <div><${AsyncButton} class="btn primary" onClick=${() => save(['yourName', 'yourEmail', 'companyName', 'companyEmail', 'zelleHandle', 'reportTitle'])}>Save<//></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Business or personal</h2></div>
      <div class="card-body stack">
        <p class="small muted" style="margin:0">Every charge on a work card is business (included in the request) unless you mark it personal. Card payments never count. Refunds lower the request.</p>
        <label class="check"><input type="checkbox" checked=${form.excludeFeesByDefault} onChange=${set('excludeFeesByDefault')} />
          <span>Treat card fees and interest as personal (annual fee, late fee, foreign transaction fee, interest)<div class="small muted">You can still mark one as business.</div></span></label>
        <label class="check"><input type="checkbox" checked=${form.excludeRewardsByDefault} onChange=${set('excludeRewardsByDefault')} />
          <span>Treat rewards redemptions as personal (points/cash-back statement credits)<div class="small muted">Otherwise they would lower your requests.</div></span></label>
        <${Field} label="Track statements closing on or after" hint="Older statements are hidden and not counted as owed.">
          <input type="date" value=${form.trackingStartDate} onInput=${set('trackingStartDate')} style="max-width:200px" />
        <//>
        <div><${AsyncButton} class="btn primary" onClick=${() => save(['excludeFeesByDefault', 'excludeRewardsByDefault', 'trackingStartDate'])}>Save<//></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Always personal</h2><button class="btn sm" onClick=${() => setRuleOpen(true)}>+ Add rule</button></div>
      ${state.rules.length
        ? html`<ul class="list">
            ${state.rules.map(
              (r) => html`<li key=${r.id}>
                <div class="grow"><div class="merchant">Description contains "${r.pattern}"</div><div class="sub-desc">${accountLabel(r.accountId)}${r.note ? ` · ${r.note}` : ''}</div></div>
                <${AsyncButton} class="btn sm ghost" onClick=${() => attempt(async () => refresh((await del(`/rules/${r.id}`)).state), 'Rule removed.')}>Remove<//>
              </li>`,
            )}
          </ul>`
        : html`<div class="card-body small muted">No rules. Add one for recurring personal charges on a work card (e.g. "NETFLIX"); they'll be personal automatically.</div>`}
    </div>

    <div class="card">
      <div class="card-head"><h2>Finding reimbursements</h2></div>
      <div class="card-body stack">
        <div class="form-grid">
          <${Field} label="Deposit description contains" hint=${'Comma separated. Chase labels Zelle deposits “Zelle Payment From …” (older exports: “QUICKPAY”).'}>
            <input value=${form.reimbursementKeywords} onInput=${set('reimbursementKeywords')} />
          <//>
          <${Field} label="Only from these senders" hint="Comma separated, e.g. your company name as it appears in Zelle. Empty = anyone.">
            <input value=${form.senderFilters} placeholder="Acme Corp" onInput=${set('senderFilters')} />
          <//>
          <${Field} label="Payments for services from" hint="Comma separated. Money from these senders is kept as payment for your services, never as a reimbursement.">
            <input value=${form.incomeSenders} placeholder="e.g. a client's name" onInput=${set('incomeSenders')} />
          <//>
        </div>
        <label class="check"><input type="checkbox" checked=${form.autoMatch} onChange=${set('autoMatch')} />
          <span>Match payments to statements automatically when the amount fits exactly</span></label>
        <div><${AsyncButton} class="btn primary" onClick=${() => save(['reimbursementKeywords', 'senderFilters', 'incomeSenders', 'autoMatch'])}>Save<//></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Data</h2></div>
      <div class="card-body stack">
        <div class="row wrap">
          <${AsyncButton} class="btn" onClick=${() => attempt(() => download('/export/ledger?format=xlsx'))}>Download everything (Excel)<//>
          <${AsyncButton} class="btn" onClick=${() => attempt(() => download('/export/ledger?format=csv'))}>Statements summary (CSV)<//>
        </div>
        ${config?.demo
          ? html`<div class="row wrap"><span class="small muted">Demo mode: data lives in memory only.</span>
              <${AsyncButton} class="btn sm" onClick=${() => attempt(async () => refresh((await post('/demo/reset')).state), 'Demo data reset.')}>Reset demo data<//></div>`
          : null}
        ${user
          ? html`<div class="row wrap"><span class="small muted">Signed in as <b>${user.email}</b></span><button class="btn sm" onClick=${() => signOut()}>Sign out</button></div>`
          : null}
      </div>
    </div>

    ${config?.setup
      ? html`<div class="card">
          <div class="card-head"><h2>Server setup</h2><span class="small muted">What this deployment sees (names only)</span></div>
          <div class="card-body stack">
            ${config.problems?.length ? html`<div class="callout warn small"><ul style="margin:0;padding-left:18px">${config.problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : null}
            <${SetupStatus} config=${config} />
          </div>
        </div>`
      : null}

    <${RuleDialog} open=${ruleOpen} onClose=${() => setRuleOpen(false)} />
  </div>`;
}
