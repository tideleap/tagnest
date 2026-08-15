// TagNest extension API client.
//
// Talks to the user-configured TagNest deployment using a personal access key
// (`tnk_...`) presented via `X-API-Key`. All calls go out from the background
// service worker — the extension never needs host permissions or page
// injection, which keeps the attack surface small.

export class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail ?? null;
  }
}

/**
 * Core fetch with retry-on-connect only (a 4xx/5xx is a definitive answer and
 * must not be retried — that would silently double into the same 409, or worse).
 */
export async function apiFetch(path, { baseUrl, apiKey, method = 'GET', body, signal } = {}) {
  const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new ApiError(0, '请求超时，请重试');
    throw new ApiError(0, '无法连接 TagNest，请检查网络与服务器地址');
  }
  const text = await res.text().catch(() => '');
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const msg = data?.error?.message || defaultHttpMessage(res.status);
    throw new ApiError(res.status, msg, data?.error?.fields ?? null);
  }
  return data;
}

function defaultHttpMessage(status) {
  if (status === 401) return 'API 密钥无效或已过期，请在设置中更新';
  if (status === 403) return '该密钥没有写入权限';
  if (status === 404) return '资源不存在或已被删除';
  if (status === 429) return '请求过于频繁，请稍后再试';
  return `请求失败（HTTP ${status}）`;
}

/**
 * Ensure a bookmark exists for `url`. The backend rejects duplicates with 409
 * and echoes the existing id — we treat that as a successful idempotent save.
 * Returns { id, existed }.
 */
export async function ensureBookmark({ baseUrl, apiKey }, { url, title, note }, signal) {
  try {
    const created = await apiFetch('/api/bookmarks', {
      baseUrl,
      apiKey,
      method: 'POST',
      body: { url, title: title ?? null, note: note ?? null },
      signal,
    });
    if (created && created.id) return { id: created.id, existed: false };
    throw new ApiError(0, '收藏接口未返回书签');
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.detail?.id) {
      return { id: err.detail.id, existed: true };
    }
    throw err;
  }
}

/** Fetch one bookmark (used to read the current note before appending). */
export async function getBookmark({ baseUrl, apiKey }, id, signal) {
  return apiFetch(`/api/bookmarks/${encodeURIComponent(id)}`, { baseUrl, apiKey, method: 'GET', signal });
}

/** Update fields on an existing bookmark (PATCH). */
export async function patchBookmark({ baseUrl, apiKey }, id, body, signal) {
  return apiFetch(`/api/bookmarks/${encodeURIComponent(id)}`, { baseUrl, apiKey, method: 'PATCH', body, signal });
}

const NOTE_MAX = 20000; // mirrors the backend column cap

/**
 * Append `note` to an existing bookmark's note (newline-separated). Read-modify-
 * write is acceptable here: single-user extension traffic makes lost concurrent
 * appends a theoretical concern only. Returns true when something was written.
 */
export async function appendNote(cfg, id, note, signal) {
  const text = String(note ?? '').trim();
  if (!text) return false;
  const current = await getBookmark(cfg, id, signal);
  const existing = typeof current?.note === 'string' ? current.note.trim() : '';
  const merged = existing ? `${existing}\n${text}` : text;
  await patchBookmark(cfg, id, { note: merged.slice(0, NOTE_MAX) }, signal);
  return true;
}

/** Create a tab group; returns group record with `id`. */
export async function createGroup({ baseUrl, apiKey }, { name, colorIndex }, signal) {
  const body = { name };
  if (Number.isInteger(colorIndex)) body.colorIndex = colorIndex;
  return apiFetch('/api/tab-groups', {
    baseUrl,
    apiKey,
    method: 'POST',
    body,
    signal,
  });
}

/** Add one bookmark to a group; resolves to the group item or a 409-like flag. */
export async function addGroupItem({ baseUrl, apiKey }, groupId, bookmarkId, signal) {
  return apiFetch(`/api/tab-groups/${encodeURIComponent(groupId)}/items`, {
    baseUrl,
    apiKey,
    method: 'POST',
    body: { bookmarkId },
    signal,
  });
}
