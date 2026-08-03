/**
 * Automatic three-level tagging hierarchy ("自动建组").
 *
 * Turns a flat tag list into a
 *
 *     一级分类 (top-level category)
 *       └─ 二级子分类 (sub-category)
 *            └─ 三级标签 (the original/leaf tags)
 *
 * tree by assigning every tag a `parent_id`. The input is the user's existing
 * tags alongside what AI tagging just proposed; this module decides their
 * nesting. It is deliberately pure (no DB, no network) so the assignment
 * logic is unit-testable and the write step lives in the API layer.
 *
 * Design principles:
 *  - **Conservative by default.** A tag that matches no rule keeps its current
 *    parent (won't be force-relocated into "其他"). Assignment only happens
 *    when a confident category/sub-category is known.
 *  - **No duplicate categories.** Category names are reused when they already
 *    exist as top-level tags; a new one is only created when absent.
 *  - **Three levels max.** A tag already nested two deep is left untouched
 *    rather than pushed deeper.
 *  - **Deterministic.** Same input → same output, so re-running is idempotent
 *    and safe.
 */

/** Input: a tag exactly as the client sees it (no parent -> top-level). */
export interface FlatTag {
  id: string;
  name: string;
  count: number;
  parentId: string | null;
}

/** One hierarchy assignment: `tagId` becomes the child of `parentId`. */
export interface TagRelocation {
  tagId: string;
  parentId: string | null;
  /** Human-readable "一级 > 二级" for the review list. */
  path: [string, string] | [string];
}

export interface CategoryRule {
  /** Matched as a substring/normalised word against the tag name. */
  keys: string[];
  /** The canonical 一级 category name. */
  category: string;
  /** Optional 二级 buckets within the category: bucketKey -> bucket name. */
  subcategories?: Array<{ keys: string[]; name: string }>;
}

/**
 * Category rules. Order matters: the first rule whose key hits wins, so put
 * specific buckets before the generic category fallback (the default category
 * rule uses `category: '<rule.category>'` with no keys — it always matches).
 * Each top-level family mirrors the heuristic vocabulary so AI suggestions and
 * manual tags land on a consistent taxonomy.
 */
const CATEGORY_RULES: CategoryRule[] = [
  // Learning/documentation first: a "Python 官方文档" is more usefully filed
  // under 学习>文档参考 than swallowed by the broad 技术 bucket. Order matters —
  // the first rule whose key matches wins — so specific intent categories come
  // first and the dev catch-all (技术) is left last.
  {
    category: '学习',
    keys: ['教程', '课程', '学习', '文档', '参考', '指南', '面试', '证书', 'book', 'paper', '论文', 'manual', 'handbook', 'getting started'],
    subcategories: [
      { keys: ['教程', '课程', '指南', 'guide', 'getting started'], name: '教程与课程' },
      { keys: ['文档', '参考', 'reference', 'manual', 'handbook'], name: '文档参考' },
      { keys: ['论文', 'paper', '学术', 'arxiv'], name: '学术论文' },
      { keys: ['面试', '八股'], name: '求职面试' },
    ],
  },
  {
    category: '技术',
    keys: ['前端', '后端', 'javascript', 'typescript', 'react', 'vue', 'css', '算法', '数据库', 'sql', 'postgres', 'mysql', 'devops', '运维', '安全', '开源', '代码', '编程', 'api', '软件', '云', 'docker', 'kubernetes', '人工智能', '机器学习', '大模型', 'python', 'go', 'rust', 'java', 'linux'],
    subcategories: [
      { keys: ['前端', 'react', 'vue', 'css', 'javascript'], name: '前端开发' },
      { keys: ['后端', 'api', '微服务'], name: '后端开发' },
      { keys: ['数据库', 'sql', 'postgres', 'mysql'], name: '数据与存储' },
      { keys: ['devops', '运维', 'docker', 'kubernetes', '云', 'ci'], name: '运维与云' },
      { keys: ['人工智能', '机器学习', '大模型', 'llm', '深度学习', '神经网络'], name: '人工智能' },
      { keys: ['算法', '数据结构'], name: '算法' },
      { keys: ['安全', '漏洞', 'cve'], name: '安全' },
      { keys: ['开源'], name: '开源项目' },
    ],
  },
  {
    category: '设计',
    keys: ['设计', 'ui', 'ux', '交互', '视觉', '配色', 'figma', 'sketch', '品牌'],
    subcategories: [
      { keys: ['ui', '交互', 'ux'], name: '界面设计' },
      { keys: ['视觉', '配色', '品牌', '灵感'], name: '视觉与品牌' },
      { keys: ['figma', 'sketch', '工具'], name: '设计工具' },
    ],
  },
  {
    category: '工具',
    keys: ['工具', '效率', '生产力', 'productivity', '快捷键', 'chrom', 'browser', '插件', '软件'],
    subcategories: [
      { keys: ['效率', 'productivity'], name: '效率办公' },
      { keys: ['插件', '扩展', 'browser'], name: '浏览器插件' },
    ],
  },
  {
    category: '内容',
    keys: ['博客', '视频', '新闻', '资讯', '社区', '播客', '电子书', '读书', '写作'],
    subcategories: [
      { keys: ['博客'], name: '博客文章' },
      { keys: ['视频'], name: '视频' },
      { keys: ['资讯', '新闻'], name: '资讯' },
    ],
  },
  {
    category: '生活',
    keys: ['美食', '旅行', '菜谱', '健身', '健康', '家居', '亲子', '宠物', '园艺', '咖啡'],
  },
];

/** Word-boundary test on the normalised tag name: is this key present? */
function keyHit(name: string, key: string): boolean {
  const lower = name.toLowerCase();
  const needle = key.toLowerCase();
  if (name === needle) return true; // exact match always hits
  // CJK keys can only match as substrings.
  if (!/^[\x20-\x7e]+$/.test(needle)) return lower.includes(needle);
  return new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(lower);
}

/** Matches a tag against every rule; returns [category, subcategory] or null. */
export function classifyTag(name: string): [string, string | null] | null {
  for (const rule of CATEGORY_RULES) {
    const inCategory = rule.keys.some((k) => keyHit(name, k));
    if (!inCategory) continue;

    if (rule.subcategories) {
      for (const sub of rule.subcategories) {
        if (sub.keys.some((k) => keyHit(name, k))) {
          return [rule.category, sub.name];
        }
      }
    }
    // Matching the top-level category but no sub-key → attach to the category
    // itself, or null sub meaning "category is the only bucket".
    return [rule.category, null];
  }
  return null;
}

export interface GroupResult {
  /** tagId → the 1-or-2 level path it should live under. */
  assignments: Array<{ tagId: string; category: string; subcategory: string | null }>;
  /** Distinct top-level category names to ensure exist. */
  categories: string[];
  /** Distinct (category, subcategory) pairs to ensure exist. */
  subcategories: Array<{ category: string; sub: string }>;
  /** Human-readable summary, "一级 > 二级", for UI. */
  summary: string[];
  /** Tags left untouched (unclassified or already deep enough). */
  untouchedCount: number;
}

const MAX_DEPTH = 2; // 0 = top, 1 = subcategory, 2 = leaf; never nest deeper.

/**
 * Assigns every tag a 1-or-2-level path to form a 3-level tree. Category /
 * sub-category names are returned (not ids) so the API layer decides
 * create-or-reuse; this function stays pure and DB-free.
 */
export function computeTagHierarchy(tags: FlatTag[]): GroupResult {
  const byId = new Map(tags.map((t) => [t.id, t]));
  const assignments: Array<{ tagId: string; category: string; subcategory: string | null }> = [];
  const categories = new Set<string>();
  const subcategories = new Set<string>();
  const summary = new Set<string>();
  let untouchedCount = 0;

  /** Depth of a tag within the tree (walking parentId upward). */
  const depthOf = (id: string | null, guard = 0): number => {
    if (!id || guard > 5) return 0;
    const parent = byId.get(id);
    if (!parent) return 1;
    return 1 + depthOf(parent.parentId, guard + 1);
  };

  for (const tag of tags) {
    // Skip tags already nested two levels deep — never push deeper than 三级.
    if (depthOf(tag.parentId) >= MAX_DEPTH) {
      untouchedCount += 1;
      continue;
    }

    const classified = classifyTag(tag.name);
    if (!classified) {
      // Conservative: don't force unclassified tags anywhere.
      untouchedCount += 1;
      continue;
    }

    const [category, sub] = classified;
    categories.add(category);
    if (sub) {
      subcategories.add(`${category}\u0000${sub}`);
      assignments.push({ tagId: tag.id, category, subcategory: sub });
      summary.add(`${category} > ${sub}`);
    } else {
      assignments.push({ tagId: tag.id, category, subcategory: null });
      summary.add(category);
    }
  }

  return {
    assignments,
    categories: [...categories].sort(),
    subcategories: [...subcategories]
      .map((k) => k.split('\u0000'))
      .map(([category, sub]) => ({ category, sub }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.sub.localeCompare(b.sub)),
    summary: [...summary].sort(),
    untouchedCount,
  };
}
