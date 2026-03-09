import type { LLMProvider, ProviderRequest, ProviderEvent } from './types';
import { CliStreamParser } from '../cli-stream-parser';
import { getProviderById } from '../../db/provider-repo';
import type { WsServerMessage } from '../../types/terminal';

export class ClaudeCliProvider implements LLMProvider {
  readonly id: string;
  readonly name: string = 'Claude CLI';
  private processes: Map<string, ReturnType<typeof Bun.spawn>> = new Map();

  constructor(providerId: string) {
    this.id = providerId;
  }

  async *sendMessage(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const provider = getProviderById(this.id);
    if (!provider) {
      yield { type: 'error', message: 'Provider not found' };
      return;
    }

    const cliPath = provider.config.cliPath ?? '/Users/mk-mac-391/.claude/local/claude';
    const args = this.buildArgs(request, provider.config);
    const startTime = Date.now();

    const proc = Bun.spawn([cliPath, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: request.workingDirectory,
      env: { ...process.env, ...request.env },
    });

    this.processes.set(request.sessionId, proc);

    try {
      const eventQueue: ProviderEvent[] = [];

      const onParserEvent = (wsMsg: WsServerMessage) => {
        if (wsMsg.type === 'content_delta') {
          eventQueue.push({ type: 'text_delta', content: wsMsg.delta });
        } else if (wsMsg.type === 'reasoning_delta') {
          eventQueue.push({ type: 'thinking_delta', content: wsMsg.delta });
        } else if (wsMsg.type === 'tool_use_start') {
          eventQueue.push({
            type: 'tool_use_start',
            toolName: wsMsg.toolName,
            toolId: wsMsg.toolId,
          });
        } else if (wsMsg.type === 'tool_use_delta') {
          eventQueue.push({
            type: 'tool_use_delta',
            toolId: wsMsg.toolId,
            content: wsMsg.delta,
          });
        } else if (wsMsg.type === 'tool_result') {
          eventQueue.push({
            type: 'tool_result',
            toolId: wsMsg.toolId,
            output: wsMsg.result,
          });
        }
      };

      const parser = new CliStreamParser(request.sessionId, onParserEvent);

      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        parser.processChunk(chunk);

        while (eventQueue.length > 0) {
          const event = eventQueue.shift();
          if (event) yield event;
        }
      }

      parser.flush();
      while (eventQueue.length > 0) {
        const event = eventQueue.shift();
        if (event) yield event;
      }

      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      const durationMs = Date.now() - startTime;

      if (exitCode !== 0) {
        yield {
          type: 'error',
          message: stderr || `Process exited with code ${exitCode}`,
        };
      }

      yield {
        type: 'complete',
        metadata: {
          sessionId: parser.getCliSessionId() ?? undefined,
          durationMs,
          isError: exitCode !== 0,
        },
      };
    } finally {
      this.processes.delete(request.sessionId);
    }
  }

  private buildArgs(request: ProviderRequest, config: any): string[] {
    const args: string[] = ['-p', request.message, '--print', '--output-format', 'stream-json'];

    const model = request.model ?? config.defaultModel;
    if (model) {
      args.push('--model', model);
    }

    if (request.systemContext) {
      args.push('--system-prompt', request.systemContext);
    }

    const maxBudget = request.maxBudgetUsd ?? config.maxBudgetUsd;
    if (maxBudget) {
      args.push('--max-budget-usd', String(maxBudget));
    }

    const permissionMode = request.permissionMode ?? config.permissionMode;
    if (permissionMode) {
      args.push('--permission-mode', permissionMode);
    }

    if (request.allowedTools) {
      for (const tool of request.allowedTools) {
        args.push('--allowedTools', tool);
      }
    }

    if (request.disallowedTools) {
      for (const tool of request.disallowedTools) {
        args.push('--disallowedTools', tool);
      }
    }

    if (request.mcpConfigPath) {
      args.push('--mcp-config', request.mcpConfigPath);
    }

    if (request.continueSession) {
      args.push('--resume', '--session-id', request.continueSession);
    }

    if (request.workingDirectory) {
      args.push('--add-dir', request.workingDirectory);
    }

    return args;
  }

  abort(sessionId: string): void {
    const proc = this.processes.get(sessionId);
    if (proc) {
      proc.kill('SIGTERM');
      this.processes.delete(sessionId);
    }
  }

  async isAvailable(): Promise<boolean> {
    const provider = getProviderById(this.id);
    if (!provider) return false;

    const cliPath = provider.config.cliPath ?? '/Users/mk-mac-391/.claude/local/claude';

    const proc = Bun.spawn([cliPath, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    return exitCode === 0;
  }
}
