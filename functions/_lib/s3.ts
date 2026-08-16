import type { Env } from './env';

export interface S3Target {
  /** Virtual-host endpoint, e.g. https://s3.ap-southeast-1.amazonaws.com */
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  /** Already-decrypted secret key. Never persisted in this form. */
  secretKey: string;
  remotePath: string;
}

const encoder = new TextEncoder();

export interface PushResult {
  ok: boolean;
  status: number;
  bytes: number;
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', buf, encoder.encode(data));
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Pushes `body` to S3 using AWS Signature Version 4 (PUT). Implemented on
 * `fetch` + WebCrypto so it runs in the Workers runtime. The body is uploaded
 * with `x-amz-content-sha256` (unsigned payload variant would need the stream
 * hash too, so we use the full-signature form).
 */
export async function s3Put(
  target: S3Target,
  fileName: string,
  body: string,
  _env: Env,
): Promise<PushResult> {
  const key = `${(target.remotePath || '').replace(/^\/+/, '')}${fileName}`;
  const url = new URL(target.endpoint);
  url.pathname = `/${target.bucket}/${key}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 17); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);
  const bytes = encoder.encode(body).length;

  const host = url.host;
  const hashedPayload = payloadHash;

  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${hashedPayload}\n` +
    `x-amz-date:${amzDate}\n`;

  const canonicalRequest =
    `PUT\n` +
    `/${target.bucket}/${key}\n` +
    `\n` +
    `${canonicalHeaders}\n` +
    `${signedHeaders}\n` +
    `${hashedPayload}`;

  const scope = `${dateStamp}/${target.region}/s3/aws4_request`;
  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonicalRequest)}`;

  const kDate = await hmac(encoder.encode(`AWS4${target.secretKey}`), dateStamp);
  const kRegion = await hmac(kDate, target.region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${target.accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url.toString(), {
    method: 'PUT',
    headers: {
      Host: host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': hashedPayload,
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body,
  });

  return { ok: res.ok, status: res.status, bytes };
}
