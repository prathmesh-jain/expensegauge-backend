import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// AES-256-GCM field encryption.
// Stored format: enc:v1:<iv base64>:<auth tag base64>:<ciphertext base64>
// The version segment lets us rotate keys / algorithms later without guessing.
const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const PREFIX = `enc:${VERSION}:`;
const IV_LENGTH = 12;
const ENCRYPTED_PATTERN = /^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/;

let cachedKey = null;

const getKey = () => {
  if (cachedKey) return cachedKey;

  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('ENCRYPTION_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes encoded as base64');
  }

  cachedKey = key;
  return cachedKey;
};

/**
 * Fail fast at startup instead of on the first request that touches encrypted data.
 */
export const assertEncryptionKey = () => {
  getKey();
};

export const isEncrypted = (value) =>
  typeof value === 'string' && ENCRYPTED_PATTERN.test(value);

export const encrypt = (value) => {
  if (value === null || value === undefined) return value;
  // Idempotent: re-saving a document must not double-encrypt
  if (isEncrypted(value)) return value;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
};

export const decrypt = (value) => {
  // Plaintext values (rows not migrated yet) pass through unchanged
  if (!isEncrypted(value)) return value;

  const [ivB64, tagB64, ciphertextB64] = value.slice(PREFIX.length).split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
};
