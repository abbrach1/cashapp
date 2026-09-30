import { BaseStore } from './base.js';
import { ConflictError, applyChanges, emptySnapshot } from './model.js';

/**
 * Keeps everything in process memory. Used for the demo and for tests; data is
 * lost when the process exits.
 */
export class MemoryStore extends BaseStore {
  constructor() {
    super();
    /** @type {Map<string, import('./model.js').Snapshot>} */
    this.users = new Map();
    /** @type {Map<string, string>} */
    this.secrets = new Map();
    this.kind = 'memory';
  }

  async load(uid) {
    return this.users.get(uid) ?? emptySnapshot();
  }

  async commit(uid, changes, base) {
    const current = this.users.get(uid) ?? emptySnapshot();
    if (current.rev !== base.rev) throw new ConflictError();
    const next = applyChanges(current, changes, this.newRev());
    this.users.set(uid, next);
    for (const [connectionId, value] of changes.secrets) {
      const key = `${uid}/${connectionId}`;
      if (value === null) this.secrets.delete(key);
      else this.secrets.set(key, value);
    }
    return next;
  }

  async getSecret(uid, connectionId) {
    return this.secrets.get(`${uid}/${connectionId}`) ?? null;
  }

  async listUserIds() {
    return [...this.users.keys()];
  }
}
