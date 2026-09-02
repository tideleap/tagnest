import type { AiJobTarget } from '../../../shared/types';
import { badRequest } from '../http';
import { MAX_JOB_ITEMS } from './store';

/**
 * C-5: 整理任务范围参数的**唯一**校验实现。
 *
 * `POST /api/ai/jobs`（创建任务，参数在 JSON body）和
 * `GET /api/ai/jobs/estimate`（成本预估，参数在 query string）必须对同一组
 * target / kind / ids 得出同一个范围 —— 否则预估卡片和真实任务算的是两件事。
 * 原先两个端点各写了一份几乎相同的校验（含同样的 MAX_JOB_ITEMS 截断、Set 去重、
 * `请选择要整理的书签` 文案），任何一侧改规则都会静默偏离另一侧。这里收敛成一处。
 *
 * 唯一保留的差异由 `strictKind` 表达：创建任务时非法 kind 必须报错（用户会真的
 * 跑一个不存在的轨道），而预估是只读的，历史行为是静默回落到 tagging，保持不变。
 */

export type AiJobKind = 'tagging' | 'categorize' | 'rename';

export interface JobScopeParams {
  target: AiJobTarget;
  kind: AiJobKind;
  /** 去重、去空、按 MAX_JOB_ITEMS 截断后的显式 ID 列表；target !== 'ids' 时为空。 */
  ids: string[];
}

/**
 * 规范化显式书签 ID：接受数组（JSON body）或逗号分隔字符串（query string）。
 * 顺序保持首次出现的顺序，因为任务范围是有序快照（store.ts 的 JobScope.ids）。
 */
function normalizeIds(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.map((v) => String(v).trim())
    : typeof raw === 'string'
      ? raw.split(',').map((s) => s.trim())
      : [];
  return [...new Set(list)].filter(Boolean).slice(0, MAX_JOB_ITEMS);
}

export function parseJobScopeParams(
  input: { target?: unknown; kind?: unknown; ids?: unknown },
  opts: { strictKind?: boolean } = {},
): JobScopeParams {
  const rawKind = String(input.kind ?? 'tagging');
  let kind: AiJobKind;
  if (rawKind === 'categorize' || rawKind === 'rename' || rawKind === 'tagging') {
    kind = rawKind;
  } else if (opts.strictKind) {
    throw badRequest('任务类型无效');
  } else {
    kind = 'tagging';
  }

  const rawTarget = String(input.target ?? 'untagged');
  if (rawTarget !== 'untagged' && rawTarget !== 'all' && rawTarget !== 'ids') {
    throw badRequest('整理范围无效');
  }
  const target: AiJobTarget = rawTarget;

  const ids = target === 'ids' ? normalizeIds(input.ids) : [];
  if (target === 'ids' && ids.length === 0) {
    throw badRequest('请选择要整理的书签');
  }

  return { target, kind, ids };
}
