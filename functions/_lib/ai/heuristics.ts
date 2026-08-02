import type { CandidateSource, EnrichInput } from './types';

/**
 * Local heuristic tagging — deterministic, free, and always available.
 *
 * Two reasons this exists rather than leaning entirely on the model:
 *
 *  1. **The feature has to work on day one.** Requiring an API key before a
 *     bookmark manager can organise anything is how a headline feature ends up
 *     never being tried. Heuristics mean a brand-new user hits "整理" and gets
 *     a usable result immediately; configuring a model upgrades that result.
 *
 *  2. **It cross-checks the model.** When an independent local signal and the
 *     model land on the same tag, that agreement is real evidence, and the
 *     pipeline raises confidence accordingly (see `resolveCandidates`). A tag
 *     only the model proposed stays lower and gets reviewed. This is what lets
 *     auto-apply be safe enough to switch on.
 *
 * Every rule is a plain data entry so extending coverage is a one-line change
 * with no logic to re-reason about.
 */

interface DomainRule {
  /** Matched against the hostname as a suffix, so subdomains are covered. */
  host: string;
  tags: string[];
  confidence: number;
}

/**
 * Host to topic. Ordered loosely by specificity; all matches contribute, so a
 * docs subdomain of a framework site can pick up both "文档" and the framework.
 */
const DOMAIN_RULES: DomainRule[] = [
  { host: 'github.com', tags: ['开源', '代码'], confidence: 0.78 },
  { host: 'gitlab.com', tags: ['开源', '代码'], confidence: 0.75 },
  { host: 'gitee.com', tags: ['开源', '代码'], confidence: 0.75 },
  { host: 'stackoverflow.com', tags: ['编程', '问答'], confidence: 0.78 },
  { host: 'npmjs.com', tags: ['前端', '工具'], confidence: 0.72 },
  { host: 'pypi.org', tags: ['Python', '工具'], confidence: 0.72 },
  { host: 'crates.io', tags: ['Rust', '工具'], confidence: 0.72 },
  { host: 'developer.mozilla.org', tags: ['前端', '文档'], confidence: 0.8 },
  { host: 'react.dev', tags: ['前端', '文档'], confidence: 0.8 },
  { host: 'vuejs.org', tags: ['前端', '文档'], confidence: 0.8 },
  { host: 'svelte.dev', tags: ['前端', '文档'], confidence: 0.8 },
  { host: 'tailwindcss.com', tags: ['前端', '文档'], confidence: 0.78 },
  { host: 'docs.python.org', tags: ['Python', '文档'], confidence: 0.8 },
  { host: 'go.dev', tags: ['Go', '文档'], confidence: 0.78 },
  { host: 'rust-lang.org', tags: ['Rust', '文档'], confidence: 0.78 },
  { host: 'kubernetes.io', tags: ['运维', '文档'], confidence: 0.76 },
  { host: 'docker.com', tags: ['运维', '工具'], confidence: 0.74 },
  { host: 'cloudflare.com', tags: ['云服务'], confidence: 0.72 },
  { host: 'aws.amazon.com', tags: ['云服务'], confidence: 0.75 },
  { host: 'cloud.google.com', tags: ['云服务'], confidence: 0.75 },
  { host: 'aliyun.com', tags: ['云服务'], confidence: 0.75 },
  { host: 'tencentcloud.com', tags: ['云服务'], confidence: 0.75 },
  { host: 'arxiv.org', tags: ['论文', '学术'], confidence: 0.85 },
  { host: 'huggingface.co', tags: ['机器学习', '开源'], confidence: 0.8 },
  { host: 'openai.com', tags: ['人工智能'], confidence: 0.78 },
  { host: 'anthropic.com', tags: ['人工智能'], confidence: 0.78 },
  { host: 'paperswithcode.com', tags: ['论文', '机器学习'], confidence: 0.82 },
  { host: 'kaggle.com', tags: ['机器学习', '数据'], confidence: 0.78 },
  { host: 'medium.com', tags: ['博客'], confidence: 0.68 },
  { host: 'substack.com', tags: ['博客'], confidence: 0.68 },
  { host: 'juejin.cn', tags: ['技术', '博客'], confidence: 0.72 },
  { host: 'segmentfault.com', tags: ['技术', '问答'], confidence: 0.72 },
  { host: 'cnblogs.com', tags: ['技术', '博客'], confidence: 0.72 },
  { host: 'csdn.net', tags: ['技术', '博客'], confidence: 0.7 },
  { host: 'infoq.cn', tags: ['技术', '资讯'], confidence: 0.72 },
  { host: 'zhihu.com', tags: ['问答'], confidence: 0.65 },
  { host: 'news.ycombinator.com', tags: ['资讯', '技术'], confidence: 0.75 },
  { host: 'reddit.com', tags: ['社区'], confidence: 0.65 },
  { host: 'v2ex.com', tags: ['社区', '技术'], confidence: 0.72 },
  { host: 'youtube.com', tags: ['视频'], confidence: 0.78 },
  { host: 'bilibili.com', tags: ['视频'], confidence: 0.78 },
  { host: 'figma.com', tags: ['设计', '工具'], confidence: 0.78 },
  { host: 'dribbble.com', tags: ['设计', '灵感'], confidence: 0.8 },
  { host: 'behance.net', tags: ['设计', '灵感'], confidence: 0.8 },
  { host: 'unsplash.com', tags: ['设计', '素材'], confidence: 0.78 },
  { host: 'notion.so', tags: ['效率', '工具'], confidence: 0.7 },
  { host: 'producthunt.com', tags: ['产品'], confidence: 0.76 },
  { host: 'zhipin.com', tags: ['求职'], confidence: 0.8 },
  { host: 'lagou.com', tags: ['求职'], confidence: 0.8 },
  { host: 'linkedin.com', tags: ['职业'], confidence: 0.7 },
  { host: 'coursera.org', tags: ['课程', '学习'], confidence: 0.8 },
  { host: 'udemy.com', tags: ['课程', '学习'], confidence: 0.8 },
  { host: 'leetcode.cn', tags: ['算法', '面试'], confidence: 0.82 },
  { host: 'leetcode.com', tags: ['算法', '面试'], confidence: 0.82 },
];

/** URL path fragments that reveal the kind of page regardless of the site. */
const PATH_RULES: Array<{ match: string; tags: string[]; confidence: number }> = [
  { match: '/docs', tags: ['文档'], confidence: 0.68 },
  { match: '/documentation', tags: ['文档'], confidence: 0.68 },
  { match: '/guide', tags: ['教程'], confidence: 0.65 },
  { match: '/tutorial', tags: ['教程'], confidence: 0.7 },
  { match: '/blog', tags: ['博客'], confidence: 0.68 },
  { match: '/news', tags: ['资讯'], confidence: 0.65 },
  { match: '/pricing', tags: ['产品'], confidence: 0.6 },
  { match: '/api', tags: ['文档'], confidence: 0.6 },
  { match: '/release', tags: ['更新日志'], confidence: 0.6 },
  { match: '/changelog', tags: ['更新日志'], confidence: 0.68 },
  { match: '/awesome', tags: ['资源合集'], confidence: 0.7 },
];

/**
 * Keyword to tag, applied to title and description.
 *
 * ASCII keywords match on word boundaries so "go" does not fire on "google";
 * CJK keywords match as substrings because Chinese has no word delimiters.
 */
const KEYWORD_RULES: Array<{ words: string[]; tags: string[]; confidence: number }> = [
  { words: ['教程', 'tutorial', '入门', '上手', 'getting started'], tags: ['教程'], confidence: 0.62 },
  { words: ['文档', 'docs', 'reference', 'handbook'], tags: ['文档'], confidence: 0.6 },
  { words: ['面试', 'interview', '八股'], tags: ['面试'], confidence: 0.68 },
  { words: ['简历', 'resume', 'cv'], tags: ['求职'], confidence: 0.65 },
  { words: ['算法', 'algorithm', '数据结构'], tags: ['算法'], confidence: 0.65 },
  { words: ['开源', 'open source', 'oss'], tags: ['开源'], confidence: 0.62 },
  { words: ['大模型', 'llm', 'gpt', 'transformer', '深度学习'], tags: ['大模型'], confidence: 0.7 },
  { words: ['机器学习', 'machine learning', '神经网络'], tags: ['机器学习'], confidence: 0.68 },
  { words: ['设计', 'design', 'ui', 'ux', '配色'], tags: ['设计'], confidence: 0.6 },
  { words: ['前端', 'frontend', 'css', 'react', 'vue'], tags: ['前端'], confidence: 0.62 },
  { words: ['后端', 'backend', '微服务'], tags: ['后端'], confidence: 0.62 },
  { words: ['数据库', 'database', 'sql', 'postgres', 'mysql'], tags: ['数据库'], confidence: 0.65 },
  { words: ['安全', 'security', '漏洞', 'cve'], tags: ['安全'], confidence: 0.62 },
  { words: ['运维', 'devops', 'kubernetes', 'docker', 'ci/cd'], tags: ['运维'], confidence: 0.62 },
  { words: ['效率', 'productivity', '工作流'], tags: ['效率'], confidence: 0.58 },
  { words: ['理财', 'investment', '基金', '股票'], tags: ['理财'], confidence: 0.65 },
  { words: ['菜谱', 'recipe', '做法'], tags: ['美食'], confidence: 0.7 },
  { words: ['旅行', 'travel', '攻略'], tags: ['旅行'], confidence: 0.65 },
  { words: ['论文', 'paper', 'arxiv'], tags: ['论文'], confidence: 0.68 },
  { words: ['工具', 'tool', 'toolkit', '神器'], tags: ['工具'], confidence: 0.55 },
];

export interface RawCandidate {
  name: string;
  confidence: number;
  source: CandidateSource;
  reason: string;
}

/** Hostname without `www.`, lowercase. Returns null for unparseable input. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Whether `word` appears in `haystack`, anchored so a short ASCII keyword does
 * not fire inside a longer word ("go" must not match "google"). Exported for
 * unit testing the matching rule in isolation.
 */
export function matchesKeyword(haystack: string, word: string): boolean {
  const needle = word.toLowerCase();
  // A CJK or otherwise non-ASCII needle has no word boundaries to anchor to.
  if (!/^[\x20-\x7e]+$/.test(needle)) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

/**
 * Produces tag candidates from the URL and text alone.
 *
 * Never throws and never needs the network, so it is safe to call on every
 * bookmark in a batch of thousands.
 */
export function heuristicCandidates(input: EnrichInput): RawCandidate[] {
  const out: RawCandidate[] = [];
  const seen = new Set<string>();

  const push = (name: string, confidence: number, reason: string) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, confidence, source: 'heuristic', reason });
  };

  const host = hostOf(input.url);
  if (host) {
    for (const rule of DOMAIN_RULES) {
      if (host === rule.host || host.endsWith(`.${rule.host}`)) {
        for (const tag of rule.tags) push(tag, rule.confidence, `域名 ${rule.host}`);
      }
    }
  }

  let path = '';
  try {
    path = new URL(input.url).pathname.toLowerCase();
  } catch {
    path = '';
  }
  if (path) {
    for (const rule of PATH_RULES) {
      if (path.includes(rule.match)) {
        for (const tag of rule.tags) push(tag, rule.confidence, `路径含 ${rule.match}`);
      }
    }
  }

  const text = `${input.title ?? ''} ${input.description ?? ''}`.toLowerCase();
  if (text.trim()) {
    for (const rule of KEYWORD_RULES) {
      const hit = rule.words.find((word) => matchesKeyword(text, word));
      if (hit) {
        for (const tag of rule.tags) push(tag, rule.confidence, `关键词「${hit}」`);
      }
    }
  }

  return out;
}
