/**
 * Three-level classification taxonomy for *bookmarks* (distinct from the tag
 * hierarchy in `grouping.ts`, which organises *tags*).
 *
 * This is the knowledge base the ML classifier (`classifier.ts`) learns from.
 * Each leaf is a **二级子类** carrying a list of representative **特征词**
 * (features). The **一级大类** is the grouping above it. The **三级具体标签**
 * is not enumerated here — it is the bookmark's own tag/title, recovered at
 * classification time.
 *
 * The taxonomy is intentionally *orthogonal* to `CATEGORY_RULES`: that module
 * maps an existing tag name to a bucket; this one maps the *content* of a
 * bookmark (title + url + description) to a bucket. Keeping them separate lets
 * the two engines improve independently.
 *
 * ## Why a feature list and not just rules
 *
 * The classifier trains a Naive-Bayes model over these features. That buys two
 * things a flat `includes()` rule cannot:
 *   1. **Calibrated confidence.** A bookmark matching three React features is
 *      more certain than one matching a single weak hint, and the model reports
 *      that as a 0–1 probability we can threshold on.
 *   2. **Graceful ambiguity.** When no feature matches, every class scores near
 *      its prior and the top probability is low — so the item falls into the
 *      "needs review" bucket instead of being force-filed somewhere wrong.
 *
 * Feature lists are seed priors; the model can be retrained later from the
 * user's accept/reject feedback without touching this file's shape.
 */

/** 二级子类：一组代表该子类内容的特征词（小写；中文词会被切成字符 n-gram 匹配）。 */
export interface MlSubcategory {
  name: string;
  features: string[];
}

/** 一级大类 + 其下的二级子类。 */
export interface MlCategory {
  name: string;
  subcategories: MlSubcategory[];
}

/**
 * The classification taxonomy. Order is irrelevant to the model (it is
 * probabilistic), but kept stable so diffs stay readable.
 */
export const CLASSIFICATION_TAXONOMY: MlCategory[] = [
  {
    name: '学习资料',
    subcategories: [
      { name: '教程与课程', features: ['教程', '课程', '培训', 'guide', 'tutorial', 'getting started', '入门', '公开课'] },
      { name: '文档参考', features: ['文档', '参考', '手册', 'reference', 'docs', 'documentation', 'api', 'spec', 'rfc'] },
      { name: '学术论文', features: ['论文', 'paper', 'arxiv', '学术', 'research', 'journal', '学位'] },
      { name: '求职面试', features: ['面试', '八股', '题库', '考点', '简历', 'interview', '招聘'] },
      { name: '认证考试', features: ['证书', '认证', 'certification', '考证', '考试'] },
    ],
  },
  {
    name: '人工智能',
    subcategories: [
      { name: '大模型', features: ['大模型', 'llm', 'chatgpt', 'claude', 'openai', 'gemini', 'gpt', '生成式', 'prompt', '提示词'] },
      { name: '机器学习', features: ['机器学习', '深度学习', '神经网络', '强化学习', 'transformer', 'ml', 'dl', 'training', '训练'] },
      { name: '计算机视觉', features: ['计算机视觉', 'cv', '图像', 'diffusion', '扩散模型', '多模态', 'vision', '检测', '识别'] },
      { name: '自然语言处理', features: ['nlp', '自然语言处理', '语音', 'language model', 'embedding', '向量'] },
    ],
  },
  {
    name: '数据分析',
    subcategories: [
      { name: '数据分析', features: ['数据分析', '数据科学', '统计', '挖掘', 'analytics', 'pandas', 'numpy', 'etl'] },
      { name: '数据可视化', features: ['可视化', '图表', 'bi', 'tableau', 'powerbi', 'dashboard', '看板', 'echarts'] },
      { name: '分析工具', features: ['excel', 'spss', 'sql', 'python', 'notebook', 'jupyter'] },
    ],
  },
  {
    name: '运维与云',
    subcategories: [
      { name: 'DevOps', features: ['devops', 'ci', 'cd', 'cicd', '监控', '日志', 'observability', 'prometheus', 'grafana'] },
      { name: '容器编排', features: ['docker', 'kubernetes', 'k8s', '容器', '集群', 'helm', 'compose'] },
      { name: '云服务', features: ['云', 'aws', 'azure', 'gcp', '阿里云', '腾讯云', '华为云', 'cdn', 'serverless', 'lambda'] },
      { name: '服务器与主机', features: ['服务器', '主机', 'vps', 'nginx', '网关', 'proxy', 'linux', '运维'] },
    ],
  },
  {
    name: '营销与运营',
    subcategories: [
      { name: 'SEO/SEM', features: ['seo', 'sem', '搜索优化', '关键词', '投放', '广告'] },
      { name: '增长黑客', features: ['增长', '推广', '转化', '用户增长', 'growth', '留存', '漏斗'] },
      { name: '社媒运营', features: ['社媒', '社交媒体', '社群', '新媒体', '内容运营', '公众号', '小红书'] },
    ],
  },
  {
    name: '技术社区',
    subcategories: [
      { name: '开源社区', features: ['github', '开源', 'gitlab', '开源社区', 'repo', 'repository'] },
      { name: '开发者论坛', features: ['社区', '论坛', 'stackoverflow', 'reddit', 'v2ex', '掘金', '知乎', 'csdn', 'segmentfault', 'hackernews'] },
    ],
  },
  {
    name: '开发技术',
    subcategories: [
      { name: '前端开发', features: ['前端', 'react', 'vue', 'css', 'javascript', 'typescript', 'flutter', 'web', 'html', 'svelte'] },
      { name: '后端开发', features: ['后端', 'api', '微服务', 'nodejs', 'node', 'go', 'golang', 'java', 'rust', 'python', 'php'] },
      { name: '数据与存储', features: ['数据库', 'sql', 'postgres', 'mysql', 'redis', 'mongodb', 'sqlite', 'orm'] },
      { name: '算法', features: ['算法', '数据结构', 'leetcode', '动态规划', '图论'] },
      { name: '安全', features: ['安全', '漏洞', 'cve', 'security', '加密', '渗透', 'auth'] },
      { name: '版本控制', features: ['git', '版本控制', 'branch', 'merge'] },
    ],
  },
  {
    name: '设计与创意',
    subcategories: [
      { name: '界面与交互', features: ['ui', 'ux', '交互', '体验', '原型', 'wireframe', '设计系统'] },
      { name: '视觉与品牌', features: ['视觉', '配色', '品牌', '灵感', '平面', '插画', '字体', '排版', '动效'] },
      { name: '设计工具', features: ['figma', 'sketch', 'photoshop', 'blender', '3d', '设计工具'] },
      { name: '摄影与图像', features: ['摄影', '图片', '壁纸', '海报', '相册'] },
    ],
  },
  {
    name: '在线工具',
    subcategories: [
      { name: '效率办公', features: ['效率', 'productivity', '快捷键', '笔记', 'todo', '日历', '协作'] },
      { name: '浏览器插件', features: ['插件', '扩展', 'extension', 'browser', 'chrome'] },
      { name: '实用工具', features: ['转换器', '生成器', '计算器', '压缩', '解析', '检测', '工具', 'online'] },
    ],
  },
  {
    name: '博客',
    subcategories: [{ name: '博客', features: ['博客', 'blog', '专栏', '个人博客', '技术博客'] }],
  },
  {
    name: '阅读与资讯',
    subcategories: [
      { name: '新闻资讯', features: ['新闻', '资讯', '科技新闻', '时事', 'news', '热点'] },
      { name: 'RSS订阅', features: ['rss', '订阅', 'feed', '聚合'] },
      { name: '阅读', features: ['杂志', '报纸', '阅读', '读书', 'kindle'] },
      { name: '财经', features: ['财经', '股票', '基金', '投资', 'finance', '经济'] },
    ],
  },
  {
    name: '内容',
    subcategories: [
      { name: '视频', features: ['视频', 'video', 'bilibili', 'youtube', '影视', '短片'] },
      { name: '播客', features: ['播客', 'podcast', '电台'] },
      { name: '阅读与创作', features: ['电子书', '读书', '写作', '自媒体', '文案', '公众号'] },
    ],
  },
  {
    name: '娱乐与生活',
    subcategories: [
      { name: '娱乐休闲', features: ['电影', '音乐', '游戏', '动漫', '娱乐', '休闲', '番剧'] },
      { name: '美食', features: ['美食', '菜谱', '咖啡', '烹饪', '餐厅'] },
      { name: '旅行', features: ['旅行', '旅游', '攻略', '酒店', '机票'] },
      { name: '健康', features: ['健身', '健康', '运动', '跑步', '瑜伽'] },
      { name: '生活方式', features: ['家居', '园艺', '亲子', '宠物', '穿搭', '美妆', '生活'] },
    ],
  },
];

/** Stable flattened list of (category, subcategory) pairs — the model's classes. */
export interface ClassEntry {
  category: string;
  subcategory: string;
}

export function flattenTaxonomy(): ClassEntry[] {
  const out: ClassEntry[] = [];
  for (const cat of CLASSIFICATION_TAXONOMY) {
    for (const sub of cat.subcategories) out.push({ category: cat.name, subcategory: sub.name });
  }
  return out;
}

/**
 * Content-safety lexicon.
 *
 * Used to quarantine explicit / adult content *out* of the productivity
 * hierarchy. Anything matching is returned as `quarantined: true` and never
 * filed under a category — it is held for human review. This is a moderation
 * guard, not a classification target.
 */
export const SAFETY_LEXICON: string[] = [
  // Chinese adult / NSFW shorthand that commonly appears in bookmark titles.
  '成人', '色情', '黄片', '伦理', '草榴', '91', 'porn', 'porno', 'xxx', 'sex', 'adult', 'nsfw',
  'av', 'tube', 'onlyfans', 'cams', 'escort', '约炮', '裸聊', '性爱', '激情',
];

/** Normalises a safety term for substring matching (lowercase, trimmed). */
export function normalizeSafetyTerm(term: string): string {
  return term.trim().toLowerCase();
}

/** True when `text` contains any safety term. Substring match, case-insensitive. */
export function matchesSafety(text: string): boolean {
  const lower = text.toLowerCase();
  return SAFETY_LEXICON.some((t) => lower.includes(normalizeSafetyTerm(t)));
}
