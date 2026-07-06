/* ============================================================
   NEXTLAO — LIB/CRYPTO.JS
   AES-256-GCM encryption for secrets stored at rest
   (per-seller carrier API credentials).

   Uses the ENCRYPTION_KEY env var — a 64-hex-character string
   (32 bytes). Generate one with:
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

   Stored format (single string, dot-separated base64):
     base64(iv) . base64(authTag) . base64(ciphertext)

   Fails LOUD if ENCRYPTION_KEY is missing or malformed, so we
   never silently fall back to storing secrets in plaintext.
   ============================================================ */

'use strict';

const crypto = require('crypto');

const ALGO       = 'aes-256-gcm';
const IV_BYTES   = 12;   // GCM standard nonce size
const KEY_BYTES  = 32;   // AES-256

// Resolve + validate the key once, lazily, so requiring this module
// doesn't crash tooling that never actually encrypts. The first
// encrypt()/decrypt() call in a misconfigured environment throws clearly.
function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error('ENCRYPTION_KEY did not decode to 32 bytes.');
  }
  return key;
}

// Encrypt an arbitrary JSON-serializable value → opaque string.
function encrypt(obj) {
  const key = getKey();
  const iv  = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  const plaintext  = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag    = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

// Reverse of encrypt(). Throws if the payload was tampered with
// (GCM auth tag mismatch) or the key is wrong.
function decrypt(str) {
  if (typeof str !== 'string' || !str.includes('.')) {
    throw new Error('decrypt: malformed ciphertext.');
  }
  const key = getKey();
  const [ivB64, tagB64, dataB64] = str.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('decrypt: malformed ciphertext (expected iv.tag.data).');
  }

  const iv     = Buffer.from(ivB64,  'base64');
  const tag    = Buffer.from(tagB64, 'base64');
  const data   = Buffer.from(dataB64,'base64');

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

// Whether a usable key is configured — lets startup log a clear warning
// without throwing.
function isConfigured() {
  try { getKey(); return true; } catch { return false; }
}

module.exports = { encrypt, decrypt, isConfigured };
