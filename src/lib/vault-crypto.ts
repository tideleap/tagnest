/**
 * Client-side, zero-knowledge crypto for the private (encrypted) bookmark vault.
 *
 * The passphrase never leaves the browser. A key is derived from it with
 * PBKDF2 (SHA-256) and used for AES-256-GCM. The server stores only the
 * ciphertext, the PBKDF2 salt, and a verifier — it can confirm a passphrase is
 * correct but can never decrypt the data, because it never holds the key.
 *
 * This module relies only on the global Web Crypto API, which is available in
 * both browsers and Node 20+, so the round-trip is unit-tested in plain Node.
 */

const PBKDF2_ITERATIONS = 250_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface EncryptedBlob {
  /** Wire format version. */
  v: 1;
  /** Base64 AES-GCM IV. */
  iv: string;
  /** Base64 AES-GCM ciphertext. */
  ct: string;
}

/** Plaintext stored inside a private bookmark's ciphertext. */
export interface VaultBookmarkData {
  url: string;
  title: string;
  description: string | null;
  note: string | null;
  faviconUrl: string | null;
  coverUrl: string | null;
  tagNames: string[];
  isFavorite: boolean;
  isArchived: boolean;
}

/** The constant encrypted into the verifier so an unlock can be validated. */
const VERIFIER_PLAIN = { v: 'tagnest-vault-v1' };

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * The explicit `Uint8Array<ArrayBuffer>` matters: since TS 5.7 a bare
 * `Uint8Array` may be backed by a `SharedArrayBuffer`, which `BufferSource`
 * (and therefore every Web Crypto call) rejects.
 */
function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh, base64-encoded 16-byte PBKDF2 salt. */
export function randomSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)));
}

/** Derives the vault key from the passphrase and salt (PBKDF2-SHA256, 250k iters). */
export async function deriveKey(passphrase: string, saltB64: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: fromBase64(saltB64),
      iterations: PBKDF2_ITERATIONS,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypts an arbitrary JSON-serialisable value. */
export async function encryptJson(key: CryptoKey, data: unknown): Promise<EncryptedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)));
  return { v: 1, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/** Decrypts a blob produced by {@link encryptJson}. Throws on a wrong key. */
export async function decryptJson<T = unknown>(key: CryptoKey, blob: EncryptedBlob): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(blob.iv) },
    key,
    fromBase64(blob.ct),
  );
  return JSON.parse(dec.decode(plain)) as T;
}

/** Builds the verifier blob used to validate a typed passphrase on unlock. */
export async function makeVerifier(key: CryptoKey): Promise<EncryptedBlob> {
  return encryptJson(key, VERIFIER_PLAIN);
}

/** Returns true when the key decrypts the verifier — i.e. the passphrase is correct. */
export async function checkVerifier(key: CryptoKey, blob: EncryptedBlob): Promise<boolean> {
  try {
    const data = await decryptJson<{ v?: string }>(key, blob);
    return data.v === VERIFIER_PLAIN.v;
  } catch {
    return false;
  }
}
