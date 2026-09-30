import express from 'express';
import { todayISO, isISODate } from '../lib/dates.js';
import { newId } from '../lib/ids.js';
import { UserError, NotFoundError } from '../core/errors.js';
import { buildLedger } from '../core/ledger.js';
import { reconcile } from '../core/reconcile.js';
import { claimInfo, sanitizeClaimChange } from '../core/claims.js';
import { getSettings, sanitizeSettingsPatch } from '../core/settings.js';
import { setClosingDate } from '../core/bills.js';
import { addManualReimbursement, setAllocations } from '../core/reimbursements.js';
import { ingest, defaultRole } from '../core/ingest.js';
import { connectPlaid, connectSimplefin, disconnect, plaidLinkToken, syncAll, syncConnection } from '../core/sync.js';
import { parseChaseCSV } from '../providers/chaseCsv.js';
import { billReport } from '../exports/report.js';
import { companyCSV, ledgerCSV, trackingCSV } from '../exports/csv.js';
import { billDetailView, stateView, txnView } from '../views.js';
import { seedDemo } from '../demo/seed.js';

const ROLES = ['expenses', 'reimbursements', 'ignore'];
const KINDS = ['credit', 'checking', 'savings', 'other'];

/**
 * @param {{
 *   config: import('../config.js').Config,
 *   store: import('../store/base.js').BaseStore,
 *   plaid: () => Promise<any>,
 *   fetch?: typeof fetch,
 *   today?: () => string,
 * }} deps
 */
export function apiRouter(deps) {
  const { config, store } = deps;
  const today = deps.today ?? (() => todayISO(config.timezone));
  const router = express.Router();

  /**
   * Load and compute. Seeds the demo on first visit, and remembers the signed-in
   * email (the daily cron only syncs users whose email is still allowed).
   */
  async function load(uid, email = null) {
    let snapshot = await store.load(uid);
    if ((config.demo && !snapshot.rev) || (email && snapshot.meta?.email !== email)) {
      ({ snapshot } = await store.mutate(uid, (uow) => {
        if (config.demo && !uow.view.rev) seedDemo(uow, { today: today() });
        if (email && uow.view.meta.email !== email) uow.patchMeta({ email });
      }));
    }
    return { snapshot, ledger: buildLedger(snapshot, { today: today() }) };
  }

  /** Apply a change, reconcile, and answer with fresh state. */
  async function change(req, fn) {
    const { result, snapshot } = await store.mutate(req.uid, async (uow) => {
      if (req.email && uow.view.meta.email !== req.email) uow.patchMeta({ email: req.email });
      const r = await fn(uow);
      reconcile(uow, { today: today() });
      return r;
    });
    const ledger = buildLedger(snapshot, { today: today() });
    return { result, snapshot, ledger, state: stateView(snapshot, ledger) };
  }

  const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

  /**
   * 'claim' / 'unclaim' mean "make it so": clear the exception when the
   * default already gives that result, otherwise set one.
   */
  const resolveToggle = (uow, txn, override) => {
    if (override !== 'claim' && override !== 'unclaim') return override;
    const ctx = { rules: uow.list('rules'), settings: getSettings(uow.view) };
    const defaultClaimed = claimInfo({ ...txn, override: null, claimCents: null }, ctx).claimCents !== 0;
    const want = override === 'claim';
    return defaultClaimed === want ? null : want ? 'include' : 'exclude';
  };
  const optionalDate = (v, label) => {
    if (v === null || v === '' || v === undefined) return null;
    if (!isISODate(v)) throw new UserError(`${label} must be a date (YYYY-MM-DD)`);
    return v;
  };
  const optionalCents = (v, label) => {
    if (v === null || v === undefined || v === '') return null;
    if (!Number.isInteger(v)) throw new UserError(`${label} must be an amount in cents`);
    return v;
  };

  // ---- state -------------------------------------------------------------

  router.get('/state', async (req, res) => {
    const { snapshot, ledger } = await load(req.uid, req.email);
    res.json(stateView(snapshot, ledger));
  });

  router.get('/bills/:id', async (req, res) => {
    const { snapshot, ledger } = await load(req.uid);
    const detail = billDetailView(snapshot, ledger, req.params.id);
    if (!detail) throw new NotFoundError('Bill not found');
    res.json(detail);
  });

  router.get('/transactions', async (req, res) => {
    const { snapshot, ledger } = await load(req.uid);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const { accountId, from, to, status } = req.query;
    const limit = Math.min(Number(req.query.limit) || 300, 1000);
    const rows = [];
    const sorted = [...snapshot.txns.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    let total = 0;
    for (const t of sorted) {
      if (accountId && t.accountId !== accountId) continue;
      if (from && t.date < from) continue;
      if (to && t.date > to) continue;
      if (q) {
        const hay = `${t.description} ${t.merchant ?? ''} ${t.rawDescription ?? ''} ${t.note ?? ''} ${t.category ?? ''} ${(Math.abs(t.amountCents) / 100).toFixed(2)}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const view = txnView(t, ledger);
      if (status && view.claim.status !== status) continue;
      total++;
      if (rows.length < limit) rows.push(view);
    }
    res.json({ transactions: rows, total });
  });

  // ---- transactions --------------------------------------------------------

  router.post('/transactions/bulk', async (req, res) => {
    const { ids, override } = body(req);
    if (!Array.isArray(ids) || !ids.length) throw new UserError('Select some transactions first');
    if (![null, 'include', 'exclude', 'claim', 'unclaim'].includes(override ?? null)) throw new UserError('Unknown option');
    const { result, state } = await change(req, (uow) => {
      let changed = 0;
      for (const id of ids.slice(0, 1000)) {
        const t = uow.getTxn(id);
        if (!t || t.kind === 'payment') continue;
        const patch = sanitizeClaimChange(t, { override: resolveToggle(uow, t, override ?? null) });
        if (patch.override === (t.override ?? null) && patch.claimCents === (t.claimCents ?? null)) continue;
        uow.patchTxn(id, { ...patch, updatedAt: new Date().toISOString() });
        changed++;
      }
      return changed;
    });
    res.json({ ok: true, changed: result, state });
  });

  router.post('/transactions/:id', async (req, res) => {
    const input = body(req);
    const { snapshot, ledger, state } = await change(req, (uow) => {
      const t = uow.getTxn(req.params.id);
      if (!t) throw new NotFoundError('Transaction not found');
      const patch = sanitizeClaimChange(t, 'override' in input ? { ...input, override: resolveToggle(uow, t, input.override) } : input);
      if (Object.keys(patch).length) uow.patchTxn(t.id, { ...patch, updatedAt: new Date().toISOString() });
    });
    const t = snapshot.txns.get(req.params.id);
    const billId = ledger.txnBill.get(t.id);
    res.json({ ok: true, transaction: txnView(t, ledger), bill: billId ? billDetailView(snapshot, ledger, billId) : null, state });
  });

  // ---- bills ---------------------------------------------------------------

  router.post('/bills/:id', async (req, res) => {
    const input = body(req);
    const { snapshot, ledger, state } = await change(req, (uow) => {
      const bill = uow.get('bills', req.params.id);
      if (!bill) throw new NotFoundError('Bill not found');
      const patch = {};
      if ('submittedOn' in input) patch.submittedOn = optionalDate(input.submittedOn, 'Submitted date');
      if ('paidState' in input) {
        if (![null, 'paid', 'unpaid'].includes(input.paidState)) throw new UserError('Unknown paid option');
        patch.paidState = input.paidState;
        patch.paidOn = input.paidState === 'paid' ? optionalDate(input.paidOn ?? today(), 'Paid date') : null;
      }
      if ('note' in input) patch.note = input.note ? String(input.note).trim().slice(0, 1000) || null : null;
      if ('dueDate' in input) patch.dueDate = optionalDate(input.dueDate, 'Due date');
      if ('stmtBalanceCents' in input) patch.stmtBalanceCents = optionalCents(input.stmtBalanceCents, 'Statement balance');
      if (Object.keys(patch).length) uow.patch('bills', bill.id, patch);
      if ('end' in input && input.end !== bill.end) {
        if (!isISODate(input.end)) throw new UserError('Closing date must be a date');
        setClosingDate(uow, bill.id, input.end);
      }
    });
    res.json({ ok: true, bill: billDetailView(snapshot, ledger, req.params.id), state });
  });

  // ---- accounts ------------------------------------------------------------

  router.post('/accounts/:id', async (req, res) => {
    const input = body(req);
    const { state } = await change(req, (uow) => {
      const account = uow.get('accounts', req.params.id);
      if (!account) throw new NotFoundError('Account not found');
      const patch = {};
      if ('nickname' in input) patch.nickname = input.nickname ? String(input.nickname).trim().slice(0, 60) || null : null;
      if ('role' in input) {
        if (!ROLES.includes(input.role)) throw new UserError('Unknown account role');
        patch.role = input.role;
      }
      if ('kind' in input) {
        if (!KINDS.includes(input.kind)) throw new UserError('Unknown account type');
        patch.kind = input.kind;
      }
      for (const key of ['closingDay', 'dueDay']) {
        if (!(key in input)) continue;
        const v = input[key];
        if (v === null || v === '') patch[key] = null;
        else if (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 31) patch[key] = Number(v);
        else throw new UserError('Day of month must be between 1 and 31');
      }
      uow.patch('accounts', account.id, patch);
    });
    res.json({ ok: true, state });
  });

  router.delete('/accounts/:id', async (req, res) => {
    const { state } = await change(req, (uow) => {
      const account = uow.get('accounts', req.params.id);
      if (!account) throw new NotFoundError('Account not found');
      if (account.connectionId) throw new UserError('Disconnect the bank connection first, or set this account to "Ignore"');
      for (const t of [...uow.view.txns.values()]) if (t.accountId === account.id) uow.deleteTxn(t.id);
      for (const b of uow.list('bills')) if (b.accountId === account.id) uow.delete('bills', b.id);
      for (const r of uow.list('reimbursements')) if (r.accountId === account.id && !(r.allocations?.length)) uow.delete('reimbursements', r.id);
      for (const r of uow.list('rules')) if (r.accountId === account.id) uow.delete('rules', r.id);
      uow.delete('accounts', account.id);
    });
    res.json({ ok: true, state });
  });

  // ---- settings & rules ----------------------------------------------------

  router.post('/settings', async (req, res) => {
    const patch = sanitizeSettingsPatch(body(req));
    const { state } = await change(req, (uow) => uow.patchSettings(patch));
    res.json({ ok: true, state });
  });

  router.post('/rules', async (req, res) => {
    const { pattern, accountId = null, note = null } = body(req);
    const p = String(pattern ?? '').trim();
    if (p.length < 2) throw new UserError('Enter at least 2 characters to match');
    const { state } = await change(req, (uow) => {
      if (accountId && !uow.get('accounts', accountId)) throw new UserError('Unknown account');
      uow.put('rules', { id: newId('x'), pattern: p.slice(0, 80), accountId, note: note ? String(note).slice(0, 200) : null, action: 'exclude', createdAt: new Date().toISOString() });
    });
    res.json({ ok: true, state });
  });

  router.delete('/rules/:id', async (req, res) => {
    const { state } = await change(req, (uow) => {
      if (!uow.get('rules', req.params.id)) throw new NotFoundError('Rule not found');
      uow.delete('rules', req.params.id);
    });
    res.json({ ok: true, state });
  });

  // ---- reimbursements --------------------------------------------------------

  router.post('/reimbursements', async (req, res) => {
    const { result, state } = await change(req, (uow) => addManualReimbursement(uow, body(req)));
    res.json({ ok: true, id: result, state });
  });

  router.post('/reimbursements/:id', async (req, res) => {
    const input = body(req);
    const { state } = await change(req, (uow) => {
      const r = uow.get('reimbursements', req.params.id);
      if (!r) throw new NotFoundError('Reimbursement not found');
      const patch = {};
      if ('status' in input) {
        if (!['active', 'ignored'].includes(input.status)) throw new UserError('Unknown status');
        patch.status = input.status;
        patch.manual = true;
        if (input.status === 'ignored') patch.allocations = [];
      }
      if ('note' in input) patch.note = input.note ? String(input.note).trim().slice(0, 500) || null : null;
      if ('sender' in input) patch.sender = input.sender ? String(input.sender).trim().slice(0, 120) || null : null;
      uow.patch('reimbursements', r.id, patch);
    });
    res.json({ ok: true, state });
  });

  router.put('/reimbursements/:id/allocations', async (req, res) => {
    const { allocations } = body(req);
    const { state } = await change(req, (uow) => setAllocations(uow, req.params.id, allocations));
    res.json({ ok: true, state });
  });

  router.post('/reimbursements/:id/accept-suggestion', async (req, res) => {
    const { ledger } = await load(req.uid);
    const r = ledger.reimbursements.get(req.params.id);
    if (!r) throw new NotFoundError('Reimbursement not found');
    if (!r.suggestion.length) throw new UserError('There is nothing to suggest for this payment');
    const merged = [...r.allocations.map(({ billId, amountCents }) => ({ billId, amountCents })), ...r.suggestion];
    const { state } = await change(req, (uow) => setAllocations(uow, r.id, merged));
    res.json({ ok: true, state });
  });

  router.delete('/reimbursements/:id', async (req, res) => {
    const { state } = await change(req, (uow) => {
      const r = uow.get('reimbursements', req.params.id);
      if (!r) throw new NotFoundError('Reimbursement not found');
      if (r.txnId) throw new UserError('This payment came from your bank; mark it as "Not a reimbursement" instead');
      uow.delete('reimbursements', r.id);
    });
    res.json({ ok: true, state });
  });

  // ---- CSV import --------------------------------------------------------------

  router.post('/import/csv/preview', async (req, res) => {
    const { content, filename } = body(req);
    const parsed = parseChaseCSV(String(content ?? ''), String(filename ?? ''));
    const { snapshot } = await load(req.uid);
    const match = [...snapshot.accounts.values()].find((a) => parsed.mask && a.mask === parsed.mask);
    const dates = parsed.rows.map((r) => r.date).sort();
    res.json({
      kind: parsed.kind,
      mask: parsed.mask,
      rows: parsed.rows.length,
      from: dates[0],
      to: dates[dates.length - 1],
      suggestedAccountId: match?.id ?? null,
      warnings: parsed.errors.slice(0, 5),
    });
  });

  router.post('/import/csv', async (req, res) => {
    const { content, filename, accountId, newAccount } = body(req);
    const parsed = parseChaseCSV(String(content ?? ''), String(filename ?? ''));
    const { result, state } = await change(req, (uow) => {
      let target = accountId ? uow.get('accounts', accountId) : null;
      if (accountId && !target) throw new UserError('Unknown account');
      if (!target) {
        const kind = KINDS.includes(newAccount?.kind) ? newAccount.kind : parsed.kind === 'other' ? 'credit' : parsed.kind;
        const mask = String(newAccount?.mask ?? parsed.mask ?? '').replace(/\D/g, '').slice(-4) || null;
        target = uow.put('accounts', {
          id: newId('a'),
          name: String(newAccount?.name ?? '').trim().slice(0, 60) || (kind === 'credit' ? 'Chase card' : 'Chase checking'),
          nickname: null,
          mask,
          kind,
          role: defaultRole(kind),
          institution: 'Chase',
          connectionId: null,
          externalId: null,
          source: 'csv',
          closingDay: Number.isInteger(newAccount?.closingDay) ? newAccount.closingDay : null,
          dueDay: null,
          createdAt: new Date().toISOString(),
        });
      }
      const stats = ingest(uow, {
        source: 'csv',
        connectionId: null,
        accounts: [],
        accountIds: { csv: target.id },
        upserts: parsed.rows.map((r) => ({ ...r, accountExternalId: 'csv', externalId: `${target.id}|${r.externalId}` })),
      });
      return { accountId: target.id, ...stats, warnings: parsed.errors.slice(0, 5) };
    });
    res.json({ ok: true, ...result, state });
  });

  // ---- bank connections -------------------------------------------------------

  router.post('/plaid/link-token', async (req, res) => {
    const linkToken = await plaidLinkToken(deps, req.uid, body(req).connectionId ?? null);
    res.json({ linkToken });
  });

  router.post('/plaid/exchange', async (req, res) => {
    const { publicToken, institution } = body(req);
    const out = await connectPlaid(deps, req.uid, { publicToken, institution });
    const { snapshot, ledger } = await load(req.uid);
    res.json({ ok: true, ...out, state: stateView(snapshot, ledger) });
  });

  router.post('/simplefin/connect', async (req, res) => {
    const out = await connectSimplefin(deps, req.uid, { setupToken: body(req).setupToken });
    const { snapshot, ledger } = await load(req.uid);
    res.json({ ok: true, ...out, state: stateView(snapshot, ledger) });
  });

  router.post('/sync', async (req, res) => {
    const { force = false, staleMinutes } = body(req);
    const results = await syncAll(deps, req.uid, {
      force: Boolean(force),
      staleMinutes: staleMinutes === undefined ? undefined : Math.max(5, Number(staleMinutes) || 0),
    });
    const { snapshot, ledger } = await load(req.uid);
    res.json({ ok: true, results, state: stateView(snapshot, ledger) });
  });

  router.post('/connections/:id/sync', async (req, res) => {
    const result = await syncConnection(deps, req.uid, req.params.id, { force: true });
    const { snapshot, ledger } = await load(req.uid);
    res.json({ ok: true, result, state: stateView(snapshot, ledger) });
  });

  router.delete('/connections/:id', async (req, res) => {
    await disconnect(deps, req.uid, req.params.id);
    const { snapshot, ledger } = await load(req.uid);
    res.json({ ok: true, state: stateView(snapshot, ledger) });
  });

  // ---- exports -------------------------------------------------------------------

  router.get('/export/bills/:id', async (req, res) => {
    const { snapshot, ledger } = await load(req.uid);
    const report = billReport(snapshot, ledger, req.params.id);
    const format = String(req.query.format ?? 'pdf');
    const audience = req.query.audience === 'tracking' ? 'tracking' : 'company';
    const includeExcluded = req.query.personal === '1' || req.query.personal === 'true';
    const base = audience === 'tracking' ? `${report.filenameBase}_tracking` : report.filenameBase;
    if (format === 'csv') {
      send(res, `${base}.csv`, 'text/csv; charset=utf-8', audience === 'tracking' ? trackingCSV(report) : companyCSV(report, { includeExcluded }));
    } else if (format === 'xlsx') {
      const { companyXLSX, trackingXLSX } = await import('../exports/xlsx.js');
      const buf = audience === 'tracking' ? await trackingXLSX(report) : await companyXLSX(report, { includeExcluded });
      send(res, `${base}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf);
    } else if (format === 'pdf') {
      const { companyPDF } = await import('../exports/pdf.js');
      send(res, `${report.filenameBase}.pdf`, 'application/pdf', await companyPDF(report, { includeExcluded }));
    } else {
      throw new UserError('Unknown export format');
    }
  });

  router.get('/export/ledger', async (req, res) => {
    const { snapshot, ledger } = await load(req.uid);
    const stamp = ledger.today;
    if (req.query.format === 'csv') {
      send(res, `Reimbursements_${stamp}.csv`, 'text/csv; charset=utf-8', ledgerCSV(snapshot, ledger));
    } else {
      const { ledgerXLSX } = await import('../exports/xlsx.js');
      send(res, `Reimbursements_${stamp}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', await ledgerXLSX(snapshot, ledger));
    }
  });

  // ---- demo --------------------------------------------------------------------

  router.post('/demo/reset', async (req, res) => {
    if (!config.demo) throw new UserError('Only available in demo mode', 404);
    const { snapshot } = await store.mutate(req.uid, (uow) => {
      for (const kind of ['connections', 'accounts', 'bills', 'reimbursements', 'rules']) for (const e of uow.list(kind)) uow.delete(kind, e.id);
      for (const t of [...uow.view.txns.values()]) uow.deleteTxn(t.id);
      uow.replaceSettings({});
      seedDemo(uow, { today: today() });
    });
    res.json({ ok: true, state: stateView(snapshot, buildLedger(snapshot, { today: today() })) });
  });

  return router;
}

function send(res, filename, type, data) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\-]/g, '_')}"`);
  res.send(data);
}
