import type { AiJob, AiSuggestion } from '../../../shared/types';
import type { JobRow, SuggestionRow } from './store';

/**
 * Row → DTO mapping for the AI endpoints.
 *
 * Lives here rather than in one of the route files because four routes return
 * jobs and three return suggestions; a shared mapper is the only way the wire
 * shape stays identical across all of them.
 */

export function toApiJob(row: JobRow): AiJob {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    target: row.scope?.target ?? 'untagged',
    total: row.total,
    processed: row.processed,
    suggested: row.suggested,
    failed: row.failed,
    engine: row.engine as AiJob['engine'],
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    promptVersion: row.promptVersion,
  };
}

export function toApiSuggestion(row: SuggestionRow): AiSuggestion {
  return {
    id: row.id,
    bookmarkId: row.bookmarkId,
    bookmarkTitle: row.bookmarkTitle,
    bookmarkUrl: row.bookmarkUrl,
    tagName: row.tagName,
    tagId: row.tagId,
    confidence: row.confidence,
    source: row.source as AiSuggestion['source'],
    reason: row.reason,
    topic: row.topic,
    needsReview: row.needsReview,
    feedbackBoosted: row.feedbackBoosted,
    createdAt: row.createdAt,
  };
}
