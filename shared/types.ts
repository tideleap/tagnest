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
  | 'visits_desc';

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

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, string>;
  };
}

export const TAG_COLOR_COUNT = 8;
