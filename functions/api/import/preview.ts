import type { ImportPreview, ImportPreviewItem } from '../../../shared/types';
import type { Env, RequestData } from '../../_lib/env';
import { requireUserId } from '../../_lib/auth';
import { badRequest, json, tooLarge } from '../../_lib/http';
import { isoFromNow, nowIso, randomToken } from '../../_lib/ids';
import { detectSource, parseBySource } from '../../_lib/import-parsers';
import { urlKey } from '../../_lib/urlkey';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ITEMS = 20_000;
const SAMPLE_SIZE = 50;
const STAGING_TTL_MS = 15 * 60 * 1000;

/**
 * Parses an uploaded file and stages the result.
 *
 * Preview and commit are separate calls so the user sees exactly what will be
 * written — total, duplicates, folder list — before anything touches the
 * library. Staging the parsed payload also means the file is uploaded once.
 */
export const onRequestPost: PagesFunction<Env, string, RequestData> = async (ctx) => {
  const userId = requireUserId(ctx);

  let form: FormData;
  try {
    form = await ctx.request.formData();
  } catch {
    throw badRequest('请求不是合法的表单上传');
  }

  // `instanceof File` is not usable here: the Workers type surface declares
  // File as an interface, not a constructor value. Structural checks are what
  // the runtime actually needs anyway.
  const entry = form.get('file');
  if (!entry || typeof entry === 'string') throw badRequest('未收到文件');

  const file = entry as unknown as { size: number; name: string; text(): Promise<string> };
  if (typeof file.text !== 'function') throw badRequest('未收到文件');
  if (file.size === 0) throw badRequest('文件为空');
  if (file.size > MAX_FILE_BYTES) throw tooLarge('文件超过 20 MB 上限');

  const content = await file.text();
  const source = detectSource(file.name ?? '', content);
  const parsed = parseBySource(source, content);

  if (parsed.items.length === 0) {
    throw badRequest(
      source === 'html'
        ? '未能从该文件解析出书签，请确认是浏览器导出的 HTML 书签文件'
        : '未能从该文件解析出书签，请检查文件格式',
    );
  }

  if (parsed.items.length > MAX_ITEMS) {
    throw tooLarge(`单次最多导入 ${MAX_ITEMS} 条，当前文件包含 ${parsed.items.length} 条`);
  }

  // Within-file duplicates are collapsed first; otherwise the preview count
  // and the committed count would disagree.
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

  await ctx.env.DB.prepare(
    `INSERT INTO import_staging (token, user_id, source, payload, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      token,
      userId,
      source,
      JSON.stringify(unique),
      nowIso(),
      isoFromNow(STAGING_TTL_MS),
    )
    .run();

  // Opportunistic sweep of abandoned previews.
  await ctx.env.DB.prepare(`DELETE FROM import_staging WHERE expires_at < ?`)
    .bind(nowIso())
    .run();

  const preview: ImportPreview = {
    token,
    source,
    total: unique.length,
    duplicates,
    invalid: parsed.invalid,
    folders: folders.slice(0, 200),
    sample: previewItems.slice(0, SAMPLE_SIZE),
  };

  return json(preview);
};

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
