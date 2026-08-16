import type { Env } from './env';

export interface WebdavTarget {
  /** Base URL, e.g. https://dav.example.com/remote.php/dav/files/user/ */
  endpoint: string;
  username: string;
  /** Already-decrypted password. Never persisted in this form. */
  password: string;
  /** Remote directory, e.g. /backups (leading/trailing slashes normalised). */
  remotePath: string;
}

const encoder = new TextEncoder();

export interface PushResult {
  ok: boolean;
  status: number;
  bytes: number;
}

/**
 * Pushes `body` to `fileName` on a WebDAV server, creating intermediate
 * collections (directories) as needed. Built entirely on `fetch` because
 * Workers have no Node `fs` and no streaming filesystem write.
 */
export async function webdavPut(
  target: WebdavTarget,
  fileName: string,
  body: string,
  _env: Env,
): Promise<PushResult> {
  const base = target.endpoint.replace(/\/+$/, '');
  const dir = (target.remotePath || '/').replace(/^\/+|\/+$/g, '');
  const dirUrl = dir ? `${base}/${dir}` : base;
  const fileUrl = `${dirUrl}/${fileName}`;
  const auth = `Basic ${btoa(`${target.username}:${target.password}`)}`;
  const bytes = encoder.encode(body).length;

  await ensureDir(dirUrl, auth);

  const res = await fetch(fileUrl, {
    method: 'PUT',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body,
  });

  return { ok: res.ok, status: res.status, bytes };
}

/** Recursively PROPFIND/MKCOL each missing collection segment. */
async function ensureDir(dirUrl: string, auth: string): Promise<void> {
  const propfind = await fetch(dirUrl, {
    method: 'PROPFIND',
    headers: {
      Authorization: auth,
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body: `<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>`,
  });

  if (propfind.status < 400 && propfind.status !== 404) return; // exists

  // Missing: create the parent first, then this collection.
  const parent = dirUrl.replace(/\/[^/]+$/, '');
  if (parent && parent !== dirUrl) {
    await ensureDir(parent, auth);
  }

  const mkcol = await fetch(dirUrl, {
    method: 'MKCOL',
    headers: { Authorization: auth },
  });
  // 405 Method Not Allowed = already exists (race); treat as success.
  if (!mkcol.ok && mkcol.status !== 405) {
    throw new Error(`WebDAV MKCOL failed: ${mkcol.status}`);
  }
}
