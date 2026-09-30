import { applyStatementInfo, planAccountBills } from './bills.js';
import { buildLedger } from './ledger.js';
import { autoMatch, detectReimbursements, pruneDanglingAllocations } from './reimbursements.js';
import { getSettings } from './settings.js';

function allocatedBillIds(uow) {
  const ids = new Set();
  for (const r of uow.list('reimbursements')) for (const a of r.allocations ?? []) ids.add(a.billId);
  return ids;
}

/**
 * Bring derived records up to date after any change: statement cycles, bank
 * statement data, detected Zelle payments and automatic matches.
 * Idempotent: running it twice in a row changes nothing the second time.
 * @param {import('../store/model.js').UnitOfWork} uow
 * @param {{ today: string }} opts
 */
export function reconcile(uow, { today }) {
  const settings = getSettings(uow.view);
  pruneDanglingAllocations(uow);

  const plan = () => {
    const allocated = allocatedBillIds(uow);
    for (const account of uow.list('accounts')) {
      planAccountBills(uow, account, { today, trackingStart: settings.trackingStartDate, allocatedBillIds: allocated });
    }
  };
  plan();
  const withStatements = uow.list('accounts').filter((a) => a.role === 'expenses' && a.stmtDate);
  if (withStatements.length) {
    for (const account of withStatements) applyStatementInfo(uow, account);
    plan(); // fill any gap left by a moved closing date
  }

  detectReimbursements(uow, settings);
  autoMatch(uow, buildLedger(uow.view, { today }));
}
