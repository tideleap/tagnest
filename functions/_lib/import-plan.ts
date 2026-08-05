import type { ParsedItem } from './import-parsers';

/**
 * Decides what the import writer should do with one parsed item.
 *
 * Pulled out of the commit handler as a pure function — no I/O, no statements —
 * because the decision it makes is the part that used to be wrong, and it was
 * unreachable from a test while it lived inside a ReadableStream.
 *
 * The rule that matters: the partial UNIQUE index on (user_id, url_key) WHERE
 * deleted_at IS NULL (migration 0004) means a URL that is already live CANNOT
 * get a second row. Planning an insert for it produces an id that `INSERT OR
 * IGNORE` throws away, and any bookmark_tags row pointing at that id is a
 * FOREIGN KEY violation — which `OR IGNORE` does NOT suppress, so D1 rolls the
 * entire batch back and up to 49 good bookmarks vanish with it.
 */
export type ImportRowPlan =
  /** URL already live and the user asked to skip duplicates. Write nothing. */
  | { kind: 'skip' }
  /** URL already live, duplicates not skipped: attach the file's tags to it. */
  | { kind: 'merge'; bookmarkId: string; tagIds: string[] }
  /** New URL: insert the bookmark, then link its tags. */
  | { kind: 'insert'; bookmarkId: string; tagIds: string[] };

export interface ImportPlanContext {
  /**
   * Live `url_key` → bookmark id. `planImportRow` writes reserved ids back
   * into it, so a URL repeated later in the same file resolves to the row this
   * import is about to create instead of racing it.
   */
  existing: Map<string, string>;
  /** Lower-cased tag name → tag id, resolved up front by the caller. */
  tagIdByLower: Map<string, string>;
  /** Tag ids applied to every row of this import. */
  extraIds: string[];
  /** Whether the leaf folder of the item's path becomes a tag. */
  foldersAsTags: boolean;
  /** Whether an already-live URL is left untouched. */
  skipDuplicates: boolean;
  /** Injectable so tests can assert on stable ids. */
  newId: () => string;
}

export function planImportRow(
  item: ParsedItem,
  key: string,
  ctx: ImportPlanContext,
): ImportRowPlan {
  const existingId = ctx.existing.get(key);
  if (existingId && ctx.skipDuplicates) return { kind: 'skip' };

  const tagIds = resolveTagIds(item, ctx);
  if (existingId) return { kind: 'merge', bookmarkId: existingId, tagIds };

  const bookmarkId = ctx.newId();
  ctx.existing.set(key, bookmarkId);
  return { kind: 'insert', bookmarkId, tagIds };
}

/** Every tag id the item should carry: the import-wide extras + its own + its folder. */
function resolveTagIds(item: ParsedItem, ctx: ImportPlanContext): string[] {
  const ids = new Set(ctx.extraIds);
  for (const name of item.tagNames) {
    const tagId = ctx.tagIdByLower.get(name.trim().toLowerCase());
    if (tagId) ids.add(tagId);
  }
  if (ctx.foldersAsTags) {
    const leaf = item.folderPath[item.folderPath.length - 1];
    const tagId = leaf ? ctx.tagIdByLower.get(leaf.trim().toLowerCase()) : undefined;
    if (tagId) ids.add(tagId);
  }
  return [...ids];
}
