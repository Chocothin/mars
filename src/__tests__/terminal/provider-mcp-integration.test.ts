import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from 'bun:test';
import { initDatabase, getDb } from '../../db/index';
import { insertProvider } from '../../db/provider-repo';
import { insertSession } from '../../db/terminal-repo';
import { insertMcpServer } from '../../db/mcp-server-repo';
import { InteractionStore } from '../../hitl/interaction-store';
import { InteractionGate } from '../../hitl/interaction-gate';
import { DEFAULT_AUTONOMY_CONFIG } from '../../hitl/default-config';
import type { HitlDeps } from '../../terminal/provider/anthropic-api-provider';
import type { Provider } from '../../types/provider';
import type { TerminalSession } from '../../types/terminal';
import type { McpServer } from '../../types/mcp-server';

const mockMcpTools = mock(() =>
  Promise.resolve({
    read_file: { description: 'Read a file', execute: async () => 'file content' },
    write_file: { description: 'Write a file', execute: async () => 'done' },
  }),
);

const mockClose = mock(() => Promise.resolve());

const mockCreateMCPClient = mock(() =>
  Promise.resolve({
    tools: mockMcpTools,
    close: mockClose,
  }),
);

mock.module('@ai-sdk/mcp', () => ({
  createMCPClient: mockCreateMCPClient,
}));

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: mock(function (this: unknown) {
    return {};
  }),
}));

const now = Date.now();

let store: InteractionStore;
let gate: InteractionGate;
let hitlDeps: HitlDeps;

function makeProvider(id: string, overrides?: Partial<Provider>): Provider {
  return {
    id,
    name: 'Test Provider',
    description: '',
    providerType: 'anthropic',
    authMethod: 'api_key',
    apiKey: 'sk-test-key-mcp',
    baseUrl: null,
    enabled: true,
    isDefault: false,
    config: { useDirectApi: true },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSession(id: string): TerminalSession {
  return {
    id,
    projectId: 'proj-mcp',
    agentId: 'agent-mcp',
    mcpServerIds: [],
    workingDirectory: '/tmp',
    status: 'idle',
    cliSessionId: null,
    restartRequired: false,
    restartReason: null,
    restartMarkedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeMcpServer(id: string, overrides?: Partial<McpServer>): McpServer {
  return {
    id,
    name: `server-${id}`,
    description: '',
    transportType: 'sse',
    command: null,
    args: [],
    url: 'http://localhost:3000/mcp',
    headers: {},
    env: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeStreamResult() {
  return {
    fullStream: (async function* () {
      yield {
        type: 'finish' as const,
        finishReason: 'stop' as const,
        usage: { promptTokens: 10, completionTokens: 5 },
        providerMetadata: undefined,
        experimental_providerMetadata: undefined,
        response: undefined,
        warnings: undefined,
        request: undefined,
        logprobs: undefined,
        rawResponse: undefined,
        isContinued: false,
      };
    })(),
    usage: Promise.resolve({ promptTokens: 10, completionTokens: 5 }),
    finishReason: Promise.resolve('stop'),
  };
}

beforeAll(async () => {
  process.env.MARS_DB_PATH = ':memory:';
  initDatabase();
  store = new InteractionStore({ db: getDb(), dataDir: '/tmp/mars-test-mcp' });
  await store.initialize();
});

beforeEach(async () => {
  const db = getDb();
  db.exec('DELETE FROM providers');
  db.exec('DELETE FROM terminal_sessions');
  db.exec('DELETE FROM terminal_messages');
  db.exec('DELETE FROM interactions');
  db.exec('DELETE FROM agents');
  db.exec('DELETE FROM mcp_servers');

  mockCreateMCPClient.mockClear();
  mockMcpTools.mockClear();
  mockClose.mockClear();

  const { mcpConnectionPool } = await import('../../mcp/pool');
  await mcpConnectionPool.invalidateAll();

  gate = new InteractionGate({ store, config: DEFAULT_AUTONOMY_CONFIG });
  hitlDeps = {
    interactionGate: gate,
    runContext: { runId: 'run-mcp-test', agentId: 'agent-mcp', sessionId: 'ses-mcp' },
  };
});

afterEach(() => {
  gate.dispose();
});

describe('AnthropicApiProvider MCP tool resolution', () => {
  it('mcpServerIds not provided → no MCP tools, no maxSteps', async () => {
    insertProvider(makeProvider('prov-mcp-1'));
    insertSession(makeSession('ses-mcp-1'));

    let capturedOpts: Record<string, unknown> = {};

    mock.module('ai', () => ({
      streamText: (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return makeStreamResult();
      },
      tool: (def: unknown) => def,
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import(
      '../../terminal/provider/anthropic-api-provider'
    );
    const provider = new FreshProvider('prov-mcp-1');

    for await (const _event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-mcp-1',
      workingDirectory: '/tmp',
    })) {
      void _event;
    }

    expect(capturedOpts.tools).toBeUndefined();
    expect(capturedOpts.maxSteps).toBeUndefined();
  });

  it('mcpServerIds with valid server IDs → MCP tools passed to streamText', async () => {
    insertProvider(makeProvider('prov-mcp-2'));
    insertSession(makeSession('ses-mcp-2'));

    const server = makeMcpServer('server-mcp-2');
    insertMcpServer(server);

    let capturedOpts: Record<string, unknown> = {};

    mock.module('ai', () => ({
      streamText: (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return makeStreamResult();
      },
      tool: (def: unknown) => def,
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import(
      '../../terminal/provider/anthropic-api-provider'
    );
    const provider = new FreshProvider('prov-mcp-2');

    for await (const _event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-mcp-2',
      workingDirectory: '/tmp',
      mcpServerIds: [server.id],
    })) {
      void _event;
    }

    expect(capturedOpts.tools).toBeDefined();
    expect(capturedOpts.maxSteps).toBe(25);
    const tools = capturedOpts.tools as Record<string, unknown>;
    expect(tools.read_file).toBeDefined();
    expect(tools.write_file).toBeDefined();
  });

  it('mcpServerIds with nonexistent server ID → graceful skip, no tools', async () => {
    insertProvider(makeProvider('prov-mcp-3'));
    insertSession(makeSession('ses-mcp-3'));

    let capturedOpts: Record<string, unknown> = {};

    mock.module('ai', () => ({
      streamText: (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return makeStreamResult();
      },
      tool: (def: unknown) => def,
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import(
      '../../terminal/provider/anthropic-api-provider'
    );
    const provider = new FreshProvider('prov-mcp-3');

    for await (const _event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-mcp-3',
      workingDirectory: '/tmp',
      mcpServerIds: ['nonexistent-server-id'],
    })) {
      void _event;
    }

    expect(capturedOpts.tools).toBeUndefined();
    expect(capturedOpts.maxSteps).toBeUndefined();
  });

  it('mcpServerIds with disabled server → filtered out, no tools', async () => {
    insertProvider(makeProvider('prov-mcp-4'));
    insertSession(makeSession('ses-mcp-4'));

    const server = makeMcpServer('server-mcp-4', { enabled: false });
    insertMcpServer(server);

    let capturedOpts: Record<string, unknown> = {};

    mock.module('ai', () => ({
      streamText: (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return makeStreamResult();
      },
      tool: (def: unknown) => def,
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import(
      '../../terminal/provider/anthropic-api-provider'
    );
    const provider = new FreshProvider('prov-mcp-4');

    for await (const _event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-mcp-4',
      workingDirectory: '/tmp',
      mcpServerIds: [server.id],
    })) {
      void _event;
    }

    expect(capturedOpts.tools).toBeUndefined();
    expect(capturedOpts.maxSteps).toBeUndefined();
  });

  it('mcpServerIds with mix of valid and invalid → only valid tools used', async () => {
    insertProvider(makeProvider('prov-mcp-5'));
    insertSession(makeSession('ses-mcp-5'));

    const server = makeMcpServer('server-mcp-5');
    insertMcpServer(server);

    let capturedOpts: Record<string, unknown> = {};

    mock.module('ai', () => ({
      streamText: (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return makeStreamResult();
      },
      tool: (def: unknown) => def,
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import(
      '../../terminal/provider/anthropic-api-provider'
    );
    const provider = new FreshProvider('prov-mcp-5');

    for await (const _event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-mcp-5',
      workingDirectory: '/tmp',
      mcpServerIds: [server.id, 'nonexistent-server-id'],
    })) {
      void _event;
    }

    expect(capturedOpts.tools).toBeDefined();
    expect(capturedOpts.maxSteps).toBe(25);
    const tools = capturedOpts.tools as Record<string, unknown>;
    expect(tools.read_file).toBeDefined();
    expect(tools.write_file).toBeDefined();
  });

  it('MCP tools merged with HITL tools when both present', async () => {
    insertProvider(makeProvider('prov-mcp-6'));
    insertSession(makeSession('ses-mcp-6'));

    const server = makeMcpServer('server-mcp-6');
    insertMcpServer(server);

    let capturedOpts: Record<string, unknown> = {};

    mock.module('ai', () => ({
      streamText: (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return makeStreamResult();
      },
      tool: (def: unknown) => def,
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import(
      '../../terminal/provider/anthropic-api-provider'
    );
    const provider = new FreshProvider('prov-mcp-6', hitlDeps);

    for await (const _event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-mcp-6',
      workingDirectory: '/tmp',
      mcpServerIds: [server.id],
    })) {
      void _event;
    }

    expect(capturedOpts.tools).toBeDefined();
    expect(capturedOpts.maxSteps).toBe(25);
    const tools = capturedOpts.tools as Record<string, unknown>;
    expect(tools.mars_request_input).toBeDefined();
    expect(tools.read_file).toBeDefined();
    expect(tools.write_file).toBeDefined();
  });

  it('HITL tools take precedence over MCP tools in merged toolset', async () => {
    insertProvider(makeProvider('prov-mcp-7'));
    insertSession(makeSession('ses-mcp-7'));

    const server = makeMcpServer('server-mcp-7');
    insertMcpServer(server);

    let capturedTools: Record<string, unknown> | undefined;

    mock.module('ai', () => ({
      streamText: (opts: Record<string, unknown>) => {
        capturedTools = opts.tools as Record<string, unknown> | undefined;
        return makeStreamResult();
      },
      tool: (def: unknown) => def,
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import(
      '../../terminal/provider/anthropic-api-provider'
    );
    const provider = new FreshProvider('prov-mcp-7', hitlDeps);

    for await (const _event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-mcp-7',
      workingDirectory: '/tmp',
      mcpServerIds: [server.id],
    })) {
      void _event;
    }

    expect(capturedTools).toBeDefined();
    const tools = capturedTools as Record<string, unknown>;
    const marsToolDef = tools.mars_request_input as Record<string, unknown>;
    expect(typeof marsToolDef.execute).toBe('function');
  });

  it('empty mcpServerIds array → no tools, no maxSteps', async () => {
    insertProvider(makeProvider('prov-mcp-8'));
    insertSession(makeSession('ses-mcp-8'));

    let capturedOpts: Record<string, unknown> = {};

    mock.module('ai', () => ({
      streamText: (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return makeStreamResult();
      },
      tool: (def: unknown) => def,
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import(
      '../../terminal/provider/anthropic-api-provider'
    );
    const provider = new FreshProvider('prov-mcp-8');

    for await (const _event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-mcp-8',
      workingDirectory: '/tmp',
      mcpServerIds: [],
    })) {
      void _event;
    }

    expect(capturedOpts.tools).toBeUndefined();
    expect(capturedOpts.maxSteps).toBeUndefined();
  });

  it('MCP tools not fetched when all serverIds map to disabled servers', async () => {
    insertProvider(makeProvider('prov-mcp-9'));
    insertSession(makeSession('ses-mcp-9'));

    const server1 = makeMcpServer('server-mcp-9a', { enabled: false });
    const server2 = makeMcpServer('server-mcp-9b', { enabled: false });
    insertMcpServer(server1);
    insertMcpServer(server2);

    let capturedOpts: Record<string, unknown> = {};

    mock.module('ai', () => ({
      streamText: (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return makeStreamResult();
      },
      tool: (def: unknown) => def,
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import(
      '../../terminal/provider/anthropic-api-provider'
    );
    const provider = new FreshProvider('prov-mcp-9');

    for await (const _event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-mcp-9',
      workingDirectory: '/tmp',
      mcpServerIds: [server1.id, server2.id],
    })) {
      void _event;
    }

    expect(capturedOpts.tools).toBeUndefined();
    expect(capturedOpts.maxSteps).toBeUndefined();
    expect(mockCreateMCPClient).not.toHaveBeenCalled();
  });

  it('MCP createMCPClient called once per unique server connection', async () => {
    insertProvider(makeProvider('prov-mcp-10'));
    insertSession(makeSession('ses-mcp-10'));

    const server = makeMcpServer('server-mcp-10');
    insertMcpServer(server);

    mock.module('ai', () => ({
      streamText: (opts: Record<string, unknown>) => {
        void opts;
        return makeStreamResult();
      },
      tool: (def: unknown) => def,
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import(
      '../../terminal/provider/anthropic-api-provider'
    );
    const provider = new FreshProvider('prov-mcp-10');

    for await (const _event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-mcp-10',
      workingDirectory: '/tmp',
      mcpServerIds: [server.id],
    })) {
      void _event;
    }

    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
  });
});
