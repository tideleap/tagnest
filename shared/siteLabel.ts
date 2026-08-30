// shared/siteLabel.ts
//
// Canonical, shared site-label resolution used by BOTH the Cloudflare Functions
// backend (AI categorisation → stable L2 site names) and the browser export
// path (friendly "首页 | 站点" title fallback). Keeping a single source of
// truth here means the model, the exporter and the rename track all agree on
// the same friendly brand name for a given host — e.g. every amap.com variant
// collapses to 「高德地图」, and github.com is always 「GitHub」.
//
// This module is intentionally framework-free (only `URL` + string ops) so it
// can be imported from a Worker, the browser and Node test runners alike.

/**
 * Known brands → friendly tag name.
 *
 * First exact (or sub-domain) match wins. Anything not listed falls through to
 * `brandFromHost`, which Title-cases the registrable second-level label. The
 * list is intentionally small and uncontroversial: it is a last-resort safety
 * net, not a tagging strategy, so it must never surprise the user with a wrong
 * category the way a full rule engine could.
 */
export const KNOWN_BRANDS: Record<string, string> = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'gitee.com': 'Gitee',
  'stackoverflow.com': 'StackOverflow',
  'npmjs.com': 'npm',
  'pypi.org': 'PyPI',
  'crates.io': 'Rust',
  'developer.mozilla.org': 'MDN',
  'react.dev': 'React',
  'vuejs.org': 'Vue',
  'svelte.dev': 'Svelte',
  'tailwindcss.com': 'Tailwind',
  'docs.python.org': 'Python文档',
  'go.dev': 'Go',
  'rust-lang.org': 'Rust',
  'kubernetes.io': 'Kubernetes',
  'docker.com': 'Docker',
  'cloudflare.com': 'Cloudflare',
  'aws.amazon.com': 'AWS',
  'aliyun.com': '阿里云',
  'tencentcloud.com': '腾讯云',
  'arxiv.org': 'arXiv',
  'huggingface.co': 'HuggingFace',
  'openai.com': 'OpenAI',
  'anthropic.com': 'Anthropic',
  'paperswithcode.com': 'PapersWithCode',
  'kaggle.com': 'Kaggle',
  'medium.com': 'Medium',
  'substack.com': 'Substack',
  'juejin.cn': '掘金',
  'segmentfault.com': 'SegmentFault',
  'cnblogs.com': '博客园',
  'csdn.net': 'CSDN',
  'infoq.cn': 'InfoQ',
  'zhihu.com': '知乎',
  'news.ycombinator.com': 'HackerNews',
  'reddit.com': 'Reddit',
  'v2ex.com': 'V2EX',
  'youtube.com': 'YouTube',
  'bilibili.com': 'B站',
  'figma.com': 'Figma',
  'dribbble.com': 'Dribbble',
  'behance.net': 'Behance',
  'unsplash.com': 'Unsplash',
  'notion.so': 'Notion',
  'producthunt.com': 'ProductHunt',
  'zhipin.com': 'Boss直聘',
  'lagou.com': '拉勾',
  'linkedin.com': 'LinkedIn',
  'coursera.org': 'Coursera',
  'udemy.com': 'Udemy',
  'leetcode.cn': 'LeetCode',
  'leetcode.com': 'LeetCode',
  // --- 高德 (Amap) family: every variant collapses to one canonical name ---
  'amap.com': '高德地图',
  'lbs.amap.com': '高德地图',
  'console.amap.com': '高德地图',
  'ditu.amap.com': '高德地图',
  'restapi.amap.com': '高德地图',
  'maps.amap.com': '高德地图',
  // --- a few common maps / search portals for nicer titles ---
  'baidu.com': '百度',
  'map.baidu.com': '百度地图',
  'google.com': 'Google',
  'maps.google.com': 'Google 地图',
  'bing.com': 'Bing',
  'yandex.com': 'Yandex',
};

const GENERIC_TITLES = new Set([
  '首页',
  '主页',
  'home',
  'homepage',
  'index',
  '未命名',
  '新标签页',
  'about:blank',
  '',
]);

/**
 * Turns a host into a readable tag: the registrable second-level label,
 * Title-cased. `news.ycombinator.com` → `Ycombinator` (leading subdomain
 * dropped when there are 3+ labels); `example.com` → `Example`.
 */
export function brandFromHost(host: string): string {
  const labels = host.split('.');
  const sld = labels.length >= 3 ? labels[labels.length - 2] : labels[0];
  return sld.charAt(0).toUpperCase() + sld.slice(1);
}

/**
 * The friendly site label for any URL — the exact same name the backend would
 * assign as an L2 site folder — so the exporter can reproduce the reference
 * template's `首页 | 高德地图` style consistently.
 *
 * Resolution order:
 *  1. exact host match in {@link KNOWN_BRANDS} (e.g. `github.com` → `GitHub`);
 *  2. sub-domain / suffix match (e.g. `gist.github.com` → `GitHub`);
 *  3. `brandFromHost` of the registrable label (e.g. `sub.example.co.uk` → `Example`).
 *
 * Invalid / hostless URLs return `'未命名站点'` so callers can fall back to
 * the raw URL.
 */
export function canonicalSiteLabel(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (!host) return '未命名站点';
    const exact = KNOWN_BRANDS[host];
    if (exact) return exact;
    for (const [key, value] of Object.entries(KNOWN_BRANDS)) {
      if (host !== key && host.endsWith('.' + key)) return value;
    }
    return brandFromHost(host);
  } catch {
    return '未命名站点';
  }
}

/**
 * True when `input` is an empty or placeholder title that should be rescued
 * into a `首页 | 站点` label. Shared so the exporter, the rename track and the
 * categoriser all treat "generic" identically (fixes T3 divergence).
 */
export function isGenericTitle(input: string): boolean {
  const t = (input ?? '').trim().toLowerCase();
  return t === '' || GENERIC_TITLES.has(t);
}
