import type { CandidateSource, EnrichInput, RawCandidate } from './types';
import { hostOf } from '../urlkey';

/**
 * Known brands → friendly tag name.
 *
 * First exact (or subdomain) match wins. Anything not listed falls through to
 * `brandFromHost`, which Title-cases the registrable second-level label. The
 * list is intentionally small and uncontroversial: it is a last-resort safety
 * net, not a tagging strategy, so it must never surprise the user with a wrong
 * category the way a full rule engine could.
 */
const KNOWN_BRANDS: Record<string, string> = {
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
};

/**
 * Derives a single fallback tag from the bookmark's host so that every bookmark
 * still receives at least one tag even when the model contributes nothing.
 *
 * The tag is marked `source: 'fallback'` and the caller is expected to set
 * `needsReview` so the user can confirm or replace it. This is a coverage
 * safety net, not a tagging strategy: it exists only so "no model output" never
 * means "no tag at all" (see docs/AI-HIERARCHY.md).
 */
export function domainFallbackTag(input: EnrichInput): RawCandidate | null {
  const host = hostOf(input.url);
  const name = host ? (KNOWN_BRANDS[host] ?? brandFromHost(host)) : '未分类';
  return {
    name,
    confidence: 0.5,
    source: 'fallback' as CandidateSource,
    reason: `域名派生兜底（${host ?? input.url}）`,
  };
}

/** Turns a host into a readable tag: the registrable second-level label, Title-cased. */
function brandFromHost(host: string): string {
  const labels = host.split('.');
  // Drop a leading subdomain when there are 3+ labels (news.ycombinator.com → ycombinator).
  const sld = labels.length >= 3 ? labels[labels.length - 2] : labels[0];
  return sld.charAt(0).toUpperCase() + sld.slice(1);
}
