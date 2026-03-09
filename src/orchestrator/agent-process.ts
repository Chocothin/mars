import type { ICliExecutor, CliExecuteOptions, CliExecuteResult } from '../types/provider';
import type { Agent } from '../types/agent';
import type { Task } from '../types/task';
import type { AgentContext } from '../execution/types';
import type { TaskExecutionOutput } from './types';
import type { IContextBuilder, ContextBuildParams } from '../execution/context-builder';
import { eventBus } from '../events/bus';
import { writeMcpConfig } from '../terminal/provider/mcp-config-writer';

// ─── AgentProcess: 단일 에이전트 CLI 프로세스 생명주기 ───

export type ProcessState = 'idle' | 'spawning' | 'executing' | 'terminated';

export interface AgentProcessConfig {
  agent: Agent;
  cliExecutor: ICliExecutor;
  contextBuilder: IContextBuilder;
  projectDirectory: string;
  projectId: string;
  runId: string;
}

export interface ExecuteResult {
  output: TaskExecutionOutput;
  sessionId: string | null;
  durationMs: number;
}

export class AgentProcess {
  readonly agentId: string;
  readonly agentName: string;
  readonly runId: string;

  private state: ProcessState = 'idle';
  private externalSessionId: string | null = null;
  private currentTaskId: string | null = null;
  private abortController: AbortController | null = null;

  private readonly agent: Agent;
  private readonly cliExecutor: ICliExecutor;
  private readonly contextBuilder: IContextBuilder;
  private readonly projectDirectory: string;
  private readonly projectId: string;

  constructor(config: AgentProcessConfig) {
    this.agent = config.agent;
    this.agentId = config.agent.id;
    this.agentName = config.agent.name;
    this.runId = config.runId;
    this.cliExecutor = config.cliExecutor;
    this.contextBuilder = config.contextBuilder;
    this.projectDirectory = config.projectDirectory;
    this.projectId = config.projectId;
  }

  // ─── State ───

  getState(): ProcessState { return this.state; }
  getSessionId(): string | null { return this.externalSessionId; }
  getCurrentTaskId(): string | null { return this.currentTaskId; }

  // ─── Execute ───

  /**
   * Execute a task. If an externalSessionId exists from a prior execution,
   * automatically uses --resume to continue the same CLI session.
   *
   * Returns the task output, the CLI session ID (for future resume), and duration.
   */
  async execute(
    task: Task,
    priorResults: TaskExecutionOutput[],
    onChunk?: (chunk: string) => void,
  ): Promise<ExecuteResult> {
    if (this.state === 'terminated') {
      throw new Error(`AgentProcess ${this.agentId} is terminated`);
    }

    this.state = 'executing';
    this.currentTaskId = task.id;
    this.abortController = new AbortController();

    eventBus.emit({
      type: 'task:started',
      taskId: task.id,
      agentId: this.agentId,
      sessionId: this.externalSessionId ?? 'pending',
    });

    try {
      const context = await this.buildContext(task, priorResults);
      const cliOptions = this.buildCliOptions(context);
      const result = await this.runCli(cliOptions, onChunk);

      if (result.sessionId) {
        this.externalSessionId = result.sessionId;
      }

      const output = this.parseOutput(result);

      if (!result.success) {
        const errorMsg = result.error
          ? result.error.slice(0, 500)
          : `exit code ${result.exitCode}`;
        throw new Error(`CLI failed: ${errorMsg}`);
      }

      this.state = 'idle';
      this.currentTaskId = null;
      this.abortController = null;

      eventBus.emit({
        type: 'task:completed',
        taskId: task.id,
        output,
      });

      return {
        output,
        sessionId: this.externalSessionId,
        durationMs: result.durationMs,
      };
    } catch (err) {
      this.state = 'idle';
      this.currentTaskId = null;
      this.abortController = null;

      const error = err instanceof Error ? err : new Error(String(err));

      eventBus.emit({
        type: 'task:failed',
        taskId: task.id,
        error: error.message,
        attempt: task.retryCount + 1,
      });

      throw error;
    }
  }

  // ─── Abort ───

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  // ─── Terminate ───

  terminate(): void {
    this.abort();
    this.state = 'terminated';
    this.currentTaskId = null;
    this.abortController = null;
  }

  // ─── Session Management ───

  clearSession(): void {
    this.externalSessionId = null;
  }

  hasSession(): boolean {
    return this.externalSessionId !== null;
  }

  // ─── Internal ───

  private async buildContext(task: Task, priorResults: TaskExecutionOutput[]): Promise<AgentContext> {
    const params: ContextBuildParams = {
      agent: this.agent,
      task,
      priorResults,
      projectDirectory: this.projectDirectory,
      projectId: this.projectId,
      autonomousMode: true,
    };
    return this.contextBuilder.build(params);
  }

  private buildCliOptions(context: AgentContext): CliExecuteOptions {
    const options: CliExecuteOptions = {
      prompt: context.task.description || context.task.title,
      systemPrompt: context.systemPrompt || undefined,
      model: context.agent.modelId,
      workingDirectory: context.workingDirectory || undefined,
    };

    const allowedTools = context.tools
      .filter(t => t.enabled && t.source === 'mcp' && t.name)
      .map(t => t.name);

    if (allowedTools.length > 0) {
      options.allowedTools = allowedTools;
    }

    if (context.mcpServers.length > 0) {
      options.mcpConfig = writeMcpConfig(context.mcpServers);
    }

    if (this.externalSessionId) {
      options.resumeSessionId = this.externalSessionId;
    }

    return options;
  }

  private async runCli(
    options: CliExecuteOptions,
    onChunk?: (chunk: string) => void,
  ): Promise<CliExecuteResult> {
    const chunkHandler = (chunk: string) => {
      if (onChunk) onChunk(chunk);

      if (this.currentTaskId) {
        eventBus.emit({
          type: 'task:progress',
          taskId: this.currentTaskId,
          chunk,
        });
      }
    };

    return this.cliExecutor.executeStreaming(
      this.agent.providerId,
      options,
      chunkHandler,
      this.abortController?.signal,
    );
  }

  private parseOutput(result: CliExecuteResult): TaskExecutionOutput {
    try {
      const parsed = JSON.parse(result.output);
      return {
        result: parsed.result ?? result.output,
        filesModified: parsed.files_modified ?? [],
        tokensUsed: parsed.usage?.total_tokens ?? null,
        costUsd: parsed.cost_usd ?? null,
      };
    } catch {
      return {
        result: result.output,
        filesModified: [],
        tokensUsed: null,
        costUsd: null,
      };
    }
  }
}
