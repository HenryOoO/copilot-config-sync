import * as crypto from 'crypto';

const KDF_ITERATIONS = 600_000;
const KEY_LEN = 32; // AES-256
const SALT_LEN = 16;
const IV_LEN = 12;
const ENC_PREFIX = 'ENC:v1:';

const SENSITIVE_KEY_RE = /(api[-_]?key|token|secret|password|passwd|authorization)/i;
const SENSITIVE_VALUE_PREFIXES = ['sk-', 'ghp_', 'gho_', 'github_pat_', 'xoxb-', 'xoxp-'];

export function isSensitiveField(key: string, value: string): boolean {
  if (SENSITIVE_KEY_RE.test(key)) {
    return true;
  }
  const v = value.trim();
  return SENSITIVE_VALUE_PREFIXES.some((p) => v.startsWith(p) && v.length > p.length + 8);
}

export function generateSalt(): string {
  return crypto.randomBytes(SALT_LEN).toString('hex');
}

export function deriveKey(passphrase: string, saltHex: string): Buffer {
  return crypto.pbkdf2Sync(passphrase, Buffer.from(saltHex, 'hex'), KDF_ITERATIONS, KEY_LEN, 'sha256');
}

/** Encrypt a UTF-8 string; returns `ENC:v1:<base64(iv|ciphertext|tag)>`. */
export function encryptValue(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, ct, tag]).toString('base64');
}

/** Decrypt an `ENC:v1:` value; throws on wrong passphrase or tampering. */
export function decryptValue(encoded: string, key: Buffer): string {
  if (!encoded.startsWith(ENC_PREFIX)) {
    throw new Error('not an encrypted value');
  }
  const raw = Buffer.from(encoded.slice(ENC_PREFIX.length), 'base64');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(IV_LEN, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function isEncryptedValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * Walk a JSON structure and encrypt sensitive string fields in place.
 * Returns the list of encrypted paths (for manifest annotation).
 */
export function encryptSensitiveFields(node: unknown, key: Buffer, prefix = ''): string[] {
  const encrypted: string[] = [];
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      encrypted.push(...encryptSensitiveFields(item, key, `${prefix}[${i}]`));
    });
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string' && !isEncryptedValue(v) && isSensitiveField(k, v)) {
        (node as Record<string, unknown>)[k] = encryptValue(v, key);
        encrypted.push(p);
      } else {
        encrypted.push(...encryptSensitiveFields(v, key, p));
      }
    }
  }
  return encrypted;
}

/** Walk a JSON structure and decrypt `ENC:v1:` values in place. */
export function decryptSensitiveFields(node: unknown, key: Buffer): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => decryptSensitiveFields(item, key));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (isEncryptedValue(v)) {
        (node as Record<string, unknown>)[k] = decryptValue(v, key);
      } else {
        decryptSensitiveFields(v, key);
      }
    }
  }
}
