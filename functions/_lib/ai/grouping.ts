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
 * Each top-level family mirrors the tagging vocabulary so AI suggestions and
 * manual tags land on a consistent taxonomy.
 */
const CATEGORY_RULES: CategoryRule[] = [
  // Specific domains first: a tag like "Python 官方文档" should land in
  // 学习 > 文档参考, not be swallowed by the broader 技术 bucket. Order matters
  // — the first rule whose key matches wins — so narrow intent categories come
  // before the catch-all buckets.
  {
    category: '学习资料',
    keys: ['教程', '课程', '学习', '学习资料', '文档', '参考', '指南', '手册', '面试', '证书', 'book', 'paper', '论文', 'manual', 'handbook', 'getting started', '题库', '考点'],
    subcategories: [
      { keys: ['教程', '课程', '指南', 'guide', 'getting started'], name: '教程与课程' },
      { keys: ['文档', '参考', '手册', 'reference', 'manual', 'handbook'], name: '文档参考' },
      { keys: ['论文', 'paper', '学术', 'arxiv'], name: '学术论文' },
      { keys: ['面试', '八股', '题库', '考点'], name: '求职面试' },
      { keys: ['证书', '认证'], name: '认证考试' },
    ],
  },
  {
    category: '人工智能',
    keys: ['人工智能', 'ai', '机器学习', '大模型', 'llm', '深度学习', '神经网络', 'nlp', '自然语言处理', '计算机视觉', 'cv', '强化学习', '生成式', 'chatgpt', 'claude', 'openai', 'huggingface', 'transformer', '扩散模型', '多模态'],
    subcategories: [
      { keys: ['大模型', 'llm', 'chatgpt', 'claude', 'openai', '生成式'], name: '大模型' },
      { keys: ['机器学习', '深度学习', '神经网络', '强化学习', 'transformer'], name: '机器学习' },
      { keys: ['计算机视觉', 'cv', '图像识别', '扩散模型', '多模态'], name: '计算机视觉' },
      { keys: ['nlp', '自然语言处理'], name: '自然语言处理' },
    ],
  },
  {
    category: '数据分析',
    keys: ['数据分析', '数据科学', '数据可视化', '可视化', '图表', 'bi', 'tableau', 'powerbi', 'excel', '统计', 'spss', 'pandas', 'numpy', '数据挖掘', '大数据'],
    subcategories: [
      { keys: ['数据分析', '数据科学', '统计', '数据挖掘', '大数据'], name: '数据分析' },
      { keys: ['数据可视化', '可视化', '图表', 'bi', 'tableau', 'powerbi'], name: '数据可视化' },
      { keys: ['excel', 'pandas', 'numpy', 'python'], name: '分析工具' },
    ],
  },
  {
    category: '运维与云',
    keys: ['运维', 'devops', '云', '云计算', 'docker', 'kubernetes', 'k8s', 'linux', '服务器', '主机', 'vps', 'nginx', 'ci/cd', 'cicd', '监控', '日志', '备份', '集群', '容器', '网关', 'cdn'],
    subcategories: [
      { keys: ['devops', 'ci/cd', 'cicd', '监控', '日志'], name: 'DevOps' },
      { keys: ['docker', 'kubernetes', 'k8s', '容器', '集群'], name: '容器编排' },
      { keys: ['云', '云计算', 'aws', 'azure', 'gcp', '阿里云', '腾讯云', '华为云', 'cdn'], name: '云服务' },
      { keys: ['服务器', '主机', 'vps', 'nginx', '网关'], name: '服务器与主机' },
      { keys: ['linux'], name: 'Linux' },
    ],
  },
  {
    category: '营销与运营',
    keys: ['营销', '运营', 'seo', 'sem', '增长', '推广', '广告', '社媒', '社交媒体', '内容运营', '产品运营', '用户增长', '投放', '转化', '社群', '新媒体'],
    subcategories: [
      { keys: ['seo', 'sem', '搜索优化'], name: 'SEO/SEM' },
      { keys: ['增长', '推广', '广告', '投放', '转化', '用户增长'], name: '增长黑客' },
      { keys: ['社媒', '社交媒体', '内容运营', '社群', '新媒体'], name: '社媒运营' },
    ],
  },
  {
    category: '技术社区',
    keys: ['社区', '论坛', 'github', 'stackoverflow', 'reddit', 'hackernews', 'v2ex', '掘金', '知乎', 'csdn', 'segmentfault', '开发者社区', '技术社区', '开源社区'],
    subcategories: [
      { keys: ['github', '开源社区'], name: '开源社区' },
      { keys: ['stackoverflow', 'reddit', 'hackernews', 'v2ex', '掘金', '知乎', 'csdn', 'segmentfault', '论坛', '社区', '开发者社区', '技术社区'], name: '开发者论坛' },
    ],
  },
  {
    category: '开发技术',
    keys: ['前端', '后端', 'javascript', 'typescript', 'react', 'vue', 'css', '算法', '数据库', 'sql', 'postgres', 'mysql', '安全', '开源', '代码', '编程', 'api', '软件', 'python', 'go', 'golang', 'rust', 'java', 'c++', 'c#', 'php', 'ruby', 'swift', 'kotlin', 'flutter', 'nodejs', 'node.js', 'web', 'http', 'git'],
    subcategories: [
      { keys: ['前端', 'react', 'vue', 'css', 'javascript', 'typescript', 'flutter', 'web'], name: '前端开发' },
      { keys: ['后端', 'api', '微服务', 'nodejs', 'node.js'], name: '后端开发' },
      { keys: ['数据库', 'sql', 'postgres', 'mysql'], name: '数据与存储' },
      { keys: ['算法', '数据结构'], name: '算法' },
      { keys: ['安全', '漏洞', 'cve'], name: '安全' },
      { keys: ['开源'], name: '开源项目' },
      { keys: ['git'], name: '版本控制' },
    ],
  },
  {
    category: '设计与创意',
    keys: ['设计', 'ui', 'ux', '交互', '视觉', '配色', 'figma', 'sketch', '品牌', '创意', '灵感', '平面设计', '插画', '摄影', '字体', '排版', '动效', '3d', 'blender', 'ps', 'photoshop'],
    subcategories: [
      { keys: ['ui', '交互', 'ux'], name: '界面与交互' },
      { keys: ['视觉', '配色', '品牌', '灵感', '平面设计', '插画', '字体', '排版', '动效'], name: '视觉与品牌' },
      { keys: ['figma', 'sketch', 'ps', 'photoshop', 'blender', '3d'], name: '设计工具' },
      { keys: ['摄影', '图片', '壁纸'], name: '摄影与图像' },
    ],
  },
  {
    category: '在线工具',
    keys: ['工具', '在线工具', '在线', '效率', '生产力', 'productivity', '快捷键', 'chrom', 'browser', '插件', '扩展', '软件', '转换器', '生成器', '计算器', '压缩', '解析', '检测'],
    subcategories: [
      { keys: ['效率', 'productivity', '快捷键'], name: '效率办公' },
      { keys: ['插件', '扩展', 'browser'], name: '浏览器插件' },
      { keys: ['转换器', '生成器', '计算器', '压缩', '解析', '检测'], name: '实用工具' },
      { keys: ['在线', '在线工具', '工具'], name: '在线服务' },
    ],
  },
  {
    category: '博客',
    keys: ['博客', 'blog', '个人博客', '技术博客', '专栏'],
  },
  {
    category: '阅读与资讯',
    keys: ['新闻', '资讯', '阅读', 'rss', '订阅', '杂志', '报纸', '财经', '科技新闻', '时事'],
    subcategories: [
      { keys: ['新闻', '资讯', '科技新闻', '时事'], name: '新闻资讯' },
      { keys: ['rss', '订阅'], name: 'RSS订阅' },
      { keys: ['杂志', '报纸', '阅读'], name: '阅读' },
      { keys: ['财经'], name: '财经' },
    ],
  },
  {
    category: '内容',
    keys: ['视频', '播客', '电子书', '读书', '写作', '自媒体', '文案'],
    subcategories: [
      { keys: ['视频'], name: '视频' },
      { keys: ['播客'], name: '播客' },
      { keys: ['电子书', '读书', '写作', '自媒体', '文案'], name: '阅读与创作' },
    ],
  },
  {
    category: '娱乐与生活',
    keys: ['美食', '旅行', '菜谱', '健身', '健康', '家居', '亲子', '宠物', '园艺', '咖啡', '生活', '电影', '音乐', '游戏', '动漫', '娱乐', '休闲', '运动', '穿搭', '美妆'],
    subcategories: [
      { keys: ['电影', '音乐', '游戏', '动漫', '娱乐', '休闲'], name: '娱乐休闲' },
      { keys: ['美食', '菜谱', '咖啡'], name: '美食' },
      { keys: ['旅行', '旅游'], name: '旅行' },
      { keys: ['健身', '健康', '运动'], name: '健康' },
      { keys: ['家居', '园艺', '亲子', '宠物', '穿搭', '美妆'], name: '生活方式' },
    ],
  },
];

/**
 * Precompiled word-boundary matchers, one per rule key (A-5, round-2 audit).
 * The old `keyHit` built a fresh RegExp for every (tag × key) pair — at
 * thousand-tag scale that is ~200k compilations per grouping pass. Keys are a
 * fixed module-level table, so compiling once at load is free.
 */
const KEY_MATCHERS = new Map<string, { ascii: boolean; exact: string; re?: RegExp }>();

function matcherFor(key: string): { ascii: boolean; exact: string; re?: RegExp } {
  let m = KEY_MATCHERS.get(key);
  if (!m) {
    const needle = key.toLowerCase();
    const ascii = /^[\x20-\x7e]+$/.test(needle);
    m = {
      ascii,
      exact: needle,
      // CJK keys can only match as substrings — no regex needed.
      re: ascii
        ? new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`)
        : undefined,
    };
    KEY_MATCHERS.set(key, m);
  }
  return m;
}

/** Word-boundary test on the normalised tag name: is this key present? */
function keyHit(name: string, key: string): boolean {
  const m = matcherFor(key);
  const lower = name.toLowerCase();
  if (lower === m.exact) return true; // exact match always hits
  if (!m.ascii) return lower.includes(m.exact);
  return m.re!.test(lower);
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
