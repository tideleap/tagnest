/**
 * ML classifier for bookmarks — the "smart" half of AI 整理.
 *
 * Given a bookmark's title / url / description / tags, it predicts its place in
 * the three-level taxonomy (一级大类 → 二级子类 → 三级具体标签) using a
 * **multinomial Naive-Bayes** text classifier trained on `taxonomy-ml.ts`.
 *
 * Why Naive Bayes:
 *  - It is a genuine machine-learning model (probabilistic, learns from data),
 *    not a `if string.includes(...)` rule — so it produces a *calibrated*
 *    confidence we can threshold on.
 *  - It runs in pure JS with no model weights file, so it executes on the
 *    Cloudflare edge in microseconds and needs no API key. The same engine
 *    works offline; an external LLM can later replace `classifyBookmark`'s
 *    scoring without changing the I/O contract.
 *  - It is deterministic: identical input → identical output, which is what
 *    makes batch runs reproducible (see `classifyBatch`).
 *
 * ## Output contract (see `BookmarkClassPrediction`)
 *
 * Every bookmark gets exactly one prediction:
 *  - `category` / `subcategory` — the 1st/2nd level, or `null` when confidence
 *    is below `confidenceThreshold` (the item is sent to `needsReview`).
 *  - `suggestedTag` — the 3rd level, the most specific label, derived from the
 *    bookmark's own content (an existing tag that hits the class, else the
 *    subcategory name).
 *  - `confidence` — P(class) in [0,1], softmax-calibrated and coverage-penalised.
 *  - `quarantined` — true for content-safety matches; such items are never
 *    filed into the productivity hierarchy.
 *
 * ## Confidence threshold & constraints
 *
 *  - `confidenceThreshold` (default 0.6) is the floor for auto-filing. Below it
 *    the prediction is `needsReview` and `category`/`subcategory` are null so no
 *    wrong hierarchy edge is written.
 *  - `minCoverage` / `zeroSignalFactor` stop zero-signal bookmarks (no feature
 *    hit at all) from ranking high on prior alone.
 */

import { CLASSIFICATION_TAXONOMY, flattenTaxonomy, matchesSafety, type ClassEntry } from './taxonomy-ml';

/* ------------------------------------------------------------------ *
 * Public I/O types
 * ------------------------------------------------------------------ */

/** What the classifier needs about a bookmark. All fields optional except id. */
export interface BookmarkClassInput {
  id: string;
  title: string;
  url: string;
  description?: string | null;
  /** Existing tag names — strong signal for the 3rd-level leaf. */
  tags?: string[];
}

/** The prediction for one bookmark. `category`/`subcategory` null ⇒ review. */
export interface BookmarkClassPrediction {
  bookmarkId: string;
  /** 一级大类, or null when below threshold / quarantined. */
  category: string | null;
  /** 二级子类, or null when below threshold / quarantined. */
  subcategory: string | null;
  /** 三级具体标签 — most specific label (an existing tag or the subcategory). */
  suggestedTag: string | null;
  /** Calibrated probability in [0,1]. */
  confidence: number;
  engine: 'model' | 'none';
  /** True when confidence < threshold and the item needs a human decision. */
  needsReview: boolean;
  /** True when content-safety matched; never filed into a category. */
  quarantined: boolean;
  quarantineReason?: string;
  /** Short human-readable explanation for the review queue. */
  reason: string;
}

export interface ClassifyOptions {
  /** Auto-file floor in [0,1]. Default 0.6. */
  confidenceThreshold: number;
  /** Softmax temperature: lower ⇒ sharper probabilities / stricter ranking. */
  temperature: number;
  /** Multiplier applied to confidence when the bookmark has zero feature hits. */
  zeroSignalFactor: number;
  /**
   * Minimum fraction of a bookmark's features that must be in-vocabulary for
   * full confidence. Below this, confidence is linearly damped.
   */
  minCoverage: number;
}

export const DEFAULT_CLASSIFY_OPTIONS: ClassifyOptions = {
  confidenceThreshold: 0.5,
  temperature: 0.5,
  zeroSignalFactor: 0.2,
  minCoverage: 0.15,
};

/** Aggregate result of a batch run — the stability/monitoring surface. */
export interface BatchClassifyResult {
  total: number;
  classified: number;
  needsReview: number;
  quarantined: number;
  /** Mean confidence across items that were auto-filed. */
  avgConfidence: number;
  /** Count of items whose top probability landed in each confidence band. */
  confidenceHistogram: { band: string; count: number }[];
  /** Per-category counts of auto-filed items (category → n). */
  byCategory: Record<string, number>;
  /** Per-bookmark predictions, in input order. */
  predictions: BookmarkClassPrediction[];
  engine: 'model';
}

/* ------------------------------------------------------------------ *
 * Feature extraction
 * ------------------------------------------------------------------ */

/** Splits free text into model features: Latin words + CJK char 1–3 grams. */
export function extractFeatures(text: string): string[] {
  const out = new Set<string>();
  const lower = text.toLowerCase();

  // Latin / digit runs (words, abbreviations, domain tokens like "react").
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9+#.%/-]*[a-z0-9]/g)) {
    const w = m[0];
    if (w.length >= 2) out.add(w);
  }

  // CJK runs → unigrams, bigrams, trigrams. Bigrams let 2-char feature words
  // (like 教程, 前端) match bookmark text exactly.
  for (const run of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const s = run[0];
    for (let n = 1; n <= 3; n += 1) {
      for (let i = 0; i + n <= s.length; i += 1) out.add(s.slice(i, i + n));
    }
  }
  return [...out];
}

/* ------------------------------------------------------------------ *
 * Model
 * ------------------------------------------------------------------ */

export interface ModelClass {
  category: string;
  subcategory: string;
  /** log P(class) */
  logPrior: number;
  /** feature → log P(feature | class), Laplace-smoothed. */
  logLik: Map<string, number>;
  /** feature → IDF weight (high for rare/distinctive features). */
  idf: Map<string, number>;
  /** features of this class, for 3rd-level leaf recovery. */
  features: string[];
}

export interface ClassificationModel {
  classes: ModelClass[];
  vocab: Set<string>;
}

/**
 * Trains the Naive-Bayes model from the taxonomy.
 *
 * Each subcategory becomes a training "document" built from its features
 * (the category name and subcategory name are each repeated to act as mild
 * priors). Laplace smoothing (alpha = 1) keeps unseen features finite. The
 * model is built once and reused across every bookmark in a batch, which is
 * what makes batch classification O(n) and fully deterministic.
 */
export function buildClassificationModel(): ClassificationModel {
  const entries: ClassEntry[] = flattenTaxonomy();
  const docs: Array<{ entry: ClassEntry; tokens: string[] }> = [];

  // Build each class's token corpus, with weighted anchors for separation.
  for (const cat of CLASSIFICATION_TAXONOMY) {
    for (const sub of cat.subcategories) {
      docs.push({
        entry: { category: cat.name, subcategory: sub.name },
        tokens: buildClassDoc(cat.name, sub.name, sub.features),
      });
    }
  }

  const vocab = new Set<string>();
  const counts = docs.map((d) => {
    const m = new Map<string, number>();
    for (const t of d.tokens) {
      m.set(t, (m.get(t) ?? 0) + 1);
      vocab.add(t);
    }
    return m;
  });

  const alpha = 1;
  const V = vocab.size;
  const totalDocs = docs.length;
  const priorDenom = totalDocs + alpha * entries.length;

  // Document frequency of each feature across the class set — drives IDF.
  // Rare, distinctive features (e.g. "react", appearing in one class) get a
  // high weight; generic words shared by many classes (e.g. "文档") get damped.
  // This is what stops "React 文档" from filing under 学习资料 just because
  // "文档" happens to occur twice.
  const df = new Map<string, number>();
  for (const m of counts) for (const f of m.keys()) df.set(f, (df.get(f) ?? 0) + 1);
  const idfOf = (f: string): number => Math.log(totalDocs / Math.max(1, df.get(f) ?? 0));

  const classes: ModelClass[] = docs.map((d, i) => {
    const nClass = d.tokens.length;
    const denom = nClass + alpha * V;
    const logLik = new Map<string, number>();
    const idf = new Map<string, number>();
    for (const f of vocab) {
      const c = counts[i].get(f) ?? 0;
      logLik.set(f, Math.log((c + alpha) / denom));
      idf.set(f, idfOf(f));
    }
    return {
      category: d.entry.category,
      subcategory: d.entry.subcategory,
      logPrior: Math.log((1 + alpha) / priorDenom),
      logLik,
      idf,
      features: d.tokens,
    };
  });

  return { classes, vocab };
}

/**
 * Builds each class's training "document" with weighted anchors.
 *
 * Distinctive subcategory features are repeated (×`FEATURE_WEIGHT`) and the
 * category / subcategory names are repeated harder (×`ANCHOR_WEIGHT`) so a
 * bookmark that actually contains "react" or "教程" pushes its class clearly
 * ahead of the ~30 others. Without this weighting every class scores within a
 * fraction of a unit and no prediction is ever confident — the softmax would
 * never clear any threshold.
 */
const FEATURE_WEIGHT = 3;
const ANCHOR_WEIGHT = 5;

function buildClassDoc(catName: string, subName: string, features: string[]): string[] {
  const tokens: string[] = [];
  for (const f of features) {
    const feats = extractFeatures(f);
    for (let i = 0; i < FEATURE_WEIGHT; i += 1) tokens.push(...feats);
  }
  const catTokens = extractFeatures(catName);
  const subTokens = extractFeatures(subName);
  for (let i = 0; i < ANCHOR_WEIGHT; i += 1) {
    tokens.push(...catTokens, ...subTokens);
  }
  return tokens;
}

/* ------------------------------------------------------------------ *
 * Single-item classification
 * ------------------------------------------------------------------ */

function leafFor(input: BookmarkClassInput, cls: ModelClass): string | null {
  // Prefer an existing tag that is a feature of the winning class.
  const featSet = new Set(cls.features);
  for (const tag of input.tags ?? []) {
    const t = tag.toLowerCase();
    if (featSet.has(t)) return tag;
    // also accept substring containment of a feature within the tag name
    for (const f of featSet) if (f.length >= 2 && t.includes(f)) return tag;
  }
  return null;
}

/**
 * Classifies one bookmark. Pure and deterministic.
 *
 * `options` is merged over {@link DEFAULT_CLASSIFY_OPTIONS}; pass nothing to use
 * the defaults. Returns a single {@link BookmarkClassPrediction}.
 */
export function classifyBookmark(
  model: ClassificationModel,
  input: BookmarkClassInput,
  options?: Partial<ClassifyOptions>,
): BookmarkClassPrediction {
  const opts: ClassifyOptions = { ...DEFAULT_CLASSIFY_OPTIONS, ...options };
  const text = [input.title, input.url, input.description ?? '', ...(input.tags ?? [])].join(' ');

  // --- content-safety guard (highest precedence) -------------------------
  if (matchesSafety(text)) {
    return {
      bookmarkId: input.id,
      category: null,
      subcategory: null,
      suggestedTag: null,
      confidence: 1,
      engine: 'model',
      needsReview: true,
      quarantined: true,
      quarantineReason: '内容安全策略：命中成人/NSFW 词表，已隔离待人工确认',
      reason: '内容安全隔离',
    };
  }

  // Only meaningful tokens (length ≥ 2) take part: CJK single-character
  // n-grams (e.g. 字, 符) are substrings of many vocabulary words and would
  // create false matches and noise margins on unrelated text.
  const feats = new Set(extractFeatures(text).filter((f) => f.length >= 2));
  if (feats.size === 0) {
    return {
      bookmarkId: input.id,
      category: null,
      subcategory: null,
      suggestedTag: null,
      confidence: 0,
      engine: 'model',
      needsReview: true,
      quarantined: false,
      reason: '无可识别特征，需人工确认',
    };
  }

  // --- Naive-Bayes scoring with IDF reweighting (log-space) -------------
  const scored = model.classes
    .map((c) => {
      let score = c.logPrior;
      for (const f of feats) {
        const ll = c.logLik.get(f);
        const w = c.idf.get(f);
        if (ll !== undefined && w !== undefined) score += ll * w;
      }
      return { c, score };
    })
    .sort((a, b) => b.score - a.score);

  // How many of the bookmark's meaningful features are actually in-vocabulary.
  // Zero means the text shares nothing with the taxonomy → no real signal.
  let matched = 0;
  for (const f of feats) if (model.vocab.has(f)) matched += 1;

  const top = scored[0];
  const second = scored[1] ?? { c: top.c, score: top.score - 10 };
  const margin = top.score - second.score;

  // Confidence is the margin against the runner-up, passed through a sigmoid.
  // Unlike raw softmax-top (which collapses toward 0 across ~30 classes), the
  // margin isolates "how clearly does this beat the next best bucket?" — the
  // quantity a threshold should actually gate on. `temperature` here sharpens
  // or softens that margin.
  const K = 1 / Math.max(0.05, opts.temperature);
  let confidence = 1 / (1 + Math.exp(-K * margin));
  if (matched === 0) confidence *= opts.zeroSignalFactor;
  confidence = clamp01(confidence);

  const belowThreshold = confidence < opts.confidenceThreshold;
  const leaf = leafFor(input, top.c);

  if (belowThreshold) {
    return {
      bookmarkId: input.id,
      category: null,
      subcategory: null,
      suggestedTag: leaf,
      confidence,
      engine: 'model',
      needsReview: true,
      quarantined: false,
      reason: `置信度 ${confidence.toFixed(2)} 低于阈值 ${opts.confidenceThreshold}，需人工确认`,
    };
  }

  return {
    bookmarkId: input.id,
    category: top.c.category,
    subcategory: top.c.subcategory,
    suggestedTag: leaf ?? top.c.subcategory,
    confidence,
    engine: 'model',
    needsReview: false,
    quarantined: false,
    reason: `命中「${top.c.category} > ${top.c.subcategory}」（置信度 ${confidence.toFixed(2)}）`,
  };
}

/* ------------------------------------------------------------------ *
 * Batch classification (stable, deterministic, aggregate stats)
 * ------------------------------------------------------------------ */

const BANDS: Array<[string, number, number]> = [
  ['0.0–0.2', 0, 0.2],
  ['0.2–0.4', 0.2, 0.4],
  ['0.4–0.6', 0.4, 0.6],
  ['0.6–0.8', 0.6, 0.8],
  ['0.8–1.0', 0.8, 1.0001],
];

function bandOf(c: number): string {
  for (const [label, lo, hi] of BANDS) if (c >= lo && c < hi) return label;
  return c < 0.2 ? '0.0–0.2' : '0.8–1.0';
}

/**
 * Classifies a batch of bookmarks in **input order** (stable, predictable) and
 * returns per-item predictions plus aggregate statistics. Deterministic: the
 * same array → the same `predictions` array and the same aggregates, so a rerun
 * over an unchanged library reproduces identical results (idempotent by design).
 *
 * The model is built once and shared across all items, so cost scales linearly
 * with batch size — safe for the thousands-of-bookmarks case.
 */
export function classifyBatch(
  inputs: BookmarkClassInput[],
  options?: Partial<ClassifyOptions>,
): BatchClassifyResult {
  const model = buildClassificationModel();
  const opts: ClassifyOptions = { ...DEFAULT_CLASSIFY_OPTIONS, ...options };

  const predictions = inputs.map((b) => classifyBookmark(model, b, opts));

  let classified = 0;
  let needsReview = 0;
  let quarantined = 0;
  let confSum = 0;
  const hist = new Map<string, number>(BANDS.map(([label]) => [label, 0]));
  const byCategory: Record<string, number> = {};

  for (const p of predictions) {
    if (p.quarantined) quarantined += 1;
    if (p.needsReview) needsReview += 1;
    if (p.category && !p.needsReview) {
      classified += 1;
      confSum += p.confidence;
      byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
    }
    hist.set(bandOf(p.confidence), (hist.get(bandOf(p.confidence)) ?? 0) + 1);
  }

  return {
    total: inputs.length,
    classified,
    needsReview,
    quarantined,
    avgConfidence: classified > 0 ? confSum / classified : 0,
    confidenceHistogram: BANDS.map(([label]) => ({ band: label, count: hist.get(label) ?? 0 })),
    byCategory,
    predictions,
    engine: 'model',
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
