import { describe, it, expect, beforeAll, beforeEach, mock } from 'bun:test';
import { initDatabase, getDb } from '../../db/index';
import { insertProvider } from '../../db/provider-repo';
import { insertSession, insertMessage } from '../../db/terminal-repo';
import { AnthropicApiProvider } from '../../terminal/provider/anthropic-api-provider';
import { convertToModelMessages } from '../../terminal/provider/message-converter';
import { ProviderRegistry } from '../../terminal/provider/registry';
import type { Provider } from '../../types/provider';
import type { TerminalSession, TerminalMessage } from '../../types/terminal';

const now = Date.now();

describe('message-converter', () => {
  it('returns empty array for empty input', () => {
    const result = convertToModelMessages([]);
    expect(result).toEqual([]);
  });

  it('converts user messages', () => {
    const messages: TerminalMessage[] = [
      {
        id: 'msg-1',
        sessionId: 'ses-1',
        role: 'user',
        type: 'text',
        content: 'Hello',
        metadata: null,
        createdAt: now,
      },
    ];
    const result = convertToModelMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('converts assistant text messages', () => {
    const messages: TerminalMessage[] = [
      {
        id: 'msg-2',
        sessionId: 'ses-1',
        role: 'assistant',
        type: 'text',
        content: 'Hi there',
        metadata: null,
        createdAt: now,
      },
    ];
    const result = convertToModelMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'assistant', content: 'Hi there' });
  });

  it('converts assistant reasoning messages', () => {
    const messages: TerminalMessage[] = [
      {
        id: 'msg-3',
        sessionId: 'ses-1',
        role: 'assistant',
        type: 'reasoning',
        content: 'Let me think',
        metadata: null,
        createdAt: now,
      },
    ];
    const result = convertToModelMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'assistant', content: 'Let me think' });
  });

  it('skips system messages', () => {
    const messages: TerminalMessage[] = [
      {
        id: 'msg-4',
        sessionId: 'ses-1',
        role: 'system',
        type: 'text',
        content: 'System message',
        metadata: null,
        createdAt: now,
      },
      {
        id: 'msg-5',
        sessionId: 'ses-1',
        role: 'user',
        type: 'text',
        content: 'User message',
        metadata: null,
        createdAt: now,
      },
    ];
    const result = convertToModelMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe('user');
  });

  it('skips assistant tool_use messages', () => {
    const messages: TerminalMessage[] = [
      {
        id: 'msg-6',
        sessionId: 'ses-1',
        role: 'assistant',
        type: 'tool_use',
        content: 'Tool call',
        metadata: null,
        createdAt: now,
      },
      {
        id: 'msg-7',
        sessionId: 'ses-1',
        role: 'assistant',
        type: 'text',
        content: 'Text response',
        metadata: null,
        createdAt: now,
      },
    ];
    const result = convertToModelMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe('Text response');
  });
});

describe('AnthropicApiProvider', () => {
  beforeAll(() => {
    process.env.MARS_DB_PATH = ':memory:';
    initDatabase();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM providers');
    db.exec('DELETE FROM terminal_sessions');
    db.exec('DELETE FROM terminal_messages');
  });

  it('constructor sets id and name', () => {
    const provider = new AnthropicApiProvider('test-prov-1');
    expect(provider.id).toBe('test-prov-1');
    expect(provider.name).toBe('Anthropic API');
  });

  it('isAvailable returns false when provider not found', async () => {
    const provider = new AnthropicApiProvider('nonexistent');
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it('isAvailable returns false when apiKey is null', async () => {
    const testProvider: Provider = {
      id: 'test-prov-2',
      name: 'Test Provider',
      description: '',
      providerType: 'anthropic',
      authMethod: 'api_key',
      apiKey: null,
      baseUrl: null,
      enabled: true,
      isDefault: false,
      config: { useDirectApi: true },
      createdAt: now,
      updatedAt: now,
    };
    insertProvider(testProvider);

    const provider = new AnthropicApiProvider('test-prov-2');
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it('isAvailable returns true when provider exists with apiKey', async () => {
    const testProvider: Provider = {
      id: 'test-prov-3',
      name: 'Test Provider',
      description: '',
      providerType: 'anthropic',
      authMethod: 'api_key',
      apiKey: 'sk-test-key-123',
      baseUrl: null,
      enabled: true,
      isDefault: false,
      config: { useDirectApi: true },
      createdAt: now,
      updatedAt: now,
    };
    insertProvider(testProvider);

    const provider = new AnthropicApiProvider('test-prov-3');
    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it('sendMessage yields error when provider not found', async () => {
    const provider = new AnthropicApiProvider('nonexistent');
    const events = [];

    for await (const event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-1',
      workingDirectory: '/tmp',
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect(events[0]?.type === 'error' && events[0].message).toContain('Provider not found');
  });

  it('sendMessage yields error when apiKey missing', async () => {
    const testProvider: Provider = {
      id: 'test-prov-4',
      name: 'Test Provider',
      description: '',
      providerType: 'anthropic',
      authMethod: 'api_key',
      apiKey: null,
      baseUrl: null,
      enabled: true,
      isDefault: false,
      config: { useDirectApi: true },
      createdAt: now,
      updatedAt: now,
    };
    insertProvider(testProvider);

    const provider = new AnthropicApiProvider('test-prov-4');
    const events = [];

    for await (const event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-1',
      workingDirectory: '/tmp',
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect(events[0]?.type === 'error' && events[0].message).toContain('API key');
  });

  it('sendMessage yields text_delta events from mocked stream', async () => {
    const testProvider: Provider = {
      id: 'test-prov-5',
      name: 'Test Provider',
      description: '',
      providerType: 'anthropic',
      authMethod: 'api_key',
      apiKey: 'sk-test-key-123',
      baseUrl: null,
      enabled: true,
      isDefault: false,
      config: { useDirectApi: true },
      createdAt: now,
      updatedAt: now,
    };
    insertProvider(testProvider);

    const testSession: TerminalSession = {
      id: 'ses-1',
      projectId: 'proj-1',
      agentId: 'agent-1',
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
    insertSession(testSession);

    mock.module('ai', () => ({
      streamText: () => ({
        fullStream: (async function* () {
          yield { type: 'text-delta' as const, text: 'hello', id: '1' };
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
      }),
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import('../../terminal/provider/anthropic-api-provider');
    const provider = new FreshProvider('test-prov-5');
    const events = [];

    for await (const event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-1',
      workingDirectory: '/tmp',
    })) {
      events.push(event);
    }

    const textDeltaEvents = events.filter((e) => e.type === 'text_delta');
    expect(textDeltaEvents.length).toBeGreaterThan(0);
    expect(textDeltaEvents[0]?.type).toBe('text_delta');
  });

  it('sendMessage yields thinking_delta events from mocked stream', async () => {
    const testProvider: Provider = {
      id: 'test-prov-6',
      name: 'Test Provider',
      description: '',
      providerType: 'anthropic',
      authMethod: 'api_key',
      apiKey: 'sk-test-key-123',
      baseUrl: null,
      enabled: true,
      isDefault: false,
      config: { useDirectApi: true },
      createdAt: now,
      updatedAt: now,
    };
    insertProvider(testProvider);

    const testSession: TerminalSession = {
      id: 'ses-2',
      projectId: 'proj-1',
      agentId: 'agent-1',
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
    insertSession(testSession);

    mock.module('ai', () => ({
      streamText: () => ({
        fullStream: (async function* () {
          yield { type: 'reasoning-delta' as const, text: 'thinking', id: '1' };
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
      }),
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import('../../terminal/provider/anthropic-api-provider');
    const provider = new FreshProvider('test-prov-6');
    const events = [];

    for await (const event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-2',
      workingDirectory: '/tmp',
    })) {
      events.push(event);
    }

    const thinkingDeltaEvents = events.filter((e) => e.type === 'thinking_delta');
    expect(thinkingDeltaEvents.length).toBeGreaterThan(0);
    expect(thinkingDeltaEvents[0]?.type).toBe('thinking_delta');
  });

  it('sendMessage yields complete event at end', async () => {
    const testProvider: Provider = {
      id: 'test-prov-7',
      name: 'Test Provider',
      description: '',
      providerType: 'anthropic',
      authMethod: 'api_key',
      apiKey: 'sk-test-key-123',
      baseUrl: null,
      enabled: true,
      isDefault: false,
      config: { useDirectApi: true },
      createdAt: now,
      updatedAt: now,
    };
    insertProvider(testProvider);

    const testSession: TerminalSession = {
      id: 'ses-3',
      projectId: 'proj-1',
      agentId: 'agent-1',
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
    insertSession(testSession);

    mock.module('ai', () => ({
      streamText: () => ({
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
      }),
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import('../../terminal/provider/anthropic-api-provider');
    const provider = new FreshProvider('test-prov-7');
    const events = [];

    for await (const event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-3',
      workingDirectory: '/tmp',
    })) {
      events.push(event);
    }

    const completeEvents = events.filter((e) => e.type === 'complete');
    expect(completeEvents.length).toBeGreaterThan(0);
    expect(completeEvents[completeEvents.length - 1]?.type).toBe('complete');
  });

  it('abort aborts the controller', async () => {
    const testProvider: Provider = {
      id: 'test-prov-8',
      name: 'Test Provider',
      description: '',
      providerType: 'anthropic',
      authMethod: 'api_key',
      apiKey: 'sk-test-key-123',
      baseUrl: null,
      enabled: true,
      isDefault: false,
      config: { useDirectApi: true },
      createdAt: now,
      updatedAt: now,
    };
    insertProvider(testProvider);

    const testSession: TerminalSession = {
      id: 'ses-4',
      projectId: 'proj-1',
      agentId: 'agent-1',
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
    insertSession(testSession);

    let abortSignalReceived: unknown = null;

    mock.module('ai', () => ({
      streamText: (opts: Record<string, unknown>) => {
        abortSignalReceived = opts.abortSignal ?? null;
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
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import('../../terminal/provider/anthropic-api-provider');
    const provider = new FreshProvider('test-prov-8');

    const gen = provider.sendMessage({
      message: 'test',
      sessionId: 'ses-4',
      workingDirectory: '/tmp',
    });

    await gen.next();

    provider.abort('ses-4');

    if (abortSignalReceived && typeof abortSignalReceived === 'object' && 'aborted' in abortSignalReceived) {
      expect((abortSignalReceived as { aborted: boolean }).aborted).toBe(true);
    }
  });

  it('setReasoningLevel stores and uses reasoning level', async () => {
    const testProvider: Provider = {
      id: 'test-prov-9',
      name: 'Test Provider',
      description: '',
      providerType: 'anthropic',
      authMethod: 'api_key',
      apiKey: 'sk-test-key-123',
      baseUrl: null,
      enabled: true,
      isDefault: false,
      config: { useDirectApi: true },
      createdAt: now,
      updatedAt: now,
    };
    insertProvider(testProvider);

    const testSession: TerminalSession = {
      id: 'ses-5',
      projectId: 'proj-1',
      agentId: 'agent-1',
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
    insertSession(testSession);

    let thinkingConfigReceived: unknown = null;

    mock.module('ai', () => ({
      streamText: (opts: { providerOptions?: unknown }) => {
        thinkingConfigReceived = opts.providerOptions;
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
    }));

    mock.module('@ai-sdk/anthropic', () => ({
      createAnthropic: () => (modelId: string) => ({ modelId }),
    }));

    const { AnthropicApiProvider: FreshProvider } = await import('../../terminal/provider/anthropic-api-provider');
    const provider = new FreshProvider('test-prov-9');
    provider.setReasoningLevel('medium');

    const events = [];
    for await (const event of provider.sendMessage({
      message: 'test',
      sessionId: 'ses-5',
      workingDirectory: '/tmp',
      model: 'claude-opus-4-20250514',
    })) {
      events.push(event);
    }

    expect(thinkingConfigReceived).toBeDefined();
  });
});

describe('ProviderRegistry useDirectApi branching', () => {
  beforeAll(() => {
    process.env.MARS_DB_PATH = ':memory:';
    initDatabase();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM providers');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM mcp_servers');
  });

  it('registry returns ClaudeCliProvider when useDirectApi is falsy', () => {
    const testProvider: Provider = {
      id: 'test-prov-cli',
      name: 'CLI Provider',
      description: '',
      providerType: 'anthropic',
      authMethod: 'api_key',
      apiKey: 'sk-test-key-123',
      baseUrl: null,
      enabled: true,
      isDefault: false,
      config: { useDirectApi: false },
      createdAt: now,
      updatedAt: now,
    };
    insertProvider(testProvider);

    const registry = new ProviderRegistry();
    const provider = registry.get('test-prov-cli');

    expect(provider.name).toBe('Claude CLI');
  });

  it('registry returns AnthropicApiProvider when useDirectApi is true', () => {
    const testProvider: Provider = {
      id: 'test-prov-api',
      name: 'API Provider',
      description: '',
      providerType: 'anthropic',
      authMethod: 'api_key',
      apiKey: 'sk-test-key-123',
      baseUrl: null,
      enabled: true,
      isDefault: false,
      config: { useDirectApi: true },
      createdAt: now,
      updatedAt: now,
    };
    insertProvider(testProvider);

    const registry = new ProviderRegistry();
    const provider = registry.get('test-prov-api');

    expect(provider.name).toBe('Anthropic API');
  });

  it('registry caches provider instances', () => {
    const testProvider: Provider = {
      id: 'test-prov-cache',
      name: 'Cache Provider',
      description: '',
      providerType: 'anthropic',
      authMethod: 'api_key',
      apiKey: 'sk-test-key-123',
      baseUrl: null,
      enabled: true,
      isDefault: false,
      config: { useDirectApi: true },
      createdAt: now,
      updatedAt: now,
    };
    insertProvider(testProvider);

    const registry = new ProviderRegistry();
    const provider1 = registry.get('test-prov-cache');
    const provider2 = registry.get('test-prov-cache');

    expect(provider1).toBe(provider2);
  });

  it('getForAgent uses correct provider type based on config', () => {
    const testProvider: Provider = {
      id: 'test-prov-agent',
      name: 'Agent Provider',
      description: '',
      providerType: 'anthropic',
      authMethod: 'api_key',
      apiKey: 'sk-test-key-123',
      baseUrl: null,
      enabled: true,
      isDefault: false,
      config: { useDirectApi: true },
      createdAt: now,
      updatedAt: now,
    };
    insertProvider(testProvider);

    const db = getDb();
    db.exec(`
      INSERT INTO agents (id, name, provider_id, model_id, system_prompt, reasoning_level, mcp_server_ids, enabled, created_at, updated_at)
      VALUES ('agent-1', 'Test Agent', 'test-prov-agent', 'claude-sonnet', 'You are helpful', 'none', '[]', 1, ${now}, ${now})
    `);

    const registry = new ProviderRegistry();
    const provider = registry.getForAgent('agent-1');

    expect(provider.id).toBe('test-prov-agent');
  });
});
