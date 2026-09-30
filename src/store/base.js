import { randomUUID } from 'node:crypto';
import { ConflictError, UnitOfWork } from './model.js';

const MAX_ATTEMPTS = 4;

/**
 * Shared behaviour for storage backends. Subclasses implement:
 *   load(uid) -> Snapshot
 *   commit(uid, changes, baseSnapshot) -> Snapshot   (throws ConflictError if the data moved on)
 *   getSecret(uid, connectionId) -> string|null
 *   listUserIds() -> string[]
 */
export class BaseStore {
  constructor() {
    /** @type {Map<string, Promise<unknown>>} */
    this.locks = new Map();
  }

  newRev() {
    return randomUUID();
  }

  /** Forget any cached state for a user (after a conflict). */
  invalidate(_uid) {}

  /**
   * Run `fn` against a fresh UnitOfWork and persist what it changed. Calls for
   * the same user are serialised within this process; conflicting writes from
   * elsewhere are retried with fresh data.
   * @template T
   * @param {string} uid
   * @param {(uow: UnitOfWork) => T | Promise<T>} fn
   * @returns {Promise<{ result: T, snapshot: import('./model.js').Snapshot }>}
   */
  async mutate(uid, fn) {
    return this.withLock(uid, async () => {
      for (let attempt = 1; ; attempt++) {
        const snapshot = await this.load(uid);
        const uow = new UnitOfWork(snapshot);
        const result = await fn(uow);
        if (uow.changes.isEmpty()) return { result, snapshot };
        try {
          const next = await this.commit(uid, uow.changes, snapshot);
          return { result, snapshot: next };
        } catch (err) {
          if (err instanceof ConflictError && attempt < MAX_ATTEMPTS) {
            this.invalidate(uid);
            continue;
          }
          throw err;
        }
      }
    });
  }

  /**
   * @template T
   * @param {string} uid
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async withLock(uid, fn) {
    const previous = this.locks.get(uid) ?? Promise.resolve();
    let release;
    const current = new Promise((r) => (release = r));
    const chained = previous.then(() => current);
    this.locks.set(uid, chained);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(uid) === chained) this.locks.delete(uid);
    }
  }
}
