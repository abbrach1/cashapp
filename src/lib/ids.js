import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random id like "b_k3j9x0q2m1zp". Safe as a Firestore document id and field name. */
export function newId(prefix) {
  const bytes = randomBytes(12);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 36];
  return `${prefix}_${out}`;
}

/** Deterministic id derived from its parts, e.g. a bank transaction id. */
export function hashId(prefix, ...parts) {
  const h = createHash('sha256').update(parts.map((p) => String(p ?? '')).join('\u0001')).digest('hex');
  return `${prefix}_${h.slice(0, 24)}`;
}
