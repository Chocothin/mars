import type { ICliExecutor, CliExecuteOptions, CliExecuteResult } from '../types/provider';
import type { Agent } from '../types/agent';
import { eventBus } from '../events/bus';
import { getDefaultProvider } from '../db/provider-repo';

// ─── OrchestratorSession: 프로젝트 수명과 동일한 상시 활성 AI 세션 ───

export type OrchestratorState = 'idle' | 'processing' | 'terminated';

export interface ChatMessage {
  role: 'user' | 'orchestrator';
  content: string;
  timestamp: number;
}

export interface OrchestratorSessionConfig {
  agent: Agent;
  cliExecutor: ICliExecutor;
  projectId: string;
  projectDirectory: string;
  mcpConfigPath?: string;
}

export class OrchestratorSession {
  readonly projectId: string;
  readonly agentId: string;

  private state: OrchestratorState = 'idle';
  private sessionId: string | null = null;
  private history: ChatMessage[] = [];
  private abortController: AbortController | null = null;

  private readonly agent: Agent;
  private readonly cliExecutor: ICliExecutor;
  private readonly projectDirectory: string;
  private readonly mcpConfigPath: string | null;

  constructor(config: OrchestratorSessionConfig) {
    this.agent = config.agent;
    this.agentId = config.agent.id;
    this.projectId = config.projectId;
    this.cliExecutor = config.cliExecutor;
    this.projectDirectory = config.projectDirectory;
    this.mcpConfigPath = config.mcpConfigPath ?? null;
  }

  // ─── State ───

  getState(): OrchestratorState { return this.state; }
  getSessionId(): string | null { return this.sessionId; }
  getHistory(): ChatMessage[] { return [...this.history]; }

  // ─── Chat ───

  async send(
    userMessage: string,
    onChunk?: (chunk: string) => void,
  ): Promise<string> {
    if (this.state === 'terminated') {
      throw new Error('OrchestratorSession is terminated');
    }
    if (this.state === 'processing') {
      throw new Error('OrchestratorSession is already processing a message');
    }

    this.state = 'processing';
    this.abortController = new AbortController();

    this.history.push({ role: 'user', content: userMessage, timestamp: Date.now() });

    try {
      const result = await this.executePrompt(userMessage, onChunk);
      const response = result.output;

      if (result.sessionId) {
        this.sessionId = result.sessionId;
      }

      this.history.push({ role: 'orchestrator', content: response, timestamp: Date.now() });

      this.state = 'idle';
      this.abortController = null;
      return response;
    } catch (err) {
      this.state = 'idle';
      this.abortController = null;

      const error = err instanceof Error ? err : new Error(String(err));
      const isAbort = error.name === 'AbortError'
        || error.message.includes('abort')
        || error.message.includes('Controller is already closed');

      if (!isAbort) {
        this.history.push({
          role: 'orchestrator',
          content: `[Error] ${error.message}`,
          timestamp: Date.now(),
        });
      }
      throw error;
    }
  }

  // ─── Lifecycle ───

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  terminate(): void {
    this.abort();
    this.state = 'terminated';
    this.abortController = null;
  }

  hasSession(): boolean {
    return this.sessionId !== null;
  }

  clearHistory(): void {
    this.history = [];
  }

  // ─── Internal ───

  private async executePrompt(
    prompt: string,
    onChunk?: (chunk: string) => void,
  ): Promise<CliExecuteResult> {
    const defaultProvider = getDefaultProvider();
    if (!defaultProvider) {
      throw new Error('No default provider configured');
    }

    const options: CliExecuteOptions = {
      prompt,
      model: this.agent.modelId,
      workingDirectory: this.projectDirectory,
      outputFormat: 'text',
    };

    if (this.sessionId) {
      options.resumeSessionId = this.sessionId;
    }

    if (this.mcpConfigPath) {
      options.mcpConfig = this.mcpConfigPath;
    }

    const chunkHandler = onChunk
      ? (chunk: string) => { onChunk(chunk); }
      : undefined;

    if (chunkHandler) {
      return this.cliExecutor.executeStreaming(
        this.agent.providerId,
        options,
        chunkHandler,
        this.abortController?.signal,
      );
    }

    return this.cliExecutor.execute(this.agent.providerId, options);
  }
}
