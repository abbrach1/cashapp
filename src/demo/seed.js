// Realistic sample data so the app can be tried without connecting a bank.
// Dates are relative to "today", so the demo always looks current.

import { addDays, clampedDate, parseISO, shiftMonth } from '../lib/dates.js';
import { ingest } from '../core/ingest.js';
import { reconcile } from '../core/reconcile.js';
import { buildLedger } from '../core/ledger.js';
import { setAllocations } from '../core/reimbursements.js';
import { newId } from '../lib/ids.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORK = [
  ['DELTA AIR LINES', 'Delta Air Lines', 'Travel', 28000, 64000],
  ['UNITED 0162', 'United Airlines', 'Travel', 21000, 52000],
  ['MARRIOTT BOSTON COPLEY', 'Marriott', 'Travel', 31000, 78000],
  ['HILTON GARDEN INN', 'Hilton', 'Travel', 18000, 42000],
  ['UBER *TRIP HELP.UBER.COM', 'Uber', 'Travel', 1400, 6800],
  ['LYFT *RIDE', 'Lyft', 'Travel', 1200, 5200],
  ['SWEETGREEN', 'Sweetgreen', 'Food & Drink', 1300, 2400],
  ['THE CAPITAL GRILLE', 'The Capital Grille', 'Food & Drink', 9000, 26000],
  ['STARBUCKS STORE 11923', 'Starbucks', 'Food & Drink', 450, 1400],
  ['ZOOM.US 888-799-9666', 'Zoom', 'Bills & Utilities', 1599, 1599],
  ['ADOBE *CREATIVE CLOUD', 'Adobe', 'Shopping', 5999, 5999],
  ['AMAZON MKTPL*2K4', 'Amazon', 'Shopping', 1800, 14000],
  ['STAPLES 00123', 'Staples', 'Shopping', 2200, 9000],
  ['PARKWHIZ', 'ParkWhiz', 'Travel', 1500, 4500],
  ['AWS EMEA', 'Amazon Web Services', 'Professional Services', 2400, 11000],
];

const PERSONAL = [
  ['NETFLIX.COM', 'Netflix', 'Entertainment', 1549],
  ['WHOLEFDS MKT 10432', 'Whole Foods', 'Groceries', 8641],
  ['SPOTIFY USA', 'Spotify', 'Entertainment', 1199],
];

/**
 * Fill a UnitOfWork with a complete demo dataset.
 * @param {import('../store/model.js').UnitOfWork} uow
 * @param {{ today: string }} opts
 */
export function seedDemo(uow, { today }) {
  const random = rng(20260930);
  const between = (lo, hi) => lo + Math.round(random() * (hi - lo));
  const pick = (list) => list[Math.floor(random() * list.length)];
  const { y, m } = parseISO(today);
  const start = shiftMonth(y, m, -5);
  const trackingStart = clampedDate(start.y, start.m, 1);

  uow.patchSettings({
    yourName: 'Alex Morgan',
    yourEmail: 'alex.morgan@example.com',
    companyName: 'Northwind Consulting',
    companyEmail: 'expenses@northwind.example',
    zelleHandle: 'alex.morgan@example.com',
    senderFilters: ['northwind'],
    trackingStartDate: trackingStart,
  });
  uow.patchMeta({ demo: true });

  const cards = [
    { externalId: 'demo-sapphire', name: 'Sapphire Preferred', mask: '4821', kind: 'credit', institution: 'Chase', closingDay: 14, dueDay: 11 },
    { externalId: 'demo-freedom', name: 'Freedom Unlimited', mask: '7730', kind: 'credit', institution: 'Chase', closingDay: 3, dueDay: 28 },
  ];
  const checking = { externalId: 'demo-checking', name: 'Total Checking', mask: '9912', kind: 'checking', institution: 'Chase' };
  const connectionId = null;

  const upserts = [];
  let n = 0;
  const add = (card, date, amountCents, description, merchant, category, extra = {}) => {
    if (date > today) return;
    upserts.push({ accountExternalId: card.externalId, externalId: `demo-${++n}`, date, authDate: addDays(date, -1), description, merchant, category, amountCents, ...extra });
  };

  // Card activity for ~5 months.
  for (const card of cards) {
    const weight = card.mask === '4821' ? 1 : 0.35;
    for (let d = addDays(trackingStart, -20); d <= today; d = addDays(d, 1)) {
      if (random() < 0.42 * weight) {
        const [description, merchant, category, lo, hi] = pick(WORK);
        add(card, d, between(lo, hi), description, merchant, category);
      }
    }
  }
  const sapphire = cards[0];
  for (let i = 0; i < 6; i++) {
    const mo = shiftMonth(start.y, start.m, i);
    add(sapphire, clampedDate(mo.y, mo.m, 9), 1549, ...PERSONAL[0].slice(0, 3));
    if (i % 2 === 0) add(sapphire, clampedDate(mo.y, mo.m, 18), 8641 + i * 313, ...PERSONAL[1].slice(0, 3));
  }
  const feeMonth = shiftMonth(start.y, start.m, 2);
  add(sapphire, clampedDate(feeMonth.y, feeMonth.m, 22), 9500, 'ANNUAL MEMBERSHIP FEE', null, 'Fees & Adjustments', { bankType: 'Fee' });
  const refundMonth = shiftMonth(y, m, -2);
  add(sapphire, clampedDate(refundMonth.y, refundMonth.m, 26), -8400, 'MARRIOTT BOSTON COPLEY', 'Marriott', 'Travel', { bankType: 'Return' });

  const cardAccounts = cards.map(({ closingDay: _c, dueDay: _d, ...pa }) => pa);
  ingest(uow, { source: 'demo', connectionId, accounts: [...cardAccounts, checking], upserts });
  for (const card of cards) {
    const account = uow.list('accounts').find((a) => a.externalId === card.externalId);
    uow.patch('accounts', account.id, { closingDay: card.closingDay, dueDay: card.dueDay });
  }
  reconcile(uow, { today });

  // A few exceptions, the way a user would make them.
  const txns = [...uow.view.txns.values()];
  const find = (pred) => txns.filter(pred).sort((a, b) => (a.date < b.date ? -1 : 1));
  uow.put('rules', { id: newId('x'), pattern: 'NETFLIX', accountId: null, note: 'Personal streaming', createdAt: new Date().toISOString() });
  for (const t of find((t) => t.merchant === 'Whole Foods')) uow.patchTxn(t.id, { override: 'exclude', note: 'Groceries for home' });
  const dinner = find((t) => t.merchant === 'The Capital Grille')[0];
  if (dinner) uow.patchTxn(dinner.id, { override: 'partial', claimCents: Math.round(dinner.amountCents * 0.6), note: 'Client dinner – my partner’s share not claimed' });
  const flight = find((t) => t.merchant === 'Delta Air Lines')[0];
  if (flight) uow.patchTxn(flight.id, { note: 'Kickoff with client in Boston' });
  const hotel = find((t) => t.merchant === 'Marriott' && t.amountCents > 0)[0];
  if (hotel) uow.patchTxn(hotel.id, { note: 'Client workshop, 2 nights' });

  // Card payments (autopay of the statement balance) and company Zelles.
  let ledger = buildLedger(uow.view, { today });
  const payments = [];
  const bankUpserts = [];
  const closed = [...ledger.bills.values()].filter((b) => !b.isOpen && b.visible).sort((a, b) => (a.end < b.end ? -1 : 1));
  const latestClosed = new Map();
  for (const b of closed) latestClosed.set(b.accountId, b);
  for (const b of closed) {
    const account = uow.get('accounts', b.accountId);
    const payDate = addDays(b.end, 11);
    const isFreedomLatest = account.mask === '7730' && latestClosed.get(account.id) === b;
    if (payDate > today || isFreedomLatest) continue; // Freedom's latest statement is not paid yet
    payments.push({ accountExternalId: account.externalId, externalId: `demo-pay-${b.id}`, date: payDate, description: 'AUTOMATIC PAYMENT - THANK', amountCents: -b.netActivityCents, bankType: 'Payment' });
    bankUpserts.push({ accountExternalId: 'demo-checking', externalId: `demo-chk-pay-${b.id}`, date: payDate, description: `CHASE CREDIT CRD AUTOPAY ${account.mask}`, amountCents: b.netActivityCents });
  }
  for (let i = 0; i < 6; i++) {
    const mo = shiftMonth(start.y, start.m, i);
    for (const day of [1, 15]) {
      bankUpserts.push({ accountExternalId: 'demo-checking', externalId: `demo-payroll-${i}-${day}`, date: clampedDate(mo.y, mo.m, day), description: 'NORTHWIND CONSULTING PAYROLL PPD', amountCents: -412500 });
    }
  }
  bankUpserts.push({ accountExternalId: 'demo-checking', externalId: 'demo-friend', date: addDays(today, -6), description: 'Zelle Payment From Jordan Lee Wfct0q2k3m9x', amountCents: -4500 });
  ingest(uow, { source: 'demo', connectionId, accounts: [...cardAccounts, checking], upserts: payments });
  ingest(uow, { source: 'demo', connectionId, accounts: [...cardAccounts, checking], upserts: bankUpserts.filter((u) => u.date <= today) });
  reconcile(uow, { today });

  // Submit and get reimbursed for older statements.
  ledger = buildLedger(uow.view, { today });
  const byAccount = (mask) => {
    const account = uow.list('accounts').find((a) => a.mask === mask);
    return ledger.billsByAccount.get(account.id).filter((b) => b.visible && !b.isOpen);
  };
  const [sLatest, sAwaiting, sExact, sShort, sCombined, ...sOlder] = [...byAccount('4821')].reverse();
  const [fLatest, fAwaiting, ...fOlder] = [...byAccount('7730')].reverse();
  const fCombined = fOlder.pop();
  const zelles = [];
  const zelle = (date, cents, tag) => {
    if (date >= today || cents <= 0) return;
    zelles.push({ accountExternalId: 'demo-checking', externalId: `demo-zelle-${tag}`, date, description: `Zelle Payment From Northwind Consulting Bac${tag}8k2m3`, amountCents: -cents });
  };
  const paidOrClosed = (b) => b.paid.paidOn ?? b.end;
  // Everything except the newest statement of each card was sent in after paying it.
  for (const b of [sAwaiting, sExact, sShort, sCombined, ...sOlder, fAwaiting, fCombined, ...fOlder]) {
    if (b) uow.patch('bills', b.id, { submittedOn: addDays(paidOrClosed(b), 3) });
  }
  void sLatest;
  void fLatest;
  // Older statements were reimbursed: most exactly, two together in one Zelle,
  // and one short by $85.
  [sExact, ...sOlder, ...fOlder].forEach((b, i) => b && zelle(addDays(paidOrClosed(b), 12 + (i % 3)), b.claimCents, `x${i}`));
  if (sCombined && fCombined) zelle(addDays(paidOrClosed(sCombined), 14), sCombined.claimCents + fCombined.claimCents, 'b2');
  const shortPaid = sShort;
  if (shortPaid) zelle(addDays(paidOrClosed(shortPaid), 13), shortPaid.claimCents - 8500, 'c3');
  // A recent payment that doesn't match any bill exactly: needs matching.
  zelle(addDays(today, -2), 41260, 'e5');
  ingest(uow, { source: 'demo', connectionId, accounts: [...cardAccounts, checking], upserts: zelles });
  reconcile(uow, { today });

  // The short payment isn't an exact match: allocate it by hand, like a user would.
  ledger = buildLedger(uow.view, { today });
  const short = [...ledger.reimbursements.values()].find((r) => r.description?.includes('Bacc38k2m3'));
  if (short && shortPaid) setAllocations(uow, short.id, [{ billId: shortPaid.id, amountCents: short.amountCents }]);
  if (shortPaid) uow.patch('bills', shortPaid.id, { note: 'Company questioned the $85 parking receipt – follow up with AP' });
  reconcile(uow, { today });
}
