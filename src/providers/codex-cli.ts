import type { ICliExecutor, CliExecuteOptions, CliExecuteResult, ProviderConnectionResult, ProviderConfig } from '../types/provider';
import { getProviderById } from '../db/provider-repo';
import { buildCodexMcpFlags } from '../terminal/provider/mcp-config-writer';

type CodexJsonEvent = {
  type?: string;
  item?: {
    type?: string;
    text?: string;
  };
};

export class CodexCliExecutor implements ICliExecutor {
  private defaultCliPath = '/usr/local/bin/codex';

  private resolveCliPath(providerId: string): string {
    const provider = getProviderById(providerId);
    if (!provider) {
      throw new Error('Provider not found');
    }

    return provider.config.cliPath ?? this.defaultCliPath;
  }

  private buildArgs(options: CliExecuteOptions, config: ProviderConfig): string[] {
    const args: string[] = ['exec', '--skip-git-repo-check', '--json'];

    const model = options.model ?? config.defaultModel;
    if (model) {
      args.push('--model', model);
    }

    if (options.workingDirectory) {
      args.push('--cd', options.workingDirectory);
      args.push('--add-dir', options.workingDirectory);
    }

    const permissionMode = options.permissionMode ?? config.permissionMode;
    if (permissionMode === 'bypassPermissions') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (permissionMode === 'plan') {
      args.push('--sandbox', 'read-only');
    } else {
      args.push('--full-auto');
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
      args.push(...buildCodexMcpFlags(options.mcpConfig));
    }

    let prompt = '';
    if (options.systemPrompt) {
      prompt += options.systemPrompt + '\n\n---\n\n';
    }
    prompt += options.prompt;
    args.push(prompt);
    return args;
  }

  private extractMessage(output: string): string {
    const lines = output.split('\n').filter(Boolean);
    const texts: string[] = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as CodexJsonEvent;
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          texts.push(event.item.text);
        }
      } catch {
        continue;
      }
    }
    return texts.join('\n\n').trim();
  }

  async execute(providerId: string, options: CliExecuteOptions): Promise<CliExecuteResult> {
    const cliPath = this.resolveCliPath(providerId);
    const provider = getProviderById(providerId);
    if (!provider) {
      throw new Error('Provider not found');
    }

    const args = this.buildArgs(options, provider.config);
    const startTime = Date.now();
    const proc = Bun.spawn([cliPath, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...options.env, CI: 'true' },
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return {
      success: exitCode === 0,
      output: this.extractMessage(stdout),
      exitCode,
      durationMs: Date.now() - startTime,
      error: stderr || undefined,
    };
  }

  async executeStreaming(providerId: string, options: CliExecuteOptions, onChunk: (chunk: string) => void, signal?: AbortSignal): Promise<CliExecuteResult> {
    const cliPath = this.resolveCliPath(providerId);
    const provider = getProviderById(providerId);
    if (!provider) {
      throw new Error('Provider not found');
    }

    const args = this.buildArgs(options, provider.config);
    const startTime = Date.now();
    const proc = Bun.spawn([cliPath, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...options.env, CI: 'true' },
    });

    if (signal) {
      const onAbort = () => { try { proc.kill(); } catch {} };
      if (signal.aborted) { onAbort(); }
      else { signal.addEventListener('abort', onAbort, { once: true }); }
    }

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        chunks.push(text);
        for (const line of text.split('\n').filter(Boolean)) {
          try {
            const event = JSON.parse(line) as CodexJsonEvent;
            if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
              onChunk(event.item.text);
            }
          } catch {
            continue;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const fullOutput = chunks.join('');

    return {
      success: exitCode === 0,
      output: this.extractMessage(fullOutput),
      exitCode,
      durationMs: Date.now() - startTime,
      error: stderr || undefined,
    };
  }

  async checkHealth(providerId: string): Promise<ProviderConnectionResult> {
    const cliPath = this.resolveCliPath(providerId);
    const startTime = Date.now();
    const versionProc = Bun.spawn([cliPath, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const versionErr = await new Response(versionProc.stderr).text();
    const versionExit = await versionProc.exited;
    const latencyMs = Date.now() - startTime;

    if (versionExit !== 0) {
      return { success: false, latencyMs, error: versionErr || 'Codex CLI check failed' };
    }

    const authStatus = await this.getAuthStatus();
    return {
      success: authStatus?.loggedIn ?? false,
      latencyMs,
      authStatus,
      ...(authStatus?.loggedIn ? {} : { error: 'Codex CLI is not authenticated' }),
    };
  }

  async getAuthStatus(): Promise<ProviderConnectionResult['authStatus']> {
    const proc = Bun.spawn([this.defaultCliPath, 'login', 'status'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode === 0 && `${stdout}\n${stderr}`.includes('Logged in')) {
      return { loggedIn: true, authMethod: 'oauth' };
    }

    return { loggedIn: false, authMethod: 'unknown' };
  }
}
