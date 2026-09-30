import { html } from '../../vendor/preact.js';

/**
 * What the server can see of its configuration: variable names with ✓/✗
 * (never their values) and which Vercel deployment this is.
 */
export function SetupStatus({ config }) {
  const setup = config?.setup;
  if (!setup) return null;
  const d = setup.deployment ?? {};
  return html`<div class="setup-status">
    ${d.vercelEnv
      ? html`<div class="small">
          This is the <b>${d.vercelEnv}</b> deployment${d.branch ? html` of branch <code>${d.branch}</code>` : null}${d.commit ? html` (${d.commit})` : null}.
        </div>`
      : null}
    <ul class="checklist">
      ${setup.checklist.map((i) => {
        const state = i.invalid ? 'bad' : i.set ? 'ok' : i.required ? 'bad' : 'opt';
        const note = i.invalid ? 'invalid value' : i.set ? (i.detail ?? 'set') : i.required ? 'missing' : 'not set (optional)';
        return html`<li class=${state} key=${i.name}>
          <span class="mark" aria-hidden="true">${state === 'ok' ? '✓' : state === 'bad' ? '✗' : '–'}</span>
          <code>${i.name}</code>
          <span class="note">${note}</span>
        </li>`;
      })}
    </ul>
    <p class="tiny muted" style="margin:0">
      Vercel applies environment variables only to new deployments: after adding or changing one, open${' '}
      <b>Deployments → ⋯ → Redeploy</b>. Also check each variable is enabled for the environment you are opening (Production or Preview).
    </p>
  </div>`;
}
