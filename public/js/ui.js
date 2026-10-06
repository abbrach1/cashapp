import { html, useEffect, useRef, useState } from '../vendor/preact.js';
import { money, STATUS } from './format.js';
import { toast, useStore } from './store.js';

export function Money({ cents, className = '', sign = false }) {
  return html`<span class=${`money ${cents < 0 ? 'neg' : ''} ${className}`}>${money(cents, { sign })}</span>`;
}

export function Pill({ status, label }) {
  const s = STATUS[status];
  return html`<span class=${`pill ${status}`} title=${s?.hint ?? ''}>${label ?? s?.label ?? status}</span>`;
}

export function Tile({ label, value, sub, accent = false, onClick }) {
  return html`<div class=${`tile ${accent ? 'accent' : ''}`} onClick=${onClick} style=${onClick ? 'cursor:pointer' : ''}>
    <div class="label">${label}</div>
    <div class="value">${value}</div>
    ${sub ? html`<div class="sub">${sub}</div>` : null}
  </div>`;
}

export function Progress({ value, max }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return html`<div class="progress" role="progressbar" aria-valuenow=${Math.round(pct)} aria-valuemin="0" aria-valuemax="100">
    <span style=${`width:${pct}%`}></span>
  </div>`;
}

/** Copy text to the clipboard (with a fallback for older browsers) and say so. */
export async function copyText(text, message = 'Copied.') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } finally {
      area.remove();
    }
  }
  toast(message);
}

/** A button that shows a spinner while its async onClick runs. */
export function AsyncButton({ onClick, children, class: cls = 'btn', disabled = false, title, type = 'button' }) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => (mounted.current = false), []);
  const run = async (e) => {
    if (busy) return;
    setBusy(true);
    try {
      await onClick?.(e);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return html`<button type=${type} class=${cls} disabled=${disabled || busy} onClick=${run} title=${title}>
    ${busy ? html`<span class="spinner" aria-hidden="true"></span>` : null}${children}
  </button>`;
}

export function Modal({ open, onClose, title, children, footer, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return html`<dialog ref=${ref} class=${`modal ${wide ? 'wide' : ''}`} onClose=${onClose} onCancel=${onClose}>
    ${open
      ? html`<div class="modal-head">
            <h2>${title}</h2>
            <button class="btn ghost icon" aria-label="Close" onClick=${onClose}>✕</button>
          </div>
          <div class="modal-body">${children}</div>
          ${footer ? html`<div class="modal-foot">${footer}</div>` : null}`
      : null}
  </dialog>`;
}

export function Menu({ label, children, class: cls = 'btn', align = 'right', title }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return html`<div class="menu" ref=${ref}>
    <button type="button" class=${cls} aria-haspopup="menu" aria-expanded=${open} title=${title} onClick=${() => setOpen(!open)}>${label}</button>
    ${open ? html`<div class=${`menu-panel ${align === 'left' ? 'left' : ''}`} role="menu" onClick=${() => setOpen(false)}>${children}</div>` : null}
  </div>`;
}

export function Toasts() {
  const { toasts } = useStore();
  return html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.map((t) => html`<div key=${t.id} class=${`toast ${t.kind}`}>${t.message}</div>`)}
  </div>`;
}

export function Empty({ title, children, icon = '✦' }) {
  return html`<div class="empty">
    <div style="font-size:1.6rem;margin-bottom:6px">${icon}</div>
    <h3>${title}</h3>
    <div>${children}</div>
  </div>`;
}

export function Field({ label, hint, children }) {
  return html`<label class="field">
    <span>${label}</span>
    ${children}
    ${hint ? html`<span class="hint">${hint}</span>` : null}
  </label>`;
}

export function Skeleton({ height = 16, width = '100%', style = '' }) {
  return html`<div class="skeleton" style=${`height:${height}px;width:${width};${style}`}></div>`;
}

export function LoadingPage() {
  return html`<div class="stack-lg">
    <${Skeleton} height=${34} width="40%" />
    <div class="tiles">${[1, 2, 3, 4].map((i) => html`<${Skeleton} key=${i} height=${88} />`)}</div>
    <${Skeleton} height=${280} />
  </div>`;
}
