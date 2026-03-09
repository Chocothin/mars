import type { LLMProvider, ProviderRequest, ProviderEvent } from './types';
import { CodexCliExecutor } from '../../providers/codex-cli';

const executor = new CodexCliExecutor();

export class CodexCliProvider implements LLMProvider {
  readonly id: string;
  readonly name: string = 'Codex CLI';

  constructor(providerId: string) {
    this.id = providerId;
  }

  async *sendMessage(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const result = await executor.execute(this.id, {
      prompt: request.message,
      model: request.model,
      workingDirectory: request.workingDirectory,
      env: request.env,
      mcpConfig: request.mcpConfigPath,
    });

    if (result.output) {
      yield { type: 'text_delta', content: result.output };
    }

    if (!result.success) {
      yield { type: 'error', message: result.error || `Process exited with code ${result.exitCode}` };
    }

    yield {
      type: 'complete',
      metadata: {
        durationMs: result.durationMs,
        isError: !result.success,
      },
    };
  }

  abort(_sessionId: string): void {}

  async isAvailable(): Promise<boolean> {
    const health = await executor.checkHealth(this.id);
    return health.success;
  }
}
