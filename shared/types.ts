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

/**
 * Per-user preferences. Modelled on `ai_settings`: a `user_settings` row is
 * upserted on first write; the GET path returns defaulted values when no row
 * exists yet. Add new knobs as nullable/defaulted fields so old rows upgrade.
 */
export interface UserSettings {
  /**
   * How many snapshots up to which a bookmark may retain. Default 5.
   * -1 means unlimited (never prune). 0 is invalid and rejected by the API.
   */
  snapshotRetentionLimit: number;
  /**
   * "自动清空" (auto-clear on idle) — Search module.
   * When enabled, the search box clears itself after `searchAutoClearDelay`
   * seconds of inactivity. Defaults: on, 15s.
   */
  searchAutoClearEnabled: boolean;
  searchAutoClearDelay: number;
  /**
   * "自动清空" — Tag-filter module.
   * When enabled, the active tag filter is cleared after `tagsAutoClearDelay`
   * seconds of inactivity. Defaults: on, 30s.
   */
  tagsAutoClearEnabled: boolean;
  tagsAutoClearDelay: number;
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
  /** When true the tag (and its whole subtree) is private: every bookmark
   * carrying it is hidden from all normal lists/search/share/export. */
  isPrivate: boolean;
  createdAt: string;
}

/**
 * A bookmark as surfaced inside the authorized private-tags listing
 * (GET /api/private/tags). Only the plaintext fields the owner needs to
 * recognise and later un-hide a category-private bookmark are returned; the
 * full `Bookmark` shape (with snapshots, AI summary, etc.) is intentionally
 * omitted to keep the vault payload small.
 */
export interface PrivateTagBookmark {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  /** User-authored note, shown so the owner can identify the entry. */
  note: string | null;
  isFavorite: boolean;
  isArchived: boolean;
  createdAt: string;
  /** Full tag list for this bookmark (the private tag(s) that hide it plus any
   * ordinary tags). */
  tags: Tag[];
}

/** A private tag paired with the plaintext bookmarks it currently hides. */
export interface PrivateTagEntry {
  tag: Tag;
  bookmarks: PrivateTagBookmark[];
}

/** Response envelope for GET /api/private/tags. */
export interface PrivateTagsResponse {
  tags: PrivateTagEntry[];
}

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  description: string | null;
  faviconUrl: string | null;
  coverUrl: string | null;
  /**
   * R2 object key for the NEWEST generated website snapshot (e.g.
   * `snapshots/{userId}/{bookmarkId}-{ts}.webp`). When present the card shows
   * this first-party image instead of the raw remote `coverUrl`. Null until a
   * snapshot has been generated and stored.
   */
  snapshotKey: string | null;
  /**
   * R2 object keys of ALL currently retained snapshots for this bookmark,
   * ordered oldest → newest. When the retention limit is exceeded the oldest
   * entries are pruned. Empty array when no snapshot has been captured.
   */
  snapshotKeys: string[];
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

/** Response shape for `GET /api/bookmarks/:id/similar`. */
export interface SimilarBookmarks {
  items: Bookmark[];
  total: number;
}

export interface BookmarkInput {
  url: string;
  title?: string;
  description?: string | null;
  note?: string | null;
  faviconUrl?: string | null;
  coverUrl?: string | null;
  /** R2 key of a generated website snapshot, if one exists. */
  snapshotKey?: string | null;
  isFavorite?: boolean;
  isArchived?: boolean;
  tagNames?: string[];
  /** Set true to move a bookmark into the encrypted vault (with `encryptedBlob`). */
  isPrivate?: boolean;
  /** Base64 AES-GCM ciphertext blob for the vault; required when `isPrivate` is true. */
  encryptedBlob?: string;
}

export type BookmarkPatch = Partial<BookmarkInput>;

/* ------------------------------------------------------------------ *
 * Private (encrypted) bookmarks — the zero-knowledge vault
 *
 * A private bookmark is encrypted in the browser with a key derived from a
 * user-chosen passphrase (PBKDF2 + AES-GCM). The server stores only the
 * ciphertext and a `is_private` flag that hides the row from every ordinary
 * query. These contracts describe the dedicated /api/private endpoints.
 * ------------------------------------------------------------------ */

/** GET /api/private/vault */
export interface PrivateVaultStatus {
  /** True once the user has set a vault passphrase. */
  configured: boolean;
  /** PBKDF2 salt (public, safe to expose); null until the vault is configured. */
  salt: string | null;
  /** AES-GCM verifier blob (client-side, safe to expose); decryptable only with
   *  the correct passphrase-derived key. Lets the client confirm a typed
   *  passphrase without the server ever holding the key. */
  verifier: string | null;
}

/** POST /api/private/vault — both values are produced client-side from the passphrase. */
export interface SetVaultRequest {
  /** Base64 PBKDF2 salt. */
  salt: string;
  /** Base64 AES-GCM encryption of a known constant, used to verify the passphrase. */
  verifier: string;
}

/** A private bookmark as returned to the (unlocked) client: ciphertext only. */
export interface PrivateBookmarkListItem {
  id: string;
  /** Base64 AES-GCM blob; decrypt locally with the vault key. */
  encryptedBlob: string;
  isFavorite: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/private/bookmarks */
export interface PrivateBookmarksResponse {
  items: PrivateBookmarkListItem[];
}

/** POST /api/private/bookmarks — the client encrypts the fields before sending. */
export interface PrivateBookmarkInput {
  encryptedBlob: string;
  isFavorite?: boolean;
  isArchived?: boolean;
}

/** PATCH /api/private/bookmarks/:id */
export interface PrivateBookmarkPatch {
  encryptedBlob: string;
}

/** One entry in the real-time website snapshot monitor strip. */
export interface SnapshotMonitorItem {
  bookmarkId: string;
  title: string;
  url: string;
  snapshotKey: string;
  snapshotUrl: string;
  capturedAt: string | null;
  /** True when the latest snapshot is older than the freshness threshold. */
  isStale: boolean;
}

/** Response from GET /api/snapshots/monitor. */
export interface SnapshotMonitorStatus {
  items: SnapshotMonitorItem[];
  limit: number;
  refreshedAt: string;
}

/**
 * Explicit three-way snapshot freshness. Derivable from hasSnapshot/isStale
 * but exposed as an enum so the UI never re-derives (and diverges from) the
 * backend's definition:
 *   - none    — never captured
 *   - expired — captured, but older than the freshness threshold
 *   - fresh   — captured and within the threshold
 */
export type SnapshotState = 'none' | 'expired' | 'fresh';

/** Lightweight status for a single bookmark's latest snapshot. */
export interface BookmarkSnapshotStatus {
  bookmarkId: string;
  title: string;
  url: string;
  snapshotKey: string | null;
  snapshotUrl: string | null;
  capturedAt: string | null;
  /** True when a snapshot image actually exists for this bookmark. */
  hasSnapshot: boolean;
  /**
   * True only when a snapshot EXISTS but is older than the freshness
   * threshold. Distinct from `hasSnapshot`: a bookmark with no snapshot is
   * `hasSnapshot: false, isStale: false`.
   */
  isStale: boolean;
  /** Three-way freshness enum; the UI should prefer this over re-deriving. */
  state: SnapshotState;
}

export interface TagInput {
  name: string;
  colorIndex?: number;
  parentId?: string | null;
  isPrivate?: boolean;
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

/** One day's additions for the report page's collection-trend chart. */
export interface TrendPoint {
  /** Calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Bookmarks added that day (live, non-private). */
  count: number;
}

export interface StatsTrend {
  days: TrendPoint[];
}

/* ------------------------------------------------------------------ *
 * O1 — Library health
 * ------------------------------------------------------------------ */

export interface HealthDuplicateBookmark {
  id: string;
  title: string;
  url: string;
  createdAt: string;
}

export interface HealthDuplicateGroup {
  urlKey: string;
  count: number;
  bookmarks: HealthDuplicateBookmark[];
}

export interface HealthOrphanTag {
  id: string;
  name: string;
}

/** Structural report from GET /api/bookmarks/health (instant, pure SQL). */
export interface HealthReport {
  liveTotal: number;
  duplicateGroups: HealthDuplicateGroup[];
  duplicateExtra: number;
  orphanTags: HealthOrphanTag[];
  score: number;
}

export type ProbeStatus = 'ok' | 'dead' | 'auth' | 'suspicious' | 'blocked';

export interface ProbeResult {
  id: string;
  url: string;
  status: ProbeStatus;
  httpStatus: number | null;
}

export type AiProvider = 'none' | 'openai' | 'anthropic' | 'gemini' | 'custom';

/**
 * AI tagging configuration.
 *
 * `enabled` is **derived, not stored intent**: the server reports whether a
 * model call can actually be made (provider + model + key + at least one
 * automation toggle). It used to be an independent column that nothing ever
 * set to 1, which silently disabled the whole feature while the UI claimed it
 * was ready. Treat it as read-only status; changing behaviour means changing
 * the fields it is derived from.
 */
export interface AiSettings {
  provider: AiProvider;
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
  autoSummarize: boolean;
  autoTag: boolean;
  /** Read-only. True when inference can actually run. */
  enabled: boolean;
  /**
   * Confidence at or above which a suggestion is applied without review.
   * 1 = always review (default). Lowering it trades review for speed.
   */
  autoApplyThreshold: number;
  /** Upper bound on tags proposed per bookmark (1-8). */
  maxTags: number;
  /**
   * Fetch each bookmark's page and feed a text excerpt to the model.
   * The biggest accuracy lever; default on. Failed fetches degrade silently.
   */
  fetchContent: boolean;
  /**
   * Extra coarse-to-fine refinement pass: the model first judges each
   * bookmark's topic, then tags with that judgement as context. Costs about
   * one extra (cheap) call per batch; default off.
   */
  twoPass: boolean;
}

/* ------------------------------------------------------------------ *
 * AI tagging workflow
 * ------------------------------------------------------------------ */

/** Which engine produced a proposal. Surfaced so a fallback is never silent. */
export type AiEngineKind = 'model' | 'fallback' | 'none';

export type AiCandidateSource = 'model' | 'fallback' | 'taxonomy';

export type AiJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** What a run covers. `untagged` is the default because it pays off fastest. */
export type AiJobTarget = 'untagged' | 'all' | 'ids';

export interface AiJob {
  id: string;
  kind: string;
  status: AiJobStatus;
  /** What the run covered, surfaced so the history row can label it. */
  target?: AiJobTarget;
  total: number;
  processed: number;
  /** Proposals written so far. */
  suggested: number;
  failed: number;
  engine: AiEngineKind | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** Prompt template revision that produced this run (Phase 5, for A/B). */
  promptVersion?: string | null;
}

/** One proposed (bookmark, tag) pair awaiting a decision. */
export interface AiSuggestion {
  id: string;
  bookmarkId: string;
  bookmarkTitle: string;
  bookmarkUrl: string;
  tagName: string;
  tagId: string | null;
  confidence: number;
  source: AiCandidateSource;
  /** Why this tag was proposed, shown in the review queue. */
  reason: string | null;
  /**
   * One-phrase topic for the bookmark, generated by the model.
   * Used for in-job clustering and topic-distribution visualisation.
   */
  topic: string | null;
  /**
   * True when the model flagged the proposal as needing human review
   * even if confidence is not extremely low.
   */
  needsReview: boolean;
  /**
   * True when the user's feedback history lifted this proposal's confidence,
   * surfaced in the review queue as a "已学习" hint.
   */
  feedbackBoosted: boolean;
  createdAt: string;
  /**
   * Hierarchy path assigned by the auto-grouping rules, if any.
   * `category` is the top-level bucket, `subcategory` the second level,
   * and the tag itself forms the third level. Null subcategory means the
   * tag sits directly under the top-level category.
   */
  category: string | null;
  subcategory: string | null;
}

/** Result of applying the automatic three-level hierarchy to the tag set. */
export interface AutoGroupResult {
  /** Number of category / sub-category tags created. */
  createdCategories: number;
  /** Number of existing tags whose parent_id was rewritten. */
  relocated: number;
  /** Number of tags left untouched (unclassified or already deep enough). */
  untouched: number;
  /** Human-readable "一级 > 二级" summary lines. */
  summary: string[];
  /** Full tag tree after the hierarchy was applied. */
  tags: Tag[];
}

/**
 * Cost forecast for a batch run, computed before any model call (A1/T2).
 *
 * Token numbers are a character-based heuristic, not a tokenizer — the UI
 * must present them as estimates. `capped` tells the client that the scope
 * hit the per-run ceiling and more bookmarks exist than one run covers.
 */
export interface AiJobEstimate {
  target: AiJobTarget;
  /** Bookmarks the run would process. */
  bookmarks: number;
  /** Model calls (BATCH_SIZE bookmarks each). */
  batches: number;
  /** Client-driven run iterations (RUN_CHUNK bookmarks each). */
  chunks: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  /** False when no model is configured — the run would use the fallback only. */
  modelReady: boolean;
  /** True when the scope was clipped to the per-run maximum. */
  capped: boolean;
}

/** Result of one chunk of a run, so the UI can show live progress. */
export interface AiJobRunResult {
  job: AiJob;
  /** True when the snapshot is exhausted and no further run call is needed. */
  done: boolean;
  /** Proposals written by this chunk. */
  suggested: number;
  /** Applied without review because they cleared the threshold. */
  autoApplied: number;
  /** Bookmarks in this chunk that received only the domain fallback (no model tag). */
  uncovered: number;
  engine: AiEngineKind;
  modelError: string | null;
  /** Topic frequency produced by this chunk, for the result distribution chart. */
  topics?: AiTopicCount[];
  /**
   * Automatic 一级→二级→三级 grouping applied when the run finished.
   * Only present on the final chunk so mid-run responses stay small.
   */
  autoGrouped?: AutoGroupResult;
}

/** Topic frequency across a run, for the result distribution chart. */
export interface AiTopicCount {
  topic: string;
  /** Number of bookmarks carrying this topic. */
  count: number;
}


/** A group of tags that mean the same thing, proposed for merging. */
export interface AiTaxonomyCluster {
  canonicalId: string;
  canonicalName: string;
  canonicalCount: number;
  duplicates: Array<{ id: string; name: string; count: number }>;
  reason: string;
}

export interface AiTaxonomyAudit {
  totalTags: number;
  clusters: AiTaxonomyCluster[];
  /** Tags attached to nothing; safe to delete. */
  unused: Array<{ id: string; name: string }>;
  /** Tags attached to exactly one bookmark; governance candidates, not auto-deletable. */
  lowUsage: Array<{ id: string; name: string; count: number }>;
}

/** One recorded tag merge (audit trail, names snapshotted at merge time). */
export interface TagMergeLogEntry {
  id: string;
  targetTagId: string;
  targetTagName: string;
  sourceTagNames: string[];
  mergedCount: number;
  createdAt: string;
}

/** A proposed alias spelling for an existing tag, before the user confirms it. */
export interface AiAliasSuggestion {
  tagId: string;
  tagName: string;
  /** Proposed spellings not already covered by the tag. */
  aliases: string[];
  /** Why these were proposed (offline synonyms vs. AI). */
  reason?: string;
}

/** A group of pending suggestions sharing one model-supplied topic. */
export interface AiTopicCluster {
  topic: string;
  /** Distinct bookmarks carrying this topic. */
  bookmarkCount: number;
  /** Distinct tag names proposed under this topic (capped). */
  tagNames: string[];
}

export interface AiAliasSuggestionsResponse {
  aliasSuggestions: AiAliasSuggestion[];
  topicClusters: AiTopicCluster[];
  /** False when the model was unavailable and offline proposals were returned. */
  modelAvailable?: boolean;
}

/** Dashboard numbers for the organiser workbench. */
export interface AiOverview {
  /** Model reachable with the current settings. */
  modelReady: boolean;
  pendingSuggestions: number;
  untaggedBookmarks: number;
  totalBookmarks: number;
  /** Tag links written by AI vs. by the user — the contribution measure. */
  aiTagLinks: number;
  userTagLinks: number;
  recentJobs: AiJob[];
  /**
   * Suggestion-quality metrics (Phase 5). Derived from the accept/reject/modify
   * feedback recorded on every decision: how often the user kept a proposal, and
   * how often a proposed tag was ultimately accepted across the whole queue.
   */
  feedback: AiFeedbackMetrics;
  /** Daily accept/reject counts for the last 30 days, for the trend chart. */
  feedbackTrend: AiFeedbackTrendPoint[];
  /** Active prompt-template revision; bump to compare revisions (A/B). */
  promptVersion: string;
  /** How often the AI organiser is actually used (frequency + coverage). */
  usage: AiUsageMetrics;
  /** Value-weighted AI contribution to the tag graph. */
  contribution: AiContributionMetrics;
}

/** Headline suggestion-quality numbers shown on the workbench. */
export interface AiFeedbackMetrics {
  /** Total feedback events recorded. */
  total: number;
  accepted: number;
  rejected: number;
  modified: number;
  /** Fraction (0..1) of resolved decisions the user kept a suggestion for. */
  acceptanceRate: number;
  /** Total proposed suggestions ever written (all statuses). */
  proposalTotal: number;
  /** Of those, how many the user accepted. */
  proposalAccepted: number;
  /** Precision across the whole queue, 0..1. */
  hitRate: number;
}

/** One point on the evaluation trend chart. */
export interface AiFeedbackTrendPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  accepted: number;
  rejected: number;
}

/**
 * How often the user actually drives bookmarks through the AI organiser.
 *
 * Headline is `adoptionRate`: distinct bookmarks that entered the organise
 * flow in the last 30 days, divided by the user's current bookmark pool. The
 * split dimensions (scope target, actual engine) explain *why* the rate is what
 * it is — e.g. a low rate driven entirely by `ids` (manual single selects)
 * means the "organise all untagged" entry point is underused, not that the user
 * ignores AI.
 */
export interface AiUsageMetrics {
  /** 0..1 — touched bookmarks in last 30d / total bookmarks. */
  adoptionRate: number;
  /** Distinct bookmarks that entered the organise flow in the window. */
  touchedBookmarks: number;
  /** Current non-trashed, non-private bookmark pool (the denominator). */
  totalBookmarks: number;
  /** Distinct bookmarks touched, partitioned by the scope they were run under. */
  byScope: { target: 'untagged' | 'all' | 'ids'; count: number }[];
  /** Suggestion rows produced, split by the engine that actually ran. */
  byEngine: { engine: 'model' | 'fallback'; count: number }[];
  /** Number of organise runs (non-cancelled) in the last 30 days. */
  runsLast30Days: number;
  /** Average bookmarks processed per run (size of a typical job). */
  avgRunSize: number;
  /** Outcome of every suggestion ever written, for the acceptance funnel. */
  suggestionOutcome: {
    accepted: number;
    rejected: number;
    pending: number;
    /** Accepted at/above the user's auto-apply threshold. */
    autoApplied: number;
  };
}

/**
 * A value-weighted view of how much the AI actually contributes to the tag
 * graph, replacing the old flat `aiTagLinks / total` ratio.
 *
 * Each landed tag link is weighted by the kind of contribution it represents:
 *
 *   - direct   (model/taxonomy accepted as-is)   → 1.0
 *   - assisted (user renamed the proposal)        → 0.6
 *   - fallback (domain-heuristic accepted)        → 0.5
 *
 * Rejected proposals are excluded from the denominator entirely, so proposing
 * more and being rejected more does not inflate the score. `userOnly` links are
 * the baseline that fills out the denominator.
 */
export interface AiContributionMetrics {
  /** 0..1 — weighted AI value / (weighted AI value + user-only value). */
  weightedRate: number;
  /** Distinct decision units, classified by contribution kind. */
  directAi: number;
  assistedAi: number;
  fallbackAi: number;
  /** `bookmark_tags.source` that is neither AI nor a decided proposal. */
  userOnly: number;
  /** Raw counts, surfaced so the UI can explain the weighted figure. */
  raw: {
    aiAccepted: number;
    modified: number;
    rejected: number;
    fallbackAccepted: number;
    userCreated: number;
  };
  /** Precision: accepted / (accepted + rejected) across all proposals. */
  hitRate: number;
  /** Share of resolved proposals the user kept (accepted == kept here). */
  acceptanceRate: number;
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

/**
 * `directory` is the navigation-site theme: visitors see bookmarks grouped
 * under their first-/second-level tags with collapsible sections, matching
 * the hao123 / haosou category-browse pattern. Data is pre-aggregated into
 * `DirectoryGroup`s by the backend so the page never re-derives the layout.
 */
export type ShareTheme = 'default' | 'compact' | 'cards' | 'directory';

/** A category in the directory theme: a top-level tag plus its child sub-categories. */
export interface DirectoryGroup {
  /** Stable id — the tag id for tagged groups, `__untagged` for the catch-all. */
  id: string;
  /** Human-readable group name shown in the sidebar and section header. */
  name: string;
  /** Tag palette slot for the sidebar accent. 0..7; ignored for the untagged group. */
  colorIndex: number;
  /** Bookmarks that match the top-level tag but NOT any of its child sub-categories. */
  directItems: PublicBookmark[];
  /** Sub-categories (second-level tags) keyed by tag id. */
  children: DirectoryChildGroup[];
}

export interface DirectoryChildGroup {
  id: string;
  name: string;
  colorIndex: number;
  items: PublicBookmark[];
}

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
  /**
   * True when visitors must supply a password. The hash itself never leaves
   * the server; the public endpoint answers 401 until the correct password is
   * presented via the `X-Share-Password` header.
   */
  hasPassword: boolean;
  /**
   * When set, the share renders this collection's bookmarks (in collection
   * order) instead of running a tag query. Mutually exclusive with tagIds.
   */
  collectionId: string | null;
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
  /**
   * Visitor password. A non-empty string sets/replaces it; `null` removes it;
   * omitting leaves the stored password untouched (PATCH semantics mirror
   * `expiresInDays`).
   */
  password?: string | null;
  /** Share a whole collection instead of a tag query; `null` clears it. */
  collectionId?: string | null;
}

/* ------------------------------------------------------------------ *
 * Backup targets & runs (Y2: WebDAV / S3 push)
 * ------------------------------------------------------------------ */

export type BackupKind = 'webdav' | 's3';
export type BackupFrequency = 'off' | 'daily' | 'weekly';

/** A configured remote destination. The secret is NEVER returned to the client. */
export interface BackupTarget {
  id: string;
  kind: BackupKind;
  endpoint: string;
  bucket: string | null;
  username: string | null;
  remotePath: string;
  enabled: boolean;
  frequency: BackupFrequency;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'failed' | null;
  createdAt: string;
  updatedAt: string;
}

/** Write payload for upserting a target. Omitting `secret` keeps the stored one. */
export interface BackupTargetInput {
  id?: string;
  kind: BackupKind;
  endpoint: string;
  bucket?: string | null;
  username?: string | null;
  /** Plaintext secret (WebDAV password or S3 secret key); encrypted server-side. Omit to leave unchanged. */
  secret?: string | null;
  remotePath?: string;
  enabled?: boolean;
  frequency?: BackupFrequency;
}

export interface BackupRun {
  id: string;
  targetId: string;
  kind: BackupKind;
  endpoint: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'ok' | 'failed';
  bytes: number | null;
  sha256: string | null;
  error: string | null;
}

/** Trimmed bookmark shape served to anonymous visitors. */
export interface PublicBookmark {
  id: string;
  url: string;
  title: string;
  description: string | null;
  faviconUrl: string | null;
  note: string | null;
  /**
   * Slim by default (name + color only). The `directory` share theme upgrades
   * these to the full form with `id`/`parentId` so the backend can bucket
   * items into the two-level DirectoryGroup tree.
   */
  tags: { name: string; colorIndex: number; id?: string; parentId?: string | null }[];
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
  /**
   * Pre-aggregated category layout, populated only when `theme === 'directory'`.
   * Omitted for other themes — the client falls back to a flat list then.
   */
  groups?: DirectoryGroup[];
  total: number;
  updatedAt: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, string>;
    /** True when the operation may succeed if retried as-is (transient). */
    retriable?: boolean;
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

/* ------------------------------------------------------------------ *
 * Collections (design plan module) — a user-curated NAMED set of
 * bookmarks. Distinct from tags (free-form vocabulary) and from tab
 * groups (ordered scratch sets); collections are the persistent,
 * shareable "reading list" primitive.
 * ------------------------------------------------------------------ */

export type CollectionKind = 'manual' | 'smart';

/**
 * A serializable search filter, aligned 1:1 with `listBookmarks` ListParams.
 * Stored as JSON on a `smart` collection's `query` column; `null` for `manual`.
 */
export interface SavedSearchQuery {
  /** Free-text keyword (max 200 chars). */
  q: string | null;
  /** Tag ids (max 20). */
  tagIds: string[];
  /** Require all listed tags rather than any. */
  matchAllTags: boolean;
  /** Bookmark scope. */
  scope: BookmarkScope;
  /** Sort order. */
  sort: BookmarkSort;
}

export interface Collection {
  id: string;
  name: string;
  /** Palette slot 0-7, shared with tags. */
  colorIndex: number;
  /** Bookmarks currently in the collection. For `smart` collections this is a
   *  live count computed from `query`, not a stored membership size. */
  count: number;
  /** `manual` = curated membership via collection_bookmarks; `smart` = live
   *  members resolved from `query`. */
  kind: CollectionKind;
  /** Serialized SavedSearchQuery for `smart` collections; `null` otherwise. */
  query: SavedSearchQuery | null;
  createdAt: string;
  updatedAt: string;
}

/** Minimal bookmark shape served inside a collection detail view. */
export interface CollectionBookmarkItem {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
}

export interface CollectionWithBookmarks {
  collection: Collection;
  bookmarks: CollectionBookmarkItem[];
}

/* ------------------------------------------------------------------ *
 * RSS feeds (B-11) — server-pulled subscriptions that auto-create bookmarks.
 * ------------------------------------------------------------------ */

/** How often a feed is meant to be refreshed. No scheduler exists yet, so
 *  `off` means manual-only and the other values bound the "refresh all due"
 *  window. */
export type FeedCadence = 'off' | 'hourly' | 'daily' | 'weekly';

export const FEED_CADENCES: FeedCadence[] = ['off', 'hourly', 'daily', 'weekly'];

/** A user's RSS/Atom subscription as returned to the client. */
export interface Feed {
  id: string;
  userId: string;
  title: string;
  url: string;
  /** Default tags applied to every bookmark pulled from this feed. */
  tagNames: string[];
  cadence: FeedCadence;
  /** ISO timestamp of the last successful (or attempted) fetch, or null. */
  lastFetchedAt: string | null;
  /** Short machine status for the last fetch: 'ok' | 'empty' | 'http_###' |
   *  'feed_blocked_host' | 'feed_fetch_failed' | 'never' | null. */
  lastStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Write payload for subscribing to a feed. */
export interface FeedInput {
  url: string;
  title?: string;
  tagNames?: string[];
  cadence?: FeedCadence;
}

/** Outcome of refreshing one feed (manual or via "refresh all"). */
export interface FeedRefreshResult {
  feedId: string;
  added: number;
  skipped: number;
  failed: number;
}
