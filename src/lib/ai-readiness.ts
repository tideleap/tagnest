import type { AiSettings } from '@shared/types';

/**
 * Live readiness diagnostic for the model track.
 *
 * Mirrors `functions/_lib/ai/config.ts#isModelReady` field for field. That
 * parity is the whole point: the backend used to gate additionally on an
 * `enabled` column this check knew nothing about, and since nothing ever set
 * that column to 1, the UI reported "ready" for a feature that was
 * unreachable. `enabled` is now derived from exactly these fields, so the two
 * cannot drift apart again.
 *
 * Returns the reasons the model is NOT usable; an empty list means it is.
 * Note this describes the *model* only — with heuristics on, the organiser
 * still produces suggestions when this returns a non-empty list.
 *
 * Kept as a pure function so the UI logic is unit-testable.
 */
export interface AiReadinessInput {
  provider: AiSettings['provider'];
  /** true once a key has been stored server-side. */
  hasApiKey: boolean;
  /** true if the caller currently has a not-yet-saved key in the form. */
  tempKeyPresent?: boolean;
  model: string | null;
  autoTag: boolean;
  autoSummarize: boolean;
}

export function aiReadiness(input: AiReadinessInput): string[] {
  const missing: string[] = [];
  if (input.provider === 'none') missing.push('未选择服务商');
  if (!input.hasApiKey && !input.tempKeyPresent) missing.push('未配置 API Key');
  if (!input.model) missing.push('未填写模型名称');
  if (!input.autoTag && !input.autoSummarize) missing.push('自动摘要/自动打标签均未开启');
  return missing;
}
