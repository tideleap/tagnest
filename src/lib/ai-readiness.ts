import type { AiSettings } from '@shared/types';

/**
 * Live readiness diagnostic for the AI feature.
 *
 * Mirrors the backend `loadAiConfig` gate (functions/_lib/ai.ts) so the settings
 * UI is honest about whether saving a bookmark will actually run inference
 * today. Returns the list of reasons the feature is NOT ready; an empty list
 * means it will run.
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
