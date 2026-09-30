// How much of each card transaction is claimed from the company.
//
// Default: everything is reimbursable. Exceptions, strongest first:
//   1. your per-transaction choice (exclude / claim part / force include)
//   2. an "always exclude" rule matching the description
//   3. card fees & interest, rewards redemptions (configurable)
// Card payments are not expenses and are never part of a claim.

import { UserError } from './errors.js';

/**
 * @typedef {{
 *   applicable: boolean,
 *   claimCents: number,
 *   status: 'claimed'|'partial'|'excluded'|'n/a',
 *   reason: 'default'|'included'|'excluded'|'partial'|'rule'|'fee'|'reward'|'payment',
 *   ruleId?: string,
 * }} ClaimInfo
 */

export function ruleMatches(rule, txn) {
  if (rule.accountId && rule.accountId !== txn.accountId) return false;
  const pattern = String(rule.pattern ?? '').trim().toLowerCase();
  if (!pattern) return false;
  return [txn.description, txn.merchant, txn.rawDescription].some((s) => s && s.toLowerCase().includes(pattern));
}

/**
 * @param {any} txn
 * @param {{ rules: any[], settings: Record<string, any> }} ctx
 * @returns {ClaimInfo}
 */
export function claimInfo(txn, ctx) {
  const amount = txn.amountCents;
  if (txn.kind === 'payment') return { applicable: false, claimCents: 0, status: 'n/a', reason: 'payment' };

  const make = (claimCents, reason, extra = {}) => ({
    applicable: true,
    claimCents,
    status: claimCents === 0 && amount !== 0 ? 'excluded' : claimCents === amount ? 'claimed' : 'partial',
    reason,
    ...extra,
  });

  if (txn.override === 'exclude') return make(0, 'excluded');
  if (txn.override === 'include') return make(amount, 'included');
  if (txn.override === 'partial' && Number.isInteger(txn.claimCents)) return make(txn.claimCents, 'partial');

  const rule = ctx.rules.find((r) => ruleMatches(r, txn));
  if (rule) return make(0, 'rule', { ruleId: rule.id });
  if ((txn.kind === 'fee' || txn.kind === 'interest') && ctx.settings.excludeFeesByDefault) return make(0, 'fee');
  if (txn.kind === 'reward' && ctx.settings.excludeRewardsByDefault) return make(0, 'reward');
  return make(amount, 'default');
}

/**
 * Validate a user's change to a transaction's claim.
 * @param {any} txn
 * @param {{ override?: string|null, claimCents?: number|null, note?: string|null }} input
 */
export function sanitizeClaimChange(txn, input) {
  /** @type {Record<string, any>} */
  const out = {};
  if ('note' in input) {
    if (input.note !== null && typeof input.note !== 'string') throw new UserError('Note must be text');
    out.note = input.note ? input.note.trim().slice(0, 500) || null : null;
  }
  if ('override' in input) {
    const o = input.override;
    if (txn.kind === 'payment' && o) throw new UserError('Card payments are not expenses and cannot be claimed');
    if (o === null || o === 'default') {
      out.override = null;
      out.claimCents = null;
    } else if (o === 'include' || o === 'exclude') {
      out.override = o;
      out.claimCents = null;
    } else if (o === 'partial') {
      const c = input.claimCents;
      if (!Number.isInteger(c)) throw new UserError('Enter the amount to claim');
      const amount = txn.amountCents;
      if (Math.sign(c) !== Math.sign(amount) && c !== 0) throw new UserError('Claim amount must have the same sign as the transaction');
      if (Math.abs(c) > Math.abs(amount)) throw new UserError('Claim amount cannot be more than the transaction');
      if (c === 0) {
        out.override = 'exclude';
        out.claimCents = null;
      } else if (c === amount) {
        out.override = 'include';
        out.claimCents = null;
      } else {
        out.override = 'partial';
        out.claimCents = c;
      }
    } else {
      throw new UserError('Unknown claim option');
    }
  }
  return out;
}
