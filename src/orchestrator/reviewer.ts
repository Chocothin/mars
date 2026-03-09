import type { TaskExecution } from './types';
import type { Task } from '../types/task';
import type { ICliExecutor, CliExecuteOptions } from '../types/provider';
import { eventBus } from '../events/bus';

export interface ReviewResult {
  passed: boolean;
  suggestedAction: 'approve' | 'retry' | 'reassign' | 'escalate';
  feedback: string;
  criteriaResults?: Array<{ criterion: string; met: boolean; evidence: string }>;
}

export interface ReviewContext {
  projectDirectory?: string;
}

export interface IResultReviewer {
  review(execution: TaskExecution): Promise<ReviewResult>;
  reviewWithCriteria(execution: TaskExecution, task: Task, context?: ReviewContext): Promise<ReviewResult>;
}

export class ResultReviewer implements IResultReviewer {
  private cliExecutor: ICliExecutor | null;
  private reviewerProviderId: string | null;

  constructor(deps: {
    cliExecutor?: ICliExecutor;
    reviewerProviderId?: string;
  }) {
    this.cliExecutor = deps.cliExecutor ?? null;
    this.reviewerProviderId = deps.reviewerProviderId ?? null;
  }

  async review(execution: TaskExecution): Promise<ReviewResult> {
    eventBus.emit({
      type: 'review:started',
      taskId: execution.taskId,
      runId: execution.runId,
      attempt: execution.attempt,
    });

    if (execution.status === 'completed' && execution.output) {
      const result: ReviewResult = {
        passed: true,
        suggestedAction: 'approve',
        feedback: 'Task completed successfully.',
      };
      eventBus.emit({ type: 'review:passed', taskId: execution.taskId, runId: execution.runId });
      return result;
    }

    if (execution.status === 'failed') {
      const feedback = execution.error ?? 'Execution failed.';
      const result: ReviewResult = {
        passed: false,
        suggestedAction: 'retry',
        feedback,
      };
      eventBus.emit({ type: 'review:failed', taskId: execution.taskId, runId: execution.runId, feedback });
      return result;
    }

    const feedback = `Cannot review: status is ${execution.status}`;
    const result: ReviewResult = {
      passed: false,
      suggestedAction: 'escalate',
      feedback,
    };
    eventBus.emit({ type: 'review:failed', taskId: execution.taskId, runId: execution.runId, feedback });
    return result;
  }

  async reviewWithCriteria(execution: TaskExecution, task: Task, context?: ReviewContext): Promise<ReviewResult> {
    if (execution.status !== 'completed' || !execution.output) {
      return this.review(execution);
    }

    const outputText = execution.output.result;
    const sanityResult = this.sanityCheck(outputText, task);
    if (sanityResult) {
      eventBus.emit({ type: 'review:failed', taskId: execution.taskId, runId: execution.runId, feedback: sanityResult.feedback });
      return sanityResult;
    }

    if (!this.cliExecutor || !this.reviewerProviderId) {
      return this.review(execution);
    }

    if (!task.acceptanceCriteria || task.acceptanceCriteria.length === 0) {
      return this.review(execution);
    }

    eventBus.emit({
      type: 'review:started',
      taskId: execution.taskId,
      runId: execution.runId,
      attempt: execution.attempt,
    });

    const criteriaList = task.acceptanceCriteria
      .map((c, i) => `${i + 1}. ${c}`)
      .join('\n');

    const projectDir = context?.projectDirectory;
    const filesModified = execution.output.filesModified ?? [];
    const filesDirs = this.resolveSearchDirectories(projectDir, filesModified);

    const reviewPrompt = [
      'You are a quality reviewer. Evaluate whether the agent output meets ALL acceptance criteria.',
      '',
      filesDirs.length > 0
        ? `파일 검증 시 다음 디렉토리를 확인하세요:\n${filesDirs.map(d => `- ${d}`).join('\n')}`
        : '',
      filesModified.length > 0
        ? `에이전트가 수정/생성한 파일 목록:\n${filesModified.map(f => `- ${f}`).join('\n')}`
        : '',
      '',
      `Task: ${task.title}`,
      task.description ? `Description: ${task.description}` : '',
      '',
      'Acceptance Criteria:',
      criteriaList,
      '',
      'Agent Output:',
      execution.output.result.slice(0, 8000),
      '',
      'Respond with ONLY a JSON object (no markdown, no explanation):',
      '{',
      '  "passed": boolean,',
      '  "criteriaResults": [{ "criterion": "...", "met": boolean, "evidence": "..." }],',
      '  "feedback": "summary of what passed/failed"',
      '}',
    ].filter(Boolean).join('\n');

    const options: CliExecuteOptions = {
      prompt: reviewPrompt,
      outputFormat: 'text',
      workingDirectory: projectDir,
      additionalArgs: filesDirs.length > 1
        ? filesDirs.slice(1).flatMap(d => ['--add-dir', d])
        : undefined,
    };

    try {
      const cliResult = await this.cliExecutor.execute(this.reviewerProviderId, options);
      const parsed = this.parseReviewResponse(cliResult.output);

      if (parsed.passed) {
        eventBus.emit({ type: 'review:passed', taskId: execution.taskId, runId: execution.runId });
      } else {
        eventBus.emit({ type: 'review:failed', taskId: execution.taskId, runId: execution.runId, feedback: parsed.feedback });
      }

      return parsed;
    } catch {
      return this.review(execution);
    }
  }

  private sanityCheck(outputText: string, task: Task): ReviewResult | null {
    if (outputText.length < 200) {
      return {
        passed: false,
        suggestedAction: 'retry',
        feedback: 'Output too short — likely incomplete. Agent must produce substantial work output.',
      };
    }

    const questionPatterns = [
      /어떤.*(?:원하시|선택해|방식을)/,
      /다음 중.*선택/,
      /확인이 필요합니다/,
      /어떻게.*진행할까요/,
      /라우팅은.*어떤.*수준/,
      /\?\s*$/m,
    ];
    const questionCount = questionPatterns.filter(p => p.test(outputText)).length;
    if (questionCount >= 2) {
      return {
        passed: false,
        suggestedAction: 'retry',
        feedback: 'Agent asked questions instead of implementing. In autonomous mode, agent must make decisions independently and produce working code.',
      };
    }

    if (task.expectedOutputs && task.expectedOutputs.length > 0) {
      const hasFileReference = task.expectedOutputs.some(f =>
        outputText.includes(f) || outputText.includes('✅')
      );
      if (!hasFileReference && outputText.length < 1000) {
        return {
          passed: false,
          suggestedAction: 'retry',
          feedback: `Expected outputs not referenced in agent output. Expected: ${task.expectedOutputs.join(', ')}`,
        };
      }
    }

    return null;
  }

  private resolveSearchDirectories(projectDir: string | undefined, filesModified: string[]): string[] {
    const dirs = new Set<string>();
    if (projectDir) dirs.add(projectDir);

    for (const filePath of filesModified) {
      if (!filePath.startsWith('/')) continue;
      const parts = filePath.split('/');
      parts.pop();
      const dir = parts.join('/');
      if (dir && (!projectDir || !dir.startsWith(projectDir))) {
        dirs.add(dir);
      }
    }

    return [...dirs];
  }

  private extractJsonObject(text: string): string {
    const start = text.indexOf('{');
    if (start === -1) throw new Error('No JSON object found in output');
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
    throw new Error('Unterminated JSON object in output');
  }

  private parseReviewResponse(output: string): ReviewResult {
    try {
      const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const raw = fenced ? fenced[1]!.trim() : output.trim();
      const jsonStr = this.extractJsonObject(raw);

      const parsed = JSON.parse(jsonStr) as {
        passed?: boolean;
        criteriaResults?: Array<{ criterion: string; met: boolean; evidence: string }>;
        feedback?: string;
      };

      return {
        passed: !!parsed.passed,
        suggestedAction: parsed.passed ? 'approve' : 'retry',
        feedback: parsed.feedback ?? (parsed.passed ? 'All criteria met.' : 'Some criteria not met.'),
        criteriaResults: parsed.criteriaResults,
      };
    } catch {
      return {
        passed: false,
        suggestedAction: 'escalate',
        feedback: 'Failed to parse review response.',
      };
    }
  }
}
