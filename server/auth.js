const crypto = require('crypto');

// Session/gate cookies are AES-256-GCM sealed with a key derived from
// SESSION_SECRET — no session store, so the cookie itself is the only state.
// Rotating SESSION_SECRET is therefore the one available "log everyone out"
// lever.
const ALGO = 'aes-256-gcm';
const SCRYPT_SALT = 'azdash-session-v1';

function deriveKey(secret) {
  return crypto.scryptSync(secret, SCRYPT_SALT, 32);
}

function toBase64Url(buf) {
  return buf.toString('base64url');
}

function fromBase64Url(str) {
  return Buffer.from(str, 'base64url');
}

/** Encrypts `payload` (any JSON-serializable value) into an opaque token
 * suitable for a cookie value. */
function seal(payload, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${toBase64Url(iv)}.${toBase64Url(tag)}.${toBase64Url(ciphertext)}`;
}

/** Reverses `seal`. Returns null on any failure (wrong key, tampering,
 * malformed token) rather than throwing — every caller treats "no session"
 * and "bad session" identically. */
function unseal(token, key) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const [ivPart, tagPart, ctPart] = parts;
    const decipher = crypto.createDecipheriv(ALGO, key, fromBase64Url(ivPart));
    decipher.setAuthTag(fromBase64Url(tagPart));
    const plaintext = Buffer.concat([decipher.update(fromBase64Url(ctPart)), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch (err) {
    return null;
  }
}

/** Constant-time password comparison (via digest, so unequal-length inputs
 * don't leak length through a comparison-time difference). */
function checkPassword(input, expected) {
  if (typeof input !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Minimal in-memory fixed-window rate limiter — this process is the only
 * instance (single Render free-tier dyno), so no shared store is needed. */
class RateLimiter {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> { count, resetAt }
  }

  /** Returns true if `key` is still allowed to proceed, and records the
   * attempt. Callers call this once per attempt, success or failure. */
  consume(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now > entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count += 1;
    return true;
  }
}

module.exports = { deriveKey, seal, unseal, checkPassword, RateLimiter };
