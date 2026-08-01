import type { Env } from './env';
import { base64UrlDecode, base64UrlEncode } from './ids';

/**
 * Field-level encryption for secrets that must be readable again.
 *
 * Passwords are hashed (one-way); provider API keys cannot be, because the
 * server has to replay them. AES-256-GCM gives confidentiality plus an
 * integrity tag, so a tampered ciphertext fails to decrypt rather than
 * silently yielding garbage.
 *
 * The key is derived from JWT_SECRET via HKDF with a distinct `info` string.
 * Reusing the secret is deliberate — one secret to rotate, not two — and the
 * domain separation means the AES key cannot be used to forge a token, nor
 * the HMAC key to decrypt a field.
 *
 * Rotating JWT_SECRET therefore invalidates stored ciphertexts. Decryption
 * fails closed (returns null) and the UI reports the key as unset, which is
 * the correct outcome: an unreadable credential should be re-entered.
 */

const VERSION = 'v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Non-secret, fixed salt. HKDF's security rests on the input key material. */
const HKDF_SALT = encoder.encode('tagnest.field-encryption.salt.v1');
const HKDF_INFO = encoder.encode('tagnest/aes-256-gcm/field');

const DEV_SECRET = 'tagnest-insecure-development-secret-change-me';

function secretFor(env: Env): string {
  const secret = env.JWT_SECRET?.trim();
  return secret && secret.length >= 16 ? secret : DEV_SECRET;
}

let cached: { secret: string; key: CryptoKey } | null = null;

async function aesKey(env: Env): Promise<CryptoKey> {
  const secret = secretFor(env);
  if (cached?.secret === secret) return cached.key;

  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT as BufferSource, info: HKDF_INFO as BufferSource },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  // The isolate is per-account and short-lived; caching avoids re-deriving on
  // every settings read without widening the key's exposure.
  cached = { secret, key };
  return key;
}

/** Returns `v1.<iv>.<ciphertext>`, both segments base64url. */
export async function encryptField(plaintext: string, env: Env): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    await aesKey(env),
    encoder.encode(plaintext),
  );
  return `${VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(ct)}`;
}

/**
 * Reverses {@link encryptField}.
 *
 * Values written before this migration are stored in the clear. They are
 * returned as-is rather than rejected, so upgrading does not lock users out
 * of keys they already saved; the next write re-stores them encrypted.
 */
export async function decryptField(stored: string | null, env: Env): Promise<string | null> {
  if (!stored) return null;

  const parts = stored.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    // Legacy plaintext.
    return stored;
  }

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(parts[1]) as BufferSource },
      await aesKey(env),
      base64UrlDecode(parts[2]) as BufferSource,
    );
    return decoder.decode(plain);
  } catch {
    // Wrong secret or tampered payload. Fail closed.
    console.warn('[tagnest] field decryption failed; secret may have rotated');
    return null;
  }
}

/** True when the value is already in the encrypted envelope format. */
export function isEncrypted(stored: string | null): boolean {
  return Boolean(stored && stored.startsWith(`${VERSION}.`) && stored.split('.').length === 3);
}

/** Hex SHA-256; used wherever a credential is stored as a lookup digest. */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
