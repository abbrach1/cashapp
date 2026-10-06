import { isISODate } from '../lib/dates.js';
import { UserError } from './errors.js';

export const DEFAULT_SETTINGS = Object.freeze({
  yourName: '',
  yourEmail: '',
  companyName: '',
  companyEmail: '',
  // Where the company should send money (shown on the report).
  zelleHandle: '',
  // An incoming deposit counts as a reimbursement when its description contains
  // one of these words ("QUICKPAY" is how older Chase exports label Zelle)...
  reimbursementKeywords: ['zelle', 'quickpay'],
  // ...and, if any are listed, one of these sender names.
  senderFilters: [],
  // Money from these senders pays for your services (income): kept in your
  // records, never counted as a reimbursement.
  incomeSenders: [],
  // Only statements closing on or after this date are tracked.
  trackingStartDate: null,
  // Card fees/interest and rewards redemptions are not expenses you made for
  // the company, so they start out excluded. Everything else is claimed.
  excludeFeesByDefault: true,
  excludeRewardsByDefault: true,
  // Match an incoming Zelle to a bill automatically when the amount fits exactly.
  autoMatch: true,
  reportTitle: 'Expense Reimbursement Request',
});

/** @param {{ settings: Record<string, any> }} snapshot */
export function getSettings(snapshot) {
  return { ...DEFAULT_SETTINGS, ...snapshot.settings };
}

const TEXT_FIELDS = ['yourName', 'yourEmail', 'companyName', 'companyEmail', 'zelleHandle', 'reportTitle'];
const LIST_FIELDS = ['reimbursementKeywords', 'senderFilters', 'incomeSenders'];
const BOOL_FIELDS = ['excludeFeesByDefault', 'excludeRewardsByDefault', 'autoMatch'];

/**
 * Validate a settings update coming from the UI. Unknown keys are rejected.
 * @param {Record<string, unknown>} input
 */
export function sanitizeSettingsPatch(input) {
  if (!input || typeof input !== 'object') throw new UserError('Invalid settings');
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (TEXT_FIELDS.includes(key)) {
      if (typeof value !== 'string') throw new UserError(`${key} must be text`);
      out[key] = value.trim().slice(0, 200);
    } else if (LIST_FIELDS.includes(key)) {
      const list = Array.isArray(value) ? value : String(value ?? '').split(',');
      out[key] = [...new Set(list.map((v) => String(v).trim()).filter(Boolean))].slice(0, 20);
    } else if (BOOL_FIELDS.includes(key)) {
      out[key] = Boolean(value);
    } else if (key === 'trackingStartDate') {
      if (value === null || value === '') out[key] = null;
      else if (isISODate(value)) out[key] = value;
      else throw new UserError('Tracking start date must be YYYY-MM-DD');
    } else {
      throw new UserError(`Unknown setting: ${key}`);
    }
  }
  return out;
}
