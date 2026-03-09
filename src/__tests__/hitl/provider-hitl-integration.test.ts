import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from 'bun:test';
import { initDatabase, getDb } from '../../db/index';
import { insertProvider } from '../../db/provider-repo';
import { insertSession } from '../../db/terminal-repo';
import { AnthropicApiProvider } from '../../terminal/provider/anthropic-api-provider';
import type { HitlDeps } from '../../terminal/provider/anthropic-api-provider';
import { ProviderRegistry } from '../../terminal/provider/registry';
import { InteractionStore } from '../../hitl/interaction-store';
import { InteractionGate } from '../../hitl/interaction-gate';
import { DEFAULT_AUTONOMY_CONFIG } from '../../hitl/default-config';
import type { Provider } from '../../types/provider';
import type { TerminalSession } from '../../types/terminal';

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
    apiKey: 'sk-test-key-hitl',
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
    projectId: 'proj-hitl',
    agentId: 'agent-hitl',
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

beforeAll(async () => {
  process.env.MARS_DB_PATH = ':memory:';
  initDatabase();
  store = new InteractionStore({ db: getDb(), dataDir: '/tmp/mars-test-hitl-2' });
  await store.initialize();
});

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM providers');
  db.exec('DELETE FROM terminal_sessions');
  db.exec('DELETE FROM terminal_messages');
  db.exec('DELETE FROM interactions');
  db.exec('DELETE FROM agents');
  db.exec('DELETE FROM mcp_servers');

  gate = new InteractionGate({ store, config: DEFAULT_AUTONOMY_CONFIG });
  hitlDeps = {
    interactionGate: gate,
    runContext: { runId: 'run-hitl-test', agentId: 'agent-hitl', sessionId: 'ses-hitl' },
  };
});

afterEach(() => {
  gate.dispose();
});

describe('AnthropicApiProvider HITL integration', () => {
  it('constructor without hitlDeps creates provider with correct identity', () => {
    const provider = new AnthropicApiProvider('prov-no-hitl');
    expect(provider.id).toBe('prov-no-hitl');
    expect(provider.name).toBe('Anthropic API');
  });

  it('constructor with hitlDeps creates provider with correct identity', () => {
    const provider = new AnthropicApiProvider('prov-with-hitl', hitlDeps);
    expect(provider.id).toBe('prov-with-hitl');
    expect(provider.name).toBe('Anthropic API');
  });

  it('sendMessage passes tools and maxSteps when hitlDeps provided', async () => {
    insertProvider(makeProvider('prov-tools'));
    insertSession(makeSession('ses-tools'));

    let capturedOpts: Record<string, unknown> = {};

    mock.module('ai', () => ({
      streamText: (opts: Record<string, unknown>) => {
        capturedOpts = opts;
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
      },
      tool: (def: unknown) => def,
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import(
      '../../terminal/provider/anthropic-api-provider'
    );
    const provider = new FreshProvider('prov-tools', hitlDeps);
    const events = [];

    for await (const event of provider.sendMessage({
      message: 'test with tools',
      sessionId: 'ses-tools',
      workingDirectory: '/tmp',
    })) {
      events.push(event);
    }

    expect(capturedOpts.tools).toBeDefined();
    expect(capturedOpts.maxSteps).toBe(25);
  });

  it('sendMessage does NOT pass tools when hitlDeps absent', async () => {
    insertProvider(makeProvider('prov-no-tools'));
    insertSession(makeSession('ses-no-tools'));

    let capturedOpts: Record<string, unknown> = {};

    mock.module('ai', () => ({
      streamText: (opts: Record<string, unknown>) => {
        capturedOpts = opts;
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
      },
      tool: (def: unknown) => def,
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import(
      '../../terminal/provider/anthropic-api-provider'
    );
    const provider = new FreshProvider('prov-no-tools');
    const events = [];

    for await (const event of provider.sendMessage({
      message: 'test without tools',
      sessionId: 'ses-no-tools',
      workingDirectory: '/tmp',
    })) {
      events.push(event);
    }

    expect(capturedOpts.tools).toBeUndefined();
    expect(capturedOpts.maxSteps).toBeUndefined();
  });

  it('tool definition has correct shape when hitlDeps provided', async () => {
    insertProvider(makeProvider('prov-shape'));
    insertSession(makeSession('ses-shape'));

    let capturedTools: Record<string, unknown> | undefined;

    mock.module('ai', () => ({
      streamText: (opts: Record<string, unknown>) => {
        capturedTools = opts.tools as Record<string, unknown> | undefined;
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
      },
      tool: (def: unknown) => def,
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import(
      '../../terminal/provider/anthropic-api-provider'
    );
    const provider = new FreshProvider('prov-shape', hitlDeps);

    for await (const _event of provider.sendMessage({
      message: 'test shape',
      sessionId: 'ses-shape',
      workingDirectory: '/tmp',
    })) {
      void _event;
    }

    expect(capturedTools).toBeDefined();
    const toolDef = capturedTools as Record<string, unknown>;
    expect(toolDef.mars_request_input).toBeDefined();
    const marsToolRaw = toolDef.mars_request_input as Record<string, unknown>;
    expect(marsToolRaw.description).toBeDefined();
    expect(typeof marsToolRaw.description).toBe('string');
    expect(marsToolRaw.execute).toBeDefined();
    expect(typeof marsToolRaw.execute).toBe('function');
  });
});

describe('ProviderRegistry HITL integration', () => {
  it('registry.get with hitlDeps skips cache', () => {
    insertProvider(makeProvider('prov-cache-skip'));

    const registry = new ProviderRegistry();
    const p1 = registry.get('prov-cache-skip');
    const p2 = registry.get('prov-cache-skip');
    expect(p1).toBe(p2);

    const p3 = registry.get('prov-cache-skip', hitlDeps);
    expect(p3).not.toBe(p1);
  });

  it('registry.get with hitlDeps returns AnthropicApiProvider', () => {
    insertProvider(makeProvider('prov-hitl-type'));

    const registry = new ProviderRegistry();
    const provider = registry.get('prov-hitl-type', hitlDeps);
    expect(provider.name).toBe('Anthropic API');
  });

  it('registry.get without hitlDeps on useDirectApi=true uses cache', () => {
    insertProvider(makeProvider('prov-cached'));

    const registry = new ProviderRegistry();
    const p1 = registry.get('prov-cached');
    const p2 = registry.get('prov-cached');
    expect(p1).toBe(p2);
  });

  it('registry.getForAgent with hitlDeps creates non-cached enriched provider', () => {
    insertProvider(makeProvider('prov-agent-hitl'));

    const db = getDb();
    db.exec(`
      INSERT INTO agents (id, name, provider_id, model_id, system_prompt, reasoning_level, mcp_server_ids, enabled, created_at, updated_at)
      VALUES ('agent-hitl', 'HITL Agent', 'prov-agent-hitl', 'claude-sonnet', 'Be helpful', 'none', '[]', 1, ${now}, ${now})
    `);

    const registry = new ProviderRegistry();
    const p1 = registry.getForAgent('agent-hitl', hitlDeps);
    const p2 = registry.getForAgent('agent-hitl', hitlDeps);
    expect(p1).not.toBe(p2);
  });

  it('registry.get with ClaudeCliProvider ignores hitlDeps', () => {
    insertProvider(makeProvider('prov-cli-hitl', { config: { useDirectApi: false } }));

    const registry = new ProviderRegistry();
    const provider = registry.get('prov-cli-hitl', hitlDeps);
    expect(provider.name).toBe('Claude CLI');
  });
});
