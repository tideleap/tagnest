import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AiOverview } from '@shared/types';
import { EvaluationPanel } from './EvaluationPanel';

/**
 * Contract-drift regressions. The overview type promises every aggregate, but
 * the wire has shipped bare `{}` before (degraded endpoint, cached shell mid-
 * rollout) and the panel used to crash the entire app on `feedback.total`.
 * A missing aggregate must degrade to "no data", never throw.
 */

function makeOverview(overrides: Partial<AiOverview> = {}): AiOverview {
  return {
    modelReady: true,
    pendingSuggestions: 0,
    untaggedBookmarks: 4,
    totalBookmarks: 12,
    aiTagLinks: 6,
    userTagLinks: 9,
    recentJobs: [],
    feedback: {
      total: 5,
      accepted: 4,
      rejected: 1,
      modified: 1,
      acceptanceRate: 0.8,
      proposalTotal: 10,
      proposalAccepted: 7,
      hitRate: 0.7,
    },
    feedbackTrend: [{ date: '2026-08-01', accepted: 2, rejected: 1 }],
    promptVersion: 'v2',
    usage: {
      adoptionRate: 0.25,
      touchedBookmarks: 3,
      totalBookmarks: 12,
      byScope: [],
      byEngine: [],
      runsLast30Days: 2,
      avgRunSize: 6,
      suggestionOutcome: { accepted: 1, rejected: 0, pending: 0, autoApplied: 0 },
    },
    contribution: {
      directAi: 4,
      assistedAi: 1,
      fallbackAi: 1,
      userOnly: 9,
      weightedRate: 0.34,
      acceptanceRate: 0.8,
      hitRate: 0.75,
      raw: { aiAccepted: 5, modified: 0, rejected: 1, fallbackAccepted: 0, userCreated: 0 },
    },
    ...overrides,
  };
}

describe('EvaluationPanel (contract-drift resilience)', () => {
  it('renders metrics from a complete overview', () => {
    render(<EvaluationPanel overview={makeOverview()} />);
    expect(screen.getByText('整理效果评估')).toBeInTheDocument();
    expect(screen.getByText('Prompt v2')).toBeInTheDocument();
    expect(screen.getByText('采纳率')).toBeInTheDocument();
  });

  it('renders the empty hint when feedback has no data', () => {
    const overview = makeOverview({
      feedback: { ...makeOverview().feedback, total: 0, proposalTotal: 0 },
      feedbackTrend: [],
    });
    render(<EvaluationPanel overview={overview} />);
    expect(screen.getByText(/还没有决策数据/)).toBeInTheDocument();
  });

  it('does not crash when feedback is missing (bare {} overview)', () => {
    // Simulates the degraded wire shape that used to throw
    // "Cannot read properties of undefined (reading 'total')".
    const overview = {} as AiOverview;
    render(<EvaluationPanel overview={overview} />);
    expect(screen.getByText(/还没有决策数据/)).toBeInTheDocument();
    expect(screen.getByText('Prompt —')).toBeInTheDocument();
  });

  it('does not crash when feedbackTrend or recentJobs are missing', () => {
    const { feedback, ...rest } = makeOverview();
    const overview = { ...rest, feedback } as AiOverview;
    delete (overview as Partial<AiOverview>).feedbackTrend;
    delete (overview as Partial<AiOverview>).recentJobs;
    render(<EvaluationPanel overview={overview} />);
    expect(screen.getByText('整理效果评估')).toBeInTheDocument();
  });

  it('renders nothing when overview is undefined (still loading)', () => {
    const { container } = render(<EvaluationPanel overview={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
