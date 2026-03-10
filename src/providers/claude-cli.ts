import type { ICliExecutor, CliExecuteOptions, CliExecuteResult, ProviderConnectionResult, ProviderConfig } from '../types/provider';
import { getProviderById } from '../db/provider-repo';
import { buildCodexMcpFlags } from '../terminal/provider/mcp-config-writer';

export class ClaudeCliExecutor implements ICliExecutor {
  private defaultCliPath = '/Users/mk-mac-391/.claude/local/claude';

  private resolveCliPath(providerId: string): string {
    const provider = getProviderById(providerId);
    if (!provider) {
      throw new Error('Provider not found');
    }

    if (provider.config.cliPath) return provider.config.cliPath;

    return provider.providerType === 'openai'
      ? '/usr/local/bin/codex'
      : this.defaultCliPath;
  }

  private buildArgs(options: CliExecuteOptions, config: ProviderConfig): string[] {
    const args: string[] = ['-p', options.prompt, '--print', '--output-format', options.outputFormat ?? 'json'];

    const model = options.model ?? config.defaultModel;
    if (model) {
      args.push('--model', model);
    }

    if (options.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt);
    }

    const maxBudget = options.maxBudgetUsd ?? config.maxBudgetUsd;
    if (maxBudget) {
      args.push('--max-budget-usd', String(maxBudget));
    }

    const permissionMode = options.permissionMode ?? config.permissionMode;
    if (permissionMode) {
      args.push('--permission-mode', permissionMode);
    }

    if (options.allowedTools) {
      for (const tool of options.allowedTools) {
        args.push('--allowedTools', tool);
      }
    }

    if (options.disallowedTools) {
      for (const tool of options.disallowedTools) {
        args.push('--disallowedTools', tool);
      }
    }

    if (options.mcpConfig) {
      args.push('--mcp-config', options.mcpConfig);
    }

    if (options.continueSession) {
      args.push('--continue');
    }

    if (options.resumeSessionId) {
      args.push('--resume', '--session-id', options.resumeSessionId);
    }

    if (options.workingDirectory) {
      args.push('--add-dir', options.workingDirectory);
    }

    if (config.customArgs) {
      args.push(...config.customArgs);
    }

    if (options.additionalArgs) {
      args.push(...options.additionalArgs);
    }

    return args;
  }

  private buildCodexArgs(options: CliExecuteOptions, config: ProviderConfig): string[] {
    const isResume = !!options.resumeSessionId;
    const args: string[] = isResume ? ['exec', 'resume'] : ['exec'];

    if (isResume) {
      args.push(options.resumeSessionId!);
    }

    const model = options.model ?? config.defaultModel;
    if (model) {
      args.push('-m', model);
    }

    args.push('--json');

    if (!isResume) {
      if (options.workingDirectory) {
        args.push('-C', options.workingDirectory);
      }

      const permissionMode = options.permissionMode ?? config.permissionMode;
      if (permissionMode === 'bypassPermissions') {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      } else {
        args.push('--full-auto');
      }
    } else {
      args.push('--full-auto');
    }

    if (options.mcpConfig) {
      args.push(...buildCodexMcpFlags(options.mcpConfig));
    }

    if (config.customArgs) {
      args.push(...config.customArgs);
    }
    if (options.additionalArgs) {
      args.push(...options.additionalArgs);
    }

    let prompt = '';
    if (options.systemPrompt) {
      prompt += options.systemPrompt + '\n\n---\n\n';
    }
    prompt += options.prompt;
    args.push(prompt);

    return args;
  }

  async execute(providerId: string, options: CliExecuteOptions): Promise<CliExecuteResult> {
    const cliPath = this.resolveCliPath(providerId);
    const provider = getProviderById(providerId);
    if (!provider) {
      throw new Error('Provider not found');
    }

    const isCodex = provider.providerType === 'openai';
    const args = isCodex
      ? this.buildCodexArgs(options, provider.config)
      : this.buildArgs(options, provider.config);
    const startTime = Date.now();

    const proc = Bun.spawn([cliPath, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...options.env },
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    const output = isCodex ? this.extractCodexOutput(stdout) : stdout;
    const sessionId = isCodex ? this.extractCodexSessionId(stdout) : this.extractClaudeSessionId(stdout);

    return {
      success: exitCode === 0,
      output,
      exitCode,
      durationMs: Date.now() - startTime,
      error: stderr || undefined,
      sessionId,
    };
  }

  private extractClaudeSessionId(output: string): string | undefined {
    try {
      const parsed = JSON.parse(output);
      return parsed.session_id;
    } catch {
      return undefined;
    }
  }

  private extractCodexOutput(ndjson: string): string {
    const messages: string[] = [];
    for (const line of ndjson.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          messages.push(event.item.text);
        }
      } catch {
        continue;
      }
    }
    return messages.join('\n');
  }

  private extractCodexSessionId(ndjson: string): string | undefined {
    for (const line of ndjson.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event.type === 'thread.started' && event.thread_id) {
          return event.thread_id;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  async executeStreaming(providerId: string, options: CliExecuteOptions, onChunk: (chunk: string) => void, signal?: AbortSignal): Promise<CliExecuteResult> {
    const cliPath = this.resolveCliPath(providerId);
    const provider = getProviderById(providerId);
    if (!provider) {
      throw new Error('Provider not found');
    }

    const isCodex = provider.providerType === 'openai';
    const args = isCodex
      ? this.buildCodexArgs(options, provider.config)
      : this.buildArgs({ ...options, outputFormat: 'stream-json' }, provider.config);
    const startTime = Date.now();

    const proc = Bun.spawn([cliPath, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...options.env },
    });

    // Kill process when abort signal fires
    if (signal) {
      const onAbort = () => { try { proc.kill(); } catch {} };
      if (signal.aborted) { onAbort(); }
      else { signal.addEventListener('abort', onAbort, { once: true }); }
    }

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let fullOutput = '';
    let lineBuffer = '';
    let streamSessionId: string | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      fullOutput += text;

      if (isCodex) {
        lineBuffer += text;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
              onChunk(event.item.text);
            }
            if (event.type === 'thread.started' && event.thread_id) {
              streamSessionId = event.thread_id;
            }
          } catch { continue; }
        }
      } else {
        onChunk(text);
      }
    }

    if (isCodex && lineBuffer.trim()) {
      try {
        const event = JSON.parse(lineBuffer.trim());
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          onChunk(event.item.text);
        }
        if (event.type === 'thread.started' && event.thread_id) {
          streamSessionId = event.thread_id;
        }
      } catch {}
    }

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    const output = isCodex ? this.extractCodexOutput(fullOutput) : fullOutput;
    const sessionId = streamSessionId
      ?? (isCodex ? this.extractCodexSessionId(fullOutput) : this.extractClaudeSessionId(fullOutput));

    return {
      success: exitCode === 0,
      output,
      exitCode,
      durationMs: Date.now() - startTime,
      error: stderr || undefined,
      sessionId,
    };
  }

  async checkHealth(providerId: string): Promise<ProviderConnectionResult> {
    const cliPath = this.resolveCliPath(providerId);
    const startTime = Date.now();

    const proc = Bun.spawn([cliPath, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const latencyMs = Date.now() - startTime;

    if (exitCode === 0) {
      const authStatus = await this.getAuthStatus();
      return {
        success: true,
        latencyMs,
        authStatus,
      };
    }

    return {
      success: false,
      latencyMs,
      error: stderr || 'CLI check failed',
    };
  }

  async getAuthStatus(): Promise<ProviderConnectionResult['authStatus']> {
    const proc = Bun.spawn([this.defaultCliPath, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;

    if (exitCode === 0) {
      return { loggedIn: true, authMethod: 'oauth' };
    }

    return { loggedIn: false, authMethod: 'unknown' };
  }
}
