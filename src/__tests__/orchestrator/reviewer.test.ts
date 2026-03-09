import { describe, it, expect, afterEach } from 'bun:test';
import { ResultReviewer } from '../../orchestrator/reviewer';
import { eventBus } from '../../events/bus';
import type { TaskExecution } from '../../orchestrator/types';
import type { AllEvents } from '../../events/types';

afterEach(() => {
  eventBus.removeAllListeners();
});

function makeExecution(overrides: Partial<TaskExecution> = {}): TaskExecution {
  return {
    id: overrides.id ?? 'exec-1',
    runId: overrides.runId ?? 'run-1',
    taskId: overrides.taskId ?? 'task-1',
    agentId: overrides.agentId ?? 'agent-1',
    sessionId: overrides.sessionId ?? null,
    status: overrides.status ?? 'completed',
    attempt: overrides.attempt ?? 1,
    input: overrides.input ?? {
      prompt: 'test',
      systemPrompt: 'sys',
      tools: [],
      context: '',
      workingDirectory: '/tmp',
      orchestrationBrief: null,
    },
    output: overrides.output !== undefined ? overrides.output : {
      result: 'done',
      filesModified: [],
      tokensUsed: 100,
      costUsd: 0.01,
    },
    startedAt: overrides.startedAt ?? Date.now(),
    completedAt: overrides.completedAt ?? Date.now(),
    durationMs: overrides.durationMs ?? 1000,
    error: overrides.error ?? null,
  };
}

describe('ResultReviewer', () => {
  describe('review', () => {
    it('approves completed execution with output', async () => {
      const reviewer = new ResultReviewer({});
      const execution = makeExecution({ status: 'completed' });

      const result = await reviewer.review(execution);

      expect(result.passed).toBe(true);
      expect(result.suggestedAction).toBe('approve');
      expect(result.feedback).toContain('successfully');
    });

    it('suggests retry for failed execution', async () => {
      const reviewer = new ResultReviewer({});
      const execution = makeExecution({
        status: 'failed',
        output: null,
        error: 'OOM',
      });

      const result = await reviewer.review(execution);

      expect(result.passed).toBe(false);
      expect(result.suggestedAction).toBe('retry');
      expect(result.feedback).toBe('OOM');
    });

    it('suggests escalate for non-reviewable status', async () => {
      const reviewer = new ResultReviewer({});
      const execution = makeExecution({
        status: 'running',
        output: null,
      });

      const result = await reviewer.review(execution);

      expect(result.passed).toBe(false);
      expect(result.suggestedAction).toBe('escalate');
      expect(result.feedback).toContain('running');
    });

    it('emits review:started then review:passed for completed execution', async () => {
      const events: AllEvents[] = [];
      eventBus.onAny((e) => events.push(e));

      const reviewer = new ResultReviewer({});
      await reviewer.review(makeExecution({ status: 'completed' }));

      expect(events.map((e) => e.type)).toEqual(['review:started', 'review:passed']);
    });

    it('emits review:started then review:failed for failed execution', async () => {
      const events: AllEvents[] = [];
      eventBus.onAny((e) => events.push(e));

      const reviewer = new ResultReviewer({});
      await reviewer.review(makeExecution({ status: 'failed', output: null, error: 'err' }));

      expect(events.map((e) => e.type)).toEqual(['review:started', 'review:failed']);
    });

    it('handles failed execution with null error gracefully', async () => {
      const reviewer = new ResultReviewer({});
      const execution = makeExecution({
        status: 'failed',
        output: null,
        error: null,
      });

      const result = await reviewer.review(execution);
      expect(result.feedback).toBe('Execution failed.');
    });
  });
});
