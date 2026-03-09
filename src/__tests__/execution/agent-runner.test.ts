import { describe, expect, it } from 'bun:test';
import { AgentRunner } from '../../execution/agent-runner';
import { SessionManager } from '../../execution/session-manager';
import type { AgentContext, RunnerCallbacks } from '../../execution/types';
import type { CliExecuteOptions, CliExecuteResult, ICliExecutor, ProviderConnectionResult } from '../../types/provider';
import type { Agent } from '../../types/agent';
import type { McpServer } from '../../types/mcp-server';
import type { Task } from '../../types/task';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = Date.now();
  return {
    id: overrides.id ?? 'agent-1',
    name: overrides.name ?? 'Agent',
    description: overrides.description ?? '',
    providerId: overrides.providerId ?? 'provider-1',
    modelId: overrides.modelId ?? 'model-1',
    systemPrompt: overrides.systemPrompt ?? 'system prompt',
    reasoningLevel: overrides.reasoningLevel ?? 'none',
    workerCount: overrides.workerCount ?? 1,
    skillIds: overrides.skillIds ?? [],
    mcpServerIds: overrides.mcpServerIds ?? [],
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: overrides.id ?? 'task-1',
    projectId: overrides.projectId ?? 'proj-1',
    parentTaskId: overrides.parentTaskId ?? null,
    title: overrides.title ?? 'Task title',
    description: overrides.description ?? 'Task description',
    status: overrides.status ?? 'ready',
    priority: overrides.priority ?? 'medium',
    order: overrides.order ?? 0,
    assignedAgentType: overrides.assignedAgentType ?? null,
    assignedAgentId: overrides.assignedAgentId ?? null,
    dependsOnTaskIds: overrides.dependsOnTaskIds ?? [],
    acceptanceCriteria: overrides.acceptanceCriteria ?? [],
    expectedOutputs: overrides.expectedOutputs ?? [],
    maxRetries: overrides.maxRetries ?? 2,
    retryCount: overrides.retryCount ?? 0,
    reviewFeedback: overrides.reviewFeedback ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function makeServer(overrides: Partial<McpServer> & { id: string; name: string }): McpServer {
  const now = Date.now();
  return {
    id: overrides.id,
    name: overrides.name,
    description: overrides.description ?? '',
    transportType: overrides.transportType ?? 'stdio',
    command: overrides.command ?? 'node',
    args: overrides.args ?? ['server.js'],
    url: overrides.url ?? null,
    headers: overrides.headers ?? {},
    env: overrides.env ?? {},
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    agent: overrides.agent ?? makeAgent(),
    task: overrides.task ?? makeTask(),
    systemPrompt: overrides.systemPrompt ?? 'system prompt',
    tools: overrides.tools ?? [],
    memory: overrides.memory ?? '',
    priorResults: overrides.priorResults ?? [],
    workingDirectory: overrides.workingDirectory ?? '/tmp/project',
    orchestrationBrief: overrides.orchestrationBrief ?? null,
    mcpServerIds: overrides.mcpServerIds ?? [],
    mcpServers: overrides.mcpServers ?? [],
  };
}

function createExecutor(
  onStreamingCall: (providerId: string, options: CliExecuteOptions) => void,
): ICliExecutor {
  const result: CliExecuteResult = {
    success: true,
    output: JSON.stringify({ result: 'done', files_modified: [] }),
    exitCode: 0,
    durationMs: 5,
  };
  const authStatus: ProviderConnectionResult['authStatus'] = {
    loggedIn: true,
    authMethod: 'api_key',
  };

  return {
    execute: async (): Promise<CliExecuteResult> => result,
    executeStreaming: async (
      providerId: string,
      options: CliExecuteOptions,
      onChunk: (chunk: string) => void,
    ): Promise<CliExecuteResult> => {
      onStreamingCall(providerId, options);
      onChunk('processing');
      return result;
    },
    checkHealth: async (): Promise<ProviderConnectionResult> => ({ success: true, latencyMs: 1, authStatus }),
    getAuthStatus: async (): Promise<ProviderConnectionResult['authStatus']> => authStatus,
  };
}

function createCallbacks(): RunnerCallbacks {
  return {
    onStart: () => {},
    onChunk: () => {},
    onToolUse: () => {},
    onComplete: () => {},
    onError: () => {},
  };
}

describe('AgentRunner', () => {
  it('sets mcpConfig when resolved MCP servers exist and preserves allowedTools', async () => {
    const calls: CliExecuteOptions[] = [];
    const runner = new AgentRunner(new SessionManager(), createExecutor((_providerId, options) => {
      calls.push(options);
    }));

    await runner.run(
      makeContext({
        mcpServerIds: ['server-1'],
        mcpServers: [makeServer({ id: 'server-1', name: 'github-mcp' })],
        tools: [
          { name: 'github-mcp', source: 'mcp', mcpServerId: 'server-1', enabled: true },
          { name: 'ignored-builtin', source: 'builtin', enabled: true },
        ],
      }),
      'exec-1',
      createCallbacks(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.allowedTools).toEqual(['github-mcp']);
    expect(calls[0]!.mcpConfig).toBeDefined();
  });

  it('leaves mcpConfig unset when no resolved MCP servers exist', async () => {
    const calls: CliExecuteOptions[] = [];
    const runner = new AgentRunner(new SessionManager(), createExecutor((_providerId, options) => {
      calls.push(options);
    }));

    await runner.run(
      makeContext({
        tools: [{ name: 'tool-without-server', source: 'mcp', mcpServerId: 'missing', enabled: true }],
        mcpServerIds: [],
        mcpServers: [],
      }),
      'exec-2',
      createCallbacks(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.allowedTools).toEqual(['tool-without-server']);
    expect(calls[0]!.mcpConfig).toBeUndefined();
  });
});
