import type { ImportPreview, ImportPreviewItem } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { ApiException, badRequest, json, tooLarge } from '../../_lib/http';
import { isoFromNow, nowIso, randomToken } from '../../_lib/ids';
import { detectSource, parseBySource } from '../../_lib/import-parsers';
import { decodeUploadBytes } from '../../_lib/encoding';
import { urlKey } from '../../_lib/urlkey';
import { createLogger } from '../../_lib/logger';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ITEMS = 20_000;
/** Safety cap on the staged payload — comfortably under D1's row size limit. */
const MAX_STAGED_BYTES = 8 * 1024 * 1024;
const SAMPLE_SIZE = 50;
const STAGING_TTL_MS = 15 * 60 * 1000;

/** Returns true when the error is a user-facing ApiException (let it bubble). */
function isUserError(e: unknown): boolean {
  return e instanceof ApiException;
}

/**
 * Parses an uploaded file and stages the result.
 *
 * Preview and commit are separate calls so the user sees exactly what will be
 * written before anything touches the library.
 *
 * Robustness: this endpoint must never surface a raw 500 on user input. Any
 * unexpected exception is logged with context and converted to a 4xx with a
 * specific, user-addressable message — so "解析失败 / 服务器内部错误" stops
 * being the only thing a user ever sees on a tricky export.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);
  const log = createLogger(ctx.env);

  try {
    return await handle(ctx, userId, log);
  } catch (e) {
    if (isUserError(e)) throw e;

    log.error('import.preview_failed', {
      userId,
      error: (e as Error)?.message ?? String(e),
      stack: (e as Error)?.stack ?? '',
    });
    // Not a recognised parse error, not a validation error — we report it as an
    // unreadable file so the user knows to re-export / re-check, and the log above
    // carries the real cause.
    throw badRequest('无法读取该文件，请确认文件未损坏或重新导出后再试', { code: 'import_unreadable' });
  }
};

async function handle(
  ctx: { request: Request; env: Env },
  userId: string,
  log: ReturnType<typeof createLogger>,
): Promise<Response> {
  let form: FormData;
  try {
    form = await ctx.request.formData();
  } catch {
    throw badRequest('请求不是合法的表单上传', { code: 'import_form' });
  }

  const entry = form.get('file');
  if (!entry || typeof entry === 'string') throw badRequest('未收到文件', { code: 'import_no_file' });

  const file = entry as unknown as {
    size: number;
    name: string;
    arrayBuffer(): Promise<ArrayBuffer>;
  };
  if (typeof file.arrayBuffer !== 'function') throw badRequest('未收到文件', { code: 'import_no_file' });
  if (file.size === 0) throw badRequest('文件为空', { code: 'import_empty' });
  if (file.size > MAX_FILE_BYTES) {
    throw tooLarge('文件超过 20 MB 上限，请先拆分或压缩后再导入');
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    log.error('import.read_failed', { userId, error: (e as Error)?.message ?? '' });
    throw badRequest('读取文件失败，请重试', { code: 'import_read' });
  }

  // Encoding-aware decode. The old `file.text()` was always UTF-8 and mangled
  // GBK / UTF-16 Chinese exports into U+FFFD garbage.
  const { text, encoding } = decodeUploadBytes(bytes);
  const fileName = typeof file.name === 'string' ? file.name : '';
  log.info('import.parsing', { userId, bytes: bytes.length, encoding, fileName });

  const source = detectSource(fileName, text);
  let parsed;
  try {
    parsed = parseBySource(source, text);
  } catch (e) {
    log.error('import.parse_error', {
      userId,
      source,
      encoding,
      error: (e as Error)?.message ?? 'unknown',
    });
    throw badRequest(
      source === 'html'
        ? '未能解析该 HTML 书签文件，请确认它是浏览器（Chrome / Edge / Firefox / Safari）导出的书签'
        : '未能解析该文件，请确认文件格式正确（书签 HTML、JSON 或 CSV）',
      { code: 'import_parse' },
    );
  }

  if (parsed.items.length === 0) {
    throw badRequest(
      source === 'html'
        ? '未能从该文件解析出书签，请确认是浏览器导出的 HTML 书签文件'
        : '未能从该文件解析出书签，请检查文件格式',
      { code: 'import_empty_parse' },
    );
  }

  if (parsed.items.length > MAX_ITEMS) {
    throw tooLarge(`单次最多导入 ${MAX_ITEMS} 条，当前文件包含 ${parsed.items.length} 条`);
  }

  // Collapse within-file duplicates so preview and commit counts agree.
  const seen = new Set<string>();
  const unique: typeof parsed.items = [];
  let selfDuplicates = 0;

  for (const item of parsed.items) {
    const key = urlKey(item.url);
    if (seen.has(key)) {
      selfDuplicates += 1;
      continue;
    }
    seen.add(key);
    unique.push(item);
  }

  const existingKeys = await loadExistingKeys(ctx.env, userId, [...seen]);

  const previewItems: ImportPreviewItem[] = unique.map((item) => ({
    url: item.url,
    title: item.title,
    folderPath: item.folderPath,
    addedAt: item.addedAt,
    duplicate: existingKeys.has(urlKey(item.url)),
  }));

  const duplicates = previewItems.filter((i) => i.duplicate).length + selfDuplicates;
  const folders = [
    ...new Set(unique.flatMap((i) => i.folderPath).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

  const token = randomToken(24);
  const payload = JSON.stringify(unique);
  if (payload.length > MAX_STAGED_BYTES) {
    throw tooLarge(`解析出的数据量过大（约 ${(payload.length / 1024).toFixed(0)} KB），请分多次导入`);
  }

  await ctx.env.DB.prepare(
    `INSERT INTO import_staging (token, user_id, source, payload, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(token, userId, source, payload, nowIso(), isoFromNow(STAGING_TTL_MS))
    .run();

  // Opportunistic sweep of abandoned previews.
  await ctx.env.DB.prepare(`DELETE FROM import_staging WHERE expires_at < ?`)
    .bind(nowIso())
    .run();

  return json<ImportPreview>({
    token,
    source,
    total: unique.length,
    duplicates,
    invalid: parsed.invalid,
    folders: folders.slice(0, 200),
    sample: previewItems.slice(0, SAMPLE_SIZE),
  });
}

/**
 * Duplicate lookup in chunks.
 *
 * SQLite caps a statement at 999 bound parameters, and a 20k-bookmark export
 * would blow straight past it.
 */
async function loadExistingKeys(
  env: Env,
  userId: string,
  keys: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  const CHUNK = 400;

  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const rows = await env.DB.prepare(
      `SELECT url_key FROM bookmarks
        WHERE user_id = ? AND deleted_at IS NULL
          AND url_key IN (${slice.map(() => '?').join(',')})`,
    )
      .bind(userId, ...slice)
      .all<{ url_key: string }>();
    for (const row of rows.results) found.add(row.url_key);
  }

  return found;
}
