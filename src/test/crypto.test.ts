import { test } from 'node:test';
import assert from 'node:assert';
import {
  isSensitiveField,
  encryptValue,
  decryptValue,
  deriveKey,
  generateSalt,
  encryptSensitiveFields,
  decryptSensitiveFields,
  isEncryptedValue,
} from '../core/crypto';

test('isSensitiveField detects by key name', () => {
  assert.ok(isSensitiveField('apiKey', 'whatever-value'));
  assert.ok(isSensitiveField('api_key', 'x'));
  assert.ok(isSensitiveField('ACCESS_TOKEN', 'x'));
  assert.ok(isSensitiveField('clientSecret', 'x'));
  assert.ok(!isSensitiveField('command', 'npx'));
  assert.ok(!isSensitiveField('url', 'https://example.com'));
});

test('isSensitiveField detects by value prefix', () => {
  assert.ok(isSensitiveField('note', 'ghp_' + '0123456789abcdefghijklmnopqrstuvwxyz'));
  assert.ok(isSensitiveField('note', 'sk-' + '0123456789abcdef'));
  assert.ok(!isSensitiveField('note', 'sk-'));
  assert.ok(!isSensitiveField('note', 'short'));
});

test('encrypt/decrypt round trip', () => {
  const salt = generateSalt();
  const key = deriveKey('correct horse battery staple', salt);
  const enc = encryptValue('super-secret-key-123', key);
  assert.ok(enc.startsWith('ENC:v1:'));
  assert.ok(isEncryptedValue(enc));
  assert.strictEqual(decryptValue(enc, key), 'super-secret-key-123');
  assert.throws(() => decryptValue(enc, deriveKey('wrong', salt)));
});

test('same plaintext encrypts to different ciphertexts (random IV)', () => {
  const key = deriveKey('pw', generateSalt());
  const a = encryptValue('same', key);
  const b = encryptValue('same', key);
  assert.notStrictEqual(a, b);
});

test('encryptSensitiveFields walks nested structures', () => {
  const key = deriveKey('pw', generateSalt());
  const doc = {
    servers: {
      ctx: {
        command: 'npx',
        env: { CONTEXT7_API_KEY: 'ctx7sk-live-abcdef123456', DEBUG: '1' },
      },
    },
    models: [{ name: 'x', apiKey: 'sk-0123456789abcdef' }],
  };
  const encrypted = encryptSensitiveFields(doc, key);
  assert.strictEqual(encrypted.length, 2);
  const env = (doc.servers as any).ctx.env;
  assert.ok(isEncryptedValue(env.CONTEXT7_API_KEY));
  assert.strictEqual(env.DEBUG, '1');
  assert.ok(isEncryptedValue(doc.models[0].apiKey));
  assert.strictEqual((doc.models[0] as any).command, undefined);

  decryptSensitiveFields(doc, key);
  assert.strictEqual(env.CONTEXT7_API_KEY, 'ctx7sk-live-abcdef123456');
  assert.strictEqual(doc.models[0].apiKey, 'sk-0123456789abcdef');
});

test('already-encrypted values are not double-encrypted', () => {
  const key = deriveKey('pw', generateSalt());
  const doc = { apiKey: 'ENC:v1:AAAA' };
  const encrypted = encryptSensitiveFields(doc, key);
  assert.strictEqual(encrypted.length, 0);
  assert.strictEqual(doc.apiKey, 'ENC:v1:AAAA');
});
