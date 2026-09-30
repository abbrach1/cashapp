import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Bank access tokens are encrypted with AES-256-GCM before they are written to
// Firestore. The key comes from TOKEN_ENCRYPTION_KEY (any long random string).

function deriveKey(secret) {
  return createHash('sha256').update(`reimbursement-tracker:${secret}`).digest();
}

/**
 * @param {object} value
 * @param {string|undefined} secret
 * @returns {string}
 */
export function sealJSON(value, secret) {
  const json = JSON.stringify(value);
  if (!secret) return `plain:${json}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const body = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${Buffer.concat([iv, tag, body]).toString('base64')}`;
}

/**
 * @param {string} sealed
 * @param {string|undefined} secret
 * @returns {any}
 */
export function openJSON(sealed, secret) {
  if (typeof sealed !== 'string') throw new Error('Missing sealed value');
  if (sealed.startsWith('plain:')) return JSON.parse(sealed.slice(6));
  if (!sealed.startsWith('v1:')) throw new Error('Unknown secret format');
  if (!secret) throw new Error('TOKEN_ENCRYPTION_KEY is not set, cannot decrypt stored bank credentials');
  const raw = Buffer.from(sealed.slice(3), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
  decipher.setAuthTag(tag);
  try {
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error('Could not decrypt stored bank credentials (was TOKEN_ENCRYPTION_KEY changed?)');
  }
}
