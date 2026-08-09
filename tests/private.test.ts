/**
 * Tests for the zero-knowledge private (encrypted) bookmark vault.
 *
 * Coverage:
 *  - Client crypto (PBKDF2 + AES-256-GCM) round-trips and wrong-key rejection.
 *  - PRIVATE_BOOKMARK_CLAUSE is injected into every public list query.
 *  - Private bookmarks are invisible to listBookmarks / loadBookmark yet
 *    appear (as ciphertext) only through the dedicated vault readers.
 *  - setBookmarkPrivate blanks plaintext + flags the row; clearBookmarkPrivate
 *    restores it and re-links tags by name (with URL-clash detection).
 *  - The /api/private/* endpoint handlers behave correctly (201/404/409).
 */
import { describe, it, expect } from 'vitest';
import {
  buildWhere,
  PRIVATE_BOOKMARK_CLAUSE,
  listBookmarks,
  loadBookmark,
  setBookmarkPrivate,
  clearBookmarkPrivate,
  createPrivateBookmark,
  listPrivateBookmarkRows,
  loadPrivateBookmarkRow,
  updatePrivateBookmark,
  deletePrivateBookmark,
  type ListParams,
  type RestoredBookmarkFields,
} from '../functions/_lib/db';
import { onRequestGet as getVault, onRequestPost as postVault } from '../functions/api/private/vault';
import {
  onRequestGet as listPrivateBookmarks,
  onRequestPost as createPrivateBookmarkHandler,
} from '../functions/api/private/bookmarks/index';
import {
  onRequestGet as getOnePrivate,
  onRequestPatch as patchPrivate,
  onRequestDelete as deleteOnePrivate,
} from '../functions/api/private/bookmarks/[id]';
import {
  deriveKey,
  encryptJson,
  decryptJson,
  makeVerifier,
  checkVerifier,
  randomSalt,
  type EncryptedBlob,
  type VaultBookmarkData,
} from '../src/lib/vault-crypto';
import { canonicalUrl, urlKey } from '../functions/_lib/urlkey';
import { MockDb, makeEnv } from './_support/dbMock';

const USER = 'u-priv';

function makeCtx(
  env: any,
  userId: string,
  method: string,
  path: string,
  id?: string,
  body?: unknown,
) {
  const url = `https://tagnest.test${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request(url, init),
    env,
    data: { userId },
    params: id ? { id } : {},
  } as any;
}

function seedBookmark(db: MockDb, over: Record<string, unknown> = {}) {
  db.bookmarks.push({
    id: 'b1',
    user_id: USER,
    url: 'https://example.com/a',
    url_key: 'https://example.com/a',
    title: 'Article A',
    favicon_url: null,
    description: null,
    note: null,
    cover_url: null,
    is_favorite: 0,
    is_archived: 0,
    is_private: 0,
    encrypted_blob: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  });
}

const listParams = (over: Partial<ListParams> = {}): ListParams => ({
  userId: USER,
  scope: 'all',
  q: null,
  tagIds: [],
  matchAllTags: false,
  sort: 'created_desc',
  cursor: null,
  limit: 50,
  ...over,
});

describe('vault crypto (PBKDF2 + AES-256-GCM)', () => {
  it('round-trips arbitrary JSON with a derived key', async () => {
    const salt = randomSalt();
    const key = await deriveKey('correct horse battery staple', salt);
    const data: VaultBookmarkData = {
      url: 'https://secret.example/x',
      title: 'Secret Page',
      description: 'do not show',
      note: 'private note',
      faviconUrl: 'https://secret.example/fav.ico',
      coverUrl: null,
      tagNames: ['finance', '2026'],
    };
    const blob: EncryptedBlob = await encryptJson<VaultBookmarkData>(key, data);
    expect(blob.v).toBe(1);
    expect(typeof blob.iv).toBe('string');
    expect(typeof blob.ct).toBe('string');
    const out = await decryptJson<VaultBookmarkData>(key, blob);
    expect(out).toEqual(data);
  });

  it('verifies the passphrase without ever recovering plaintext', async () => {
    const salt = randomSalt();
    const key = await deriveKey('hunter2', salt);
    const verifier = await makeVerifier(key);
    expect(await checkVerifier(key, verifier)).toBe(true);
    const wrongKey = await deriveKey('hunter3', salt);
    expect(await checkVerifier(wrongKey, verifier)).toBe(false);
  });

  it('a different passphrase cannot decrypt the ciphertext', async () => {
    const salt = randomSalt();
    const blob = await encryptJson(await deriveKey('alpha', salt), { url: 'u' });
    await expect(decryptJson(await deriveKey('beta', salt), blob)).rejects.toThrow();
  });

  it('derives a different key per salt (no key reuse across users)', async () => {
    const key1 = await deriveKey('same', randomSalt());
    const key2 = await deriveKey('same', randomSalt());
    const blob = await encryptJson(key1, { url: 'u' });
    await expect(decryptJson(key2, blob)).rejects.toThrow();
  });
});

describe('PRIVATE_BOOKMARK_CLAUSE isolation', () => {
  it('buildWhere injects the privacy filter into every public list query', () => {
    expect(buildWhere(listParams(), false).sql).toContain(PRIVATE_BOOKMARK_CLAUSE);
    expect(buildWhere(listParams({ scope: 'favorites' }), false).sql).toContain(
      PRIVATE_BOOKMARK_CLAUSE,
    );
    expect(buildWhere(listParams({ scope: 'archive' }), false).sql).toContain(
      PRIVATE_BOOKMARK_CLAUSE,
    );
    expect(buildWhere(listParams({ q: 'hello' }), false).sql).toContain(
      PRIVATE_BOOKMARK_CLAUSE,
    );
    expect(buildWhere(listParams({ tagIds: ['t1'] }), false).sql).toContain(
      PRIVATE_BOOKMARK_CLAUSE,
    );
  });

  it('the clause is the single user filter plus the privacy filter', () => {
    const w = buildWhere(listParams(), false);
    expect(w.params[0]).toBe(USER);
    expect(w.sql.startsWith('b.user_id = ? AND b.is_private = 0')).toBe(true);
  });
});

describe('listBookmarks / loadBookmark hide private rows', () => {
  it('excludes is_private rows from the public listing', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedBookmark(db, { id: 'pub1', url: 'https://pub1', url_key: 'https://pub1', title: 'Public' });
    seedBookmark(db, {
      id: 'priv1',
      url: 'https://priv1',
      url_key: 'https://priv1',
      title: 'Hidden',
      is_private: 1,
      encrypted_blob: 'CIPHERTEXT',
    });

    const res = await listBookmarks(env, listParams());
    const ids = res.items.map((i) => i.id);
    expect(ids).toContain('pub1');
    expect(ids).not.toContain('priv1');
  });

  it('loadBookmark returns null for a private bookmark', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedBookmark(db, { id: 'priv1', is_private: 1, encrypted_blob: 'CIPHERTEXT' });
    expect(await loadBookmark(env, USER, 'priv1')).toBeNull();
  });
});

describe('setBookmarkPrivate', () => {
  it('blanks plaintext, flags the row, and surfaces it only in the vault', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedBookmark(db, { id: 'b1', url: 'https://example.com/a', url_key: 'https://example.com/a', title: 'Article A' });

    const ok = await setBookmarkPrivate(env, USER, 'b1', 'ENC1');
    expect(ok).toBe(true);

    const row = db.bookmarks.find((b) => b.id === 'b1');
    expect(row.is_private).toBe(1);
    expect(row.url).toBe('');
    expect(row.title).toBe('');
    expect(row.description).toBeNull();
    expect(row.encrypted_blob).toBe('ENC1');
    expect(row.url_key).toBe('private:b1');

    // Now hidden from every public path.
    expect((await listBookmarks(env, listParams())).items.map((i) => i.id)).not.toContain('b1');
    expect(await loadBookmark(env, USER, 'b1')).toBeNull();

    // Visible as ciphertext in the dedicated reader.
    const priv = await listPrivateBookmarkRows(env, USER);
    expect(priv).toHaveLength(1);
    expect(priv[0].encryptedBlob).toBe('ENC1');
  });

  it('returns false for an already-private or missing bookmark', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedBookmark(db, { id: 'b1', is_private: 1, encrypted_blob: 'ENC' });
    expect(await setBookmarkPrivate(env, USER, 'b1', 'ENC2')).toBe(false);
    expect(await setBookmarkPrivate(env, USER, 'missing', 'ENC')).toBe(false);
  });
});

describe('clearBookmarkPrivate', () => {
  it('restores plaintext and re-links tags by name', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedBookmark(db, {
      id: 'b1',
      is_private: 1,
      encrypted_blob: 'ENC',
      url: '',
      title: '',
      url_key: 'private:b1',
    });
    db.tags.push({ id: 't1', user_id: USER, name: 'Finance', color_index: 0, parent_id: null, sort_order: 0, created_at: 't' });

    const fields: RestoredBookmarkFields = {
      url: 'https://example.com/a',
      title: 'Article A',
      description: 'desc',
      note: null,
      faviconUrl: null,
      coverUrl: null,
      tagNames: ['Finance'],
    };
    const bm = await clearBookmarkPrivate(env, USER, 'b1', fields);
    expect(bm).not.toBeNull();
    expect(bm!.url).toBe('https://example.com/a');
    expect(bm!.title).toBe('Article A');

    const row = db.bookmarks.find((b) => b.id === 'b1');
    expect(row.is_private).toBe(0);
    expect(row.encrypted_blob).toBeNull();
    expect(db.bookmark_tags.find((bt) => bt.bookmark_id === 'b1' && bt.tag_id === 't1')).toBeDefined();
  });

  it('detects a URL clash on restore and throws 409', async () => {
    const env = makeEnv();
    const db = env.DB as MockDb;
    seedBookmark(db, { id: 'b1', is_private: 1, url_key: 'private:b1' });
    seedBookmark(db, { id: 'b2', url: 'https://taken.com', url_key: urlKey(canonicalUrl('https://taken.com')), is_private: 0 });
    await expect(
      clearBookmarkPrivate(env, USER, 'b1', {
        url: 'https://taken.com',
        title: 'x',
        description: null,
        note: null,
        faviconUrl: null,
        coverUrl: null,
        tagNames: [],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('private bookmark CRUD (db functions)', () => {
  it('creates, lists, loads, re-encrypts, and deletes', async () => {
    const env = makeEnv();
    const id = await createPrivateBookmark(env, USER, 'ENC1', false, false);
    expect(id).toBeTruthy();

    const list = await listPrivateBookmarkRows(env, USER);
    expect(list).toHaveLength(1);
    expect(list[0].encryptedBlob).toBe('ENC1');

    expect((await loadPrivateBookmarkRow(env, USER, id))?.encryptedBlob).toBe('ENC1');

    expect(await updatePrivateBookmark(env, USER, id, 'ENC2')).toBe(true);
    expect((await loadPrivateBookmarkRow(env, USER, id))?.encryptedBlob).toBe('ENC2');

    expect(await deletePrivateBookmark(env, USER, id)).toBe(true);
    expect(await listPrivateBookmarkRows(env, USER)).toHaveLength(0);
  });

  it('update/delete report false for a missing id', async () => {
    const env = makeEnv();
    expect(await updatePrivateBookmark(env, USER, 'nope', 'x')).toBe(false);
    expect(await deletePrivateBookmark(env, USER, 'nope')).toBe(false);
    expect(await loadPrivateBookmarkRow(env, USER, 'nope')).toBeNull();
  });
});

describe('GET /api/private/vault', () => {
  it('reports not configured, then configured after setup', async () => {
    const env = makeEnv();
    let res = await getVault(makeCtx(env, USER, 'GET', '/api/private/vault'));
    expect(res.status).toBe(200);
    expect((await res.json()).configured).toBe(false);

    res = await postVault(
      makeCtx(env, USER, 'POST', '/api/private/vault', undefined, { salt: 'SALT', verifier: 'VER' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).configured).toBe(true);

    res = await getVault(makeCtx(env, USER, 'GET', '/api/private/vault'));
    const body = (await res.json()) as { configured: boolean; salt: string | null };
    expect(body.configured).toBe(true);
    expect(body.salt).toBe('SALT');
  });

  it('rejects setup without salt/verifier (400) and duplicates (409)', async () => {
    const env = makeEnv();
    await expect(
      postVault(makeCtx(env, USER, 'POST', '/api/private/vault', undefined, {})),
    ).rejects.toMatchObject({ status: 400 });

    await postVault(
      makeCtx(env, USER, 'POST', '/api/private/vault', undefined, { salt: 'SALT', verifier: 'VER' }),
    );
    await expect(
      postVault(makeCtx(env, USER, 'POST', '/api/private/vault', undefined, { salt: 'SALT2', verifier: 'VER2' })),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('GET/POST /api/private/bookmarks', () => {
  it('lists ciphertext and creates a new private bookmark (201)', async () => {
    const env = makeEnv();
    let res = await listPrivateBookmarks(makeCtx(env, USER, 'GET', '/api/private/bookmarks'));
    expect((await res.json()).items).toHaveLength(0);

    res = await createPrivateBookmarkHandler(
      makeCtx(env, USER, 'POST', '/api/private/bookmarks', undefined, { encryptedBlob: 'ENC' }),
    );
    expect(res.status).toBe(201);
    const newId = (await res.json()).id as string;
    expect(newId).toBeTruthy();

    res = await listPrivateBookmarks(makeCtx(env, USER, 'GET', '/api/private/bookmarks'));
    expect((await res.json()).items).toHaveLength(1);
    expect((env.DB as MockDb).bookmarks.find((b) => b.id === newId)?.is_private).toBe(1);

    // PATCH re-encrypt + GET one + DELETE.
    res = await patchPrivate(
      makeCtx(env, USER, 'PATCH', `/api/private/bookmarks/${newId}`, newId, { encryptedBlob: 'ENC2' }),
    );
    expect((await res.json()).encryptedBlob).toBe('ENC2');

    res = await getOnePrivate(makeCtx(env, USER, 'GET', `/api/private/bookmarks/${newId}`, newId));
    expect((await res.json()).encryptedBlob).toBe('ENC2');

    res = await deleteOnePrivate(makeCtx(env, USER, 'DELETE', `/api/private/bookmarks/${newId}`, newId));
    expect(res.status).toBe(204);

    res = await listPrivateBookmarks(makeCtx(env, USER, 'GET', '/api/private/bookmarks'));
    expect((await res.json()).items).toHaveLength(0);
  });

  it('rejects POST without encryptedBlob (400) and missing-id ops (404)', async () => {
    const env = makeEnv();
    await expect(
      createPrivateBookmarkHandler(makeCtx(env, USER, 'POST', '/api/private/bookmarks', undefined, {})),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      patchPrivate(makeCtx(env, USER, 'PATCH', '/api/private/bookmarks/x', 'x', { encryptedBlob: 'ENC' })),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      getOnePrivate(makeCtx(env, USER, 'GET', '/api/private/bookmarks/x', 'x')),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      deleteOnePrivate(makeCtx(env, USER, 'DELETE', '/api/private/bookmarks/x', 'x')),
    ).rejects.toMatchObject({ status: 404 });
  });
});
