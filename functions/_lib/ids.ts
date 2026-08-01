const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Sortable, collision-resistant identifier.
 *
 * The 8-character base36 timestamp prefix means IDs sort chronologically, so
 * `ORDER BY id` is a stable tiebreaker for keyset pagination without needing a
 * second column. The 14 random characters carry ~72 bits of entropy, which is
 * ample for the write rates a bookmark app sees.
 */
export function newId(): string {
  const time = Date.now().toString(36).padStart(8, '0');
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length];
  return `${time}${rand}`;
}

/** URL-safe base64 of n random bytes, used for refresh tokens. */
export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function base64UrlEncode(input: ArrayBuffer | Uint8Array): string {
  const view = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export const nowIso = () => new Date().toISOString();

export const isoFromNow = (ms: number) => new Date(Date.now() + ms).toISOString();
