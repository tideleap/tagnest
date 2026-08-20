import type { AiProvider } from '../../../shared/types';
import type { Env } from '../env';
import { decryptField } from '../crypto';
import { buildVocabulary } from './taxonomy';
import type { AiConfig, LocalConfig, VocabEntry, Vocabulary } from './types';

/**
 * Configuration loading and the "will inference actually run?" decision.
 *
 * ## The bug this module exists to kill
 *
 * The previous gate opened with `if (!row || row.enabled !== 1) return null`.
 * Nothing in the product ever set `enabled` to 1 — the column defaulted to 0,
 * registration hard-coded 0, and the settings UI had no such switch. So the
 * entire AI feature was unreachable in production while the settings page
 * cheerfully rendered a green "AI 已就绪" banner. A user could configure a
 * provider, a model and a key, see confirmation that it was working, and get
 * nothing, forever.
 *
 * ## The fix
 *
 * `enabled` is no longer an independent switch that can drift out of sync with
 * reality. It is now a **derived, read-only status**: the feature is live when
 * the configuration is complete, full stop. Nothing can be "configured but
 * silently off". Pausing is still possible and still explicit — set the
 * provider to 未选择, or turn off both automation toggles.
 *
 * The column is kept and written back on save so the UI and any future
 * reporting can read the resolved state without re-deriving it, but no read
 * path gates on it any more.
 */

/** Everything required for a model call, independent of the automation toggles. */
export interface ConfigRow {
  provider: AiProvider;
  baseUrl: string | null;
  model: string;
  apiKey: string | null;
  autoTag: boolean;
  autoSummarize: boolean;
  autoApplyThreshold: number;
  maxTags: number;
  /** Fetch each bookmark's page and feed a text excerpt to the model. */
  fetchContent: boolean;
  /** Extra coarse-to-fine refinement pass (costs ~1 extra call per batch). */
  twoPass: boolean;
}

const DEFAULT_MAX_TAGS = 4;
const DEFAULT_THRESHOLD = 1;

function clampThreshold(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD;
  return Math.min(1, Math.max(0, n));
}

function clampMaxTags(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_TAGS;
  return Math.min(8, Math.max(1, Math.trunc(n)));
}

/** Reads the raw settings row, decrypting the key. Returns defaults when absent. */
export async function loadConfigRow(env: Env, userId: string): Promise<ConfigRow> {
  const row = await env.DB.prepare(`SELECT * FROM ai_settings WHERE user_id = ? LIMIT 1`)
    .bind(userId)
    .first<Record<string, unknown>>();

  if (!row) {
    return {
      provider: 'none',
      baseUrl: null,
      model: '',
      apiKey: null,
      autoTag: false,
      autoSummarize: false,
      autoApplyThreshold: DEFAULT_THRESHOLD,
      maxTags: DEFAULT_MAX_TAGS,
      // Mirrors the migration defaults: fetching on (accuracy), two-pass off (cost).
      fetchContent: true,
      twoPass: false,
    };
  }

  return {
    provider: ((row.provider as AiProvider) ?? 'none') || 'none',
    baseUrl: (row.base_url as string | null) ?? null,
    model: typeof row.model === 'string' ? row.model.trim() : '',
    apiKey: await decryptField((row.api_key_encrypted as string | null) ?? null, env),
    autoTag: row.auto_tag === 1,
    autoSummarize: row.auto_summarize === 1,
    autoApplyThreshold: clampThreshold(row.auto_apply_threshold),
    maxTags: clampMaxTags(row.max_tags),
    // `!== 0` so a missing column (pre-migration row) still reads as the
    // migration default: fetching on, two-pass off.
    fetchContent: row.fetch_content !== 0,
    twoPass: row.two_pass === 1,
  };
}

/**
 * Whether a model call is possible with this configuration.
 *
 * Shared by the backend gate and — mirrored in `src/lib/ai-readiness.ts` — the
 * settings UI, so the banner and the behaviour cannot disagree again.
 */
export function isModelReady(row: ConfigRow): boolean {
  if (row.provider === 'none') return false;
  // A whitespace-only model name is not a usable model; without this a user who
  // pastes a stray space sees "ready" while every call 400s on an empty model.
  if (!row.model || !row.model.trim()) return false;
  if (!row.apiKey) return false;
  if (!row.autoTag && !row.autoSummarize) return false;
  return true;
}

/**
 * Config for a model call, or null when the model cannot run.
 *
 * Null is not an error: it means "fall back to the domain-derived fallback",
 * which is a fully supported mode rather than a failure.
 */
export async function loadAiConfig(env: Env, userId: string): Promise<AiConfig | null> {
  const row = await loadConfigRow(env, userId);
  if (!isModelReady(row)) return null;

  return {
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKey: row.apiKey as string,
    autoTag: row.autoTag,
    autoSummarize: row.autoSummarize,
    autoApplyThreshold: row.autoApplyThreshold,
    maxTags: row.maxTags,
    fetchContent: row.fetchContent,
    twoPass: row.twoPass,
  };
}

/** Limits that apply whether or not a model is available. */
export function toLocalConfig(row: ConfigRow): LocalConfig {
  return {
    autoApplyThreshold: row.autoApplyThreshold,
    maxTags: row.maxTags,
  };
}

/**
 * Loads the user's tags with live usage counts, ready for normalisation.
 *
 * Counts exclude trashed bookmarks so a tag that only survives on deleted rows
 * does not outrank one the user actively relies on.
 */
export async function loadVocabulary(env: Env, userId: string): Promise<Vocabulary> {
  const rows = await env.DB.prepare(
    `SELECT t.id AS id, t.name AS name, t.aliases AS aliases, t.parent_id AS parent_id,
            COUNT(b.id) AS cnt
       FROM tags t
       LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id
       LEFT JOIN bookmarks b ON b.id = bt.bookmark_id AND b.deleted_at IS NULL
      WHERE t.user_id = ?
      GROUP BY t.id, t.name, t.aliases, t.parent_id`,
  )
    .bind(userId)
    .all<Record<string, unknown>>();

  const entries: VocabEntry[] = rows.results.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    aliases: parseAliases(row.aliases),
    count: Number(row.cnt ?? 0),
    parentId: (row.parent_id as string | null) ?? null,
  }));

  return buildVocabulary(entries);
}

/** Aliases are stored as a JSON array; anything unparseable reads as none. */
export function parseAliases(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  } catch {
    return [];
  }
}
