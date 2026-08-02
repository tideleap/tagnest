/**
 * Contract shared by the browser bundle and the Cloudflare Pages Functions.
 * Both sides import from here so a field rename cannot silently drift.
 */

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: string;
}

export interface Tag {
  id: string;
  name: string;
  /** Palette slot 0-7; resolved to a real colour in the UI layer. */
  colorIndex: number;
  parentId: string | null;
  sortOrder: number;
  /** Bookmarks currently referencing this tag (excludes trashed ones). */
  count: number;
  createdAt: string;
}

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  description: string | null;
  faviconUrl: string | null;
  coverUrl: string | null;
  /** User-authored note, markdown-ish plain text. */
  note: string | null;
  /** Reserved for the AI feature; always null until a model is wired up. */
  aiSummary: string | null;
  isFavorite: boolean;
  isArchived: boolean;
  visitCount: number;
  lastVisitedAt: string | null;
  /** Drag-order weight; 0 means the item has never been positioned. */
  manualOrder: number;
  tags: Tag[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type BookmarkScope = 'inbox' | 'all' | 'favorites' | 'archive' | 'trash';

export type BookmarkSort =
  | 'created_desc'
  | 'created_asc'
  | 'updated_desc'
  | 'title_asc'
  | 'visits_desc'
  /** User-defined drag order; unpositioned items fall back to newest-first. */
  | 'manual';

export interface BookmarkQuery {
  scope?: BookmarkScope;
  q?: string;
  tagIds?: string[];
  /** All listed tags must be present, rather than any of them. */
  matchAllTags?: boolean;
  sort?: BookmarkSort;
  cursor?: string | null;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export interface BookmarkInput {
  url: string;
  title?: string;
  description?: string | null;
  note?: string | null;
  faviconUrl?: string | null;
  coverUrl?: string | null;
  isFavorite?: boolean;
  isArchived?: boolean;
  tagNames?: string[];
}

export type BookmarkPatch = Partial<BookmarkInput>;

export interface TagInput {
  name: string;
  colorIndex?: number;
  parentId?: string | null;
}

export interface ImportPreviewItem {
  url: string;
  title: string;
  folderPath: string[];
  addedAt: string | null;
  /** True when the URL already exists in the account. */
  duplicate: boolean;
}

export interface ImportPreview {
  /** Server-side handle for the staged payload; expires after 15 minutes. */
  token: string;
  source: 'html' | 'json' | 'csv';
  total: number;
  duplicates: number;
  invalid: number;
  folders: string[];
  sample: ImportPreviewItem[];
}

export interface ImportCommit {
  token: string;
  /** Turn Netscape folder structure into tags. */
  foldersAsTags: boolean;
  skipDuplicates: boolean;
  /** Extra tags applied to every imported bookmark. */
  extraTagNames?: string[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  tagsCreated: number;
}

export interface Stats {
  bookmarks: number;
  tags: number;
  favorites: number;
  archived: number;
  trashed: number;
  untagged: number;
  addedLast7Days: number;
}

export type AiProvider = 'none' | 'openai' | 'anthropic' | 'gemini' | 'custom';

/**
 * Persisted but inert. The UI exposes these controls and the API stores them;
 * no request is ever made to a provider until the feature ships.
 */
export interface AiSettings {
  provider: AiProvider;
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
  autoSummarize: boolean;
  autoTag: boolean;
  enabled: boolean;
}

/* ------------------------------------------------------------------ *
 * Personal access keys
 * ------------------------------------------------------------------ */

export type ApiKeyScope = 'read' | 'write';

export interface ApiKey {
  id: string;
  name: string;
  /** First 12 characters of the token, e.g. `tnk_A1b2C3d4`. */
  prefix: string;
  scopes: ApiKeyScope[];
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface ApiKeyInput {
  name: string;
  scopes?: ApiKeyScope[];
  /** Days until expiry; omit or 0 for a key that never expires. */
  expiresInDays?: number;
}

/** The only response that ever contains the plaintext token. */
export interface ApiKeyCreated {
  key: ApiKey;
  token: string;
}

/* ------------------------------------------------------------------ *
 * Public shares
 * ------------------------------------------------------------------ */

export type ShareTheme = 'default' | 'compact' | 'cards';

/** A color palette a share page renders with (a ResolvedTheme key). */
export type SharePalette = 'light' | 'dark' | 'aurora' | 'blossom' | 'starlight';

export interface Share {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  tagIds: string[];
  matchAllTags: boolean;
  includeNotes: boolean;
  theme: ShareTheme;
  palette: SharePalette;
  isActive: boolean;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  /** Absolute path of the public page, e.g. `/s/reading-list`. */
  url: string;
}

export interface ShareInput {
  title: string;
  slug?: string;
  description?: string | null;
  tagIds?: string[];
  matchAllTags?: boolean;
  includeNotes?: boolean;
  theme?: ShareTheme;
  palette?: SharePalette;
  isActive?: boolean;
  /** Days until the link stops resolving; omit or 0 for no expiry. */
  expiresInDays?: number;
}

/** Trimmed bookmark shape served to anonymous visitors. */
export interface PublicBookmark {
  id: string;
  url: string;
  title: string;
  description: string | null;
  faviconUrl: string | null;
  note: string | null;
  tags: { name: string; colorIndex: number }[];
  createdAt: string;
}

export interface PublicShare {
  title: string;
  description: string | null;
  theme: ShareTheme;
  palette: SharePalette;
  owner: string;
  tags: { name: string; colorIndex: number }[];
  items: PublicBookmark[];
  total: number;
  updatedAt: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, string>;
  };
}

export const TAG_COLOR_COUNT = 8;

/* ------------------------------------------------------------------ *
 * Tab groups (O12) — a user-curated ordered set of existing bookmarks.
 * ------------------------------------------------------------------ */

export interface TabGroup {
  id: string;
  name: string;
  /** Palette slot 0-7, shared with tags. */
  colorIndex: number;
  /** Number of bookmarks currently in the group. */
  count: number;
  createdAt: string;
  updatedAt: string;
}

export interface TabItemBookmark {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
}

export interface TabItem {
  id: string;
  groupId: string;
  bookmarkId: string;
  position: number;
  bookmark: TabItemBookmark;
  createdAt: string;
}

export interface GroupWithItems {
  group: TabGroup;
  items: TabItem[];
}
