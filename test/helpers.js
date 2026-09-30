import { MemoryStore } from '../src/store/memory.js';
import { UnitOfWork, emptySnapshot } from '../src/store/model.js';
import { txnIdFor } from '../src/core/ingest.js';
import { classify } from '../src/core/classify.js';

let seq = 0;

/** A UnitOfWork over an empty snapshot, with small builders for tests. */
export function makeWorld(settings = {}) {
  const snap = emptySnapshot();
  snap.settings = { trackingStartDate: null, ...settings };
  const uow = new UnitOfWork(snap);
  return {
    uow,
    card(fields = {}) {
      return uow.put('accounts', {
        id: fields.id ?? `a_card${++seq}`,
        name: 'Sapphire Preferred',
        mask: '4821',
        kind: 'credit',
        role: 'expenses',
        closingDay: 14,
        dueDay: null,
        connectionId: null,
        source: 'csv',
        ...fields,
      });
    },
    checking(fields = {}) {
      return uow.put('accounts', {
        id: fields.id ?? `a_chk${++seq}`,
        name: 'Total Checking',
        mask: '9912',
        kind: 'checking',
        role: 'reimbursements',
        connectionId: null,
        source: 'csv',
        ...fields,
      });
    },
    txn(account, date, amountCents, description = 'Purchase', fields = {}) {
      const externalId = fields.externalId ?? `ext${++seq}`;
      const t = {
        id: txnIdFor(fields.source ?? 'csv', externalId),
        accountId: account.id,
        source: 'csv',
        externalId,
        date,
        description,
        amountCents,
        pending: false,
        override: null,
        claimCents: null,
        note: null,
        ...fields,
      };
      t.kind = fields.kind ?? classify({ accountKind: account.kind, amountCents, description, bankType: fields.bankType });
      return uow.putTxn(t);
    },
  };
}

export function billsOf(uow, accountId) {
  return uow
    .list('bills')
    .filter((b) => b.accountId === accountId)
    .sort((a, b) => (a.start < b.start ? -1 : 1))
    .map((b) => `${b.start}..${b.end}`);
}

export { MemoryStore };
