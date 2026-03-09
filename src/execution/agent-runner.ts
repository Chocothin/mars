import type { CliExecuteOptions } from '../types/provider';
import type { TaskExecutionOutput } from '../orchestrator/types';
import type { AgentContext, RunnerCallbacks } from './types';
import type { ISessionManager } from './session-manager';
import type { ICliExecutor } from '../types/provider';
import { writeMcpConfig } from '../terminal/provider/mcp-config-writer';

// ─── IAgentRunner: 개별 에이전트 실행 인터페이스 ───

export interface IAgentRunner {
  run(
    context: AgentContext,
    taskExecutionId: string,
    callbacks: RunnerCallbacks,
    signal?: AbortSignal,
  ): Promise<TaskExecutionOutput>;
  abort(sessionId: string): Promise<void>;
}

// ─── AgentRunner: ClaudeCliExecutor 기반 에이전트 실행 ───

export class AgentRunner implements IAgentRunner {
  private sessionManager: ISessionManager;
  private cliExecutor: ICliExecutor;
  private abortControllers = new Map<string, AbortController>();

  constructor(sessionManager: ISessionManager, cliExecutor: ICliExecutor) {
    this.sessionManager = sessionManager;
    this.cliExecutor = cliExecutor;
  }

  async run(
    context: AgentContext,
    taskExecutionId: string,
    callbacks: RunnerCallbacks,
    signal?: AbortSignal,
  ): Promise<TaskExecutionOutput> {
    const session = this.sessionManager.createSession(
      context.agent.id,
      taskExecutionId,
    );

    const abortController = new AbortController();
    this.abortControllers.set(session.id, abortController);

    callbacks.onStart(session);

    try {
      const options = this.buildCliOptions(context);

      const result = await this.cliExecutor.executeStreaming(
        context.agent.providerId,
        options,
        (chunk: string) => {
          this.sessionManager.updateSession(session.id, {});
          callbacks.onChunk(session.id, chunk);
          this.detectToolUse(chunk, session.id, callbacks);
        },
        signal,
      );

      if (result.sessionId) {
        this.sessionManager.updateSession(session.id, {
          externalSessionId: result.sessionId,
        });
      }

      if (!result.success) {
        const stderr = result.error ? ` — ${result.error.slice(0, 500)}` : '';
        const error = new Error(`CLI exited with code ${result.exitCode}${stderr}`);
        this.sessionManager.endSession(session.id, 'failed');
        callbacks.onError(session.id, error);
        throw error;
      }

      const output = this.parseOutput(result.output, result.durationMs);

      this.sessionManager.endSession(session.id, 'completed');
      callbacks.onComplete(session.id, output);

      return output;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      const existingSession = this.sessionManager.getSession(session.id);
      if (existingSession) {
        this.sessionManager.endSession(session.id, 'failed');
        callbacks.onError(session.id, error);
      }

      throw error;
    } finally {
      this.abortControllers.delete(session.id);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
    }

    const session = this.sessionManager.getSession(sessionId);
    if (session && session.status === 'active') {
      this.sessionManager.endSession(sessionId, 'failed');
    }
  }

  private detectToolUse(chunk: string, sessionId: string, callbacks: RunnerCallbacks): void {
    try {
      const parsed = JSON.parse(chunk);
      if (parsed.type === 'tool_use' && parsed.name) {
        callbacks.onToolUse(sessionId, parsed.name, parsed.input ?? null);
      }
    } catch {
    }
  }

  private buildCliOptions(context: AgentContext): CliExecuteOptions {
    const options: CliExecuteOptions = {
      prompt: context.task.description || context.task.title,
      systemPrompt: context.systemPrompt || undefined,
      model: context.agent.modelId,
      workingDirectory: context.workingDirectory || undefined,
    };

    const allowedTools = context.tools
      .filter((t) => t.enabled && t.source === 'mcp' && t.name)
      .map((t) => t.name);

    if (allowedTools.length > 0) {
      options.allowedTools = allowedTools;
    }

    if (context.mcpServers.length > 0) {
      options.mcpConfig = writeMcpConfig(context.mcpServers);
    }

    return options;
  }

  private parseOutput(rawOutput: string, durationMs: number): TaskExecutionOutput {
    try {
      const parsed = JSON.parse(rawOutput);
      return {
        result: parsed.result ?? rawOutput,
        filesModified: parsed.files_modified ?? [],
        tokensUsed: parsed.usage?.total_tokens ?? null,
        costUsd: parsed.cost_usd ?? null,
      };
    } catch {
      return {
        result: rawOutput,
        filesModified: [],
        tokensUsed: null,
        costUsd: null,
      };
    }
  }
}
