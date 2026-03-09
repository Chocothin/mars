import { describe, it, expect, beforeAll } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { initDatabase, getDb } from '../../db/index';
import { ProviderEnricher } from '../../terminal/provider/enricher';
import { writeMcpConfig } from '../../terminal/provider/mcp-config-writer';
import { ProviderRegistry, createEnrichmentContext, mergeMcpServerIds } from '../../terminal/provider/registry';
import type { EnrichmentContext } from '../../terminal/provider/enrichment';
import type { LLMProvider, ProviderRequest, ProviderEvent } from '../../terminal/provider/types';
import type { McpServer } from '../../types/mcp-server';

const now = Date.now();

function makeMcpServer(overrides: Partial<McpServer> & { id: string; name: string }): McpServer {
  return {
    description: '',
    transportType: 'stdio',
    command: 'npx',
    args: [],
    url: null,
    headers: {},
    env: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeBaseProvider(): LLMProvider {
  return {
    id: 'base-prov',
    name: 'Base Provider',
    async *sendMessage(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
      yield { type: 'text_delta', content: 'ok' };
      yield { type: 'complete', metadata: {} };
    },
    abort() {},
    async isAvailable() {
      return true;
    },
  };
}

function makeContext(overrides?: Partial<EnrichmentContext>): EnrichmentContext {
  return {
    agent: {
      id: 'agent-1',
      systemPrompt: '',
      modelId: '',
      reasoningLevel: 'none',
      ...overrides?.agent,
    },
    mcpServerIds: overrides?.mcpServerIds ?? [],
    mcpServers: overrides?.mcpServers ?? [],
    providerConfig: overrides?.providerConfig ?? {},
  };
}

function captureEnrichedRequest(
  context: EnrichmentContext,
  request: Partial<ProviderRequest>,
): ProviderRequest {
  let captured: ProviderRequest | null = null;

  const spy: LLMProvider = {
    id: 'spy',
    name: 'Spy',
    async *sendMessage(req: ProviderRequest): AsyncGenerator<ProviderEvent> {
      captured = req;
      yield { type: 'complete' };
    },
    abort() {},
    async isAvailable() {
      return true;
    },
  };

  const enricher = new ProviderEnricher(spy, context);
  const fullRequest: ProviderRequest = {
    message: 'test',
    sessionId: 'ses-1',
    workingDirectory: '/tmp',
    ...request,
  };

  const gen = enricher.sendMessage(fullRequest);
  gen.next();

  if (!captured) throw new Error('sendMessage was not called');
  return captured;
}

describe('McpConfigWriter', () => {
  it('writes stdio server to JSON file', () => {
    const server = makeMcpServer({
      id: 'srv-1',
      name: 'github',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp_xxx' },
    });

    const filePath = writeMcpConfig([server]);
    expect(existsSync(filePath)).toBe(true);

    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content.mcpServers.github).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp_xxx' },
    });
  });

  it('writes SSE server with url and headers', () => {
    const server = makeMcpServer({
      id: 'srv-2',
      name: 'remote',
      transportType: 'sse',
      command: null,
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token123' },
    });

    const filePath = writeMcpConfig([server]);
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content.mcpServers.remote.url).toBe('https://mcp.example.com/sse');
    expect(content.mcpServers.remote.headers).toEqual({ Authorization: 'Bearer token123' });
  });

  it('skips disabled servers', () => {
    const server = makeMcpServer({
      id: 'srv-3',
      name: 'disabled-server',
      enabled: false,
    });

    const filePath = writeMcpConfig([server]);
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(Object.keys(content.mcpServers)).toHaveLength(0);
  });

  it('omits env when empty', () => {
    const server = makeMcpServer({
      id: 'srv-4',
      name: 'no-env',
      command: 'node',
      args: ['server.js'],
      env: {},
    });

    const filePath = writeMcpConfig([server]);
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content.mcpServers['no-env'].env).toBeUndefined();
  });

  it('omits headers when empty', () => {
    const server = makeMcpServer({
      id: 'srv-5',
      name: 'no-headers',
      transportType: 'sse',
      command: null,
      url: 'https://mcp.example.com',
      headers: {},
    });

    const filePath = writeMcpConfig([server]);
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content.mcpServers['no-headers'].headers).toBeUndefined();
  });

  it('writes multiple servers', () => {
    const servers = [
      makeMcpServer({ id: 's1', name: 'server-a', command: 'npx', args: ['a'] }),
      makeMcpServer({ id: 's2', name: 'server-b', command: 'npx', args: ['b'] }),
    ];

    const filePath = writeMcpConfig(servers);
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(Object.keys(content.mcpServers)).toHaveLength(2);
    expect(content.mcpServers['server-a']).toBeDefined();
    expect(content.mcpServers['server-b']).toBeDefined();
  });
});

describe('ProviderEnricher', () => {
  describe('system prompt merging', () => {
    it('passes agent systemPrompt when no existing context', () => {
      const ctx = makeContext({ agent: { id: 'a', systemPrompt: 'You are a helper.', modelId: '', reasoningLevel: 'none' } });
      const result = captureEnrichedRequest(ctx, {});
      expect(result.systemContext).toBe('You are a helper.');
    });

    it('passes existing context when agent systemPrompt is empty', () => {
      const ctx = makeContext({ agent: { id: 'a', systemPrompt: '', modelId: '', reasoningLevel: 'none' } });
      const result = captureEnrichedRequest(ctx, { systemContext: 'Skill context' });
      expect(result.systemContext).toBe('Skill context');
    });

    it('merges agent prompt with existing context using separator', () => {
      const ctx = makeContext({ agent: { id: 'a', systemPrompt: 'Agent prompt', modelId: '', reasoningLevel: 'none' } });
      const result = captureEnrichedRequest(ctx, { systemContext: 'Skill context' });
      expect(result.systemContext).toBe('Agent prompt\n\n---\n\nSkill context');
    });

    it('returns undefined when both are empty', () => {
      const ctx = makeContext({ agent: { id: 'a', systemPrompt: '', modelId: '', reasoningLevel: 'none' } });
      const result = captureEnrichedRequest(ctx, {});
      expect(result.systemContext).toBeUndefined();
    });
  });

  describe('model selection', () => {
    it('uses request.model when explicitly set', () => {
      const ctx = makeContext({ agent: { id: 'a', systemPrompt: '', modelId: 'claude-sonnet', reasoningLevel: 'none' } });
      const result = captureEnrichedRequest(ctx, { model: 'claude-opus' });
      expect(result.model).toBe('claude-opus');
    });

    it('falls back to agent modelId', () => {
      const ctx = makeContext({ agent: { id: 'a', systemPrompt: '', modelId: 'claude-sonnet', reasoningLevel: 'none' } });
      const result = captureEnrichedRequest(ctx, {});
      expect(result.model).toBe('claude-sonnet');
    });

    it('returns undefined when agent modelId is empty', () => {
      const ctx = makeContext({ agent: { id: 'a', systemPrompt: '', modelId: '', reasoningLevel: 'none' } });
      const result = captureEnrichedRequest(ctx, {});
      expect(result.model).toBeUndefined();
    });
  });

  describe('MCP server ids', () => {
    it('passes resolved mcpServerIds to the provider request', () => {
      const ctx = makeContext({ mcpServerIds: ['project-mcp', 'agent-mcp', 'session-mcp'] });
      const result = captureEnrichedRequest(ctx, {});
      expect(result.mcpServerIds).toEqual(['project-mcp', 'agent-mcp', 'session-mcp']);
    });
  });

  describe('MCP config', () => {
    it('generates mcpConfigPath when servers exist', () => {
      const servers = [makeMcpServer({ id: 'srv', name: 'test-mcp', command: 'node', args: ['srv.js'] })];
      const ctx = makeContext({ mcpServers: servers });
      const result = captureEnrichedRequest(ctx, {});
      expect(result.mcpConfigPath).toBeDefined();
      expect(result.mcpConfigPath).toContain('mars-mcp-');
    });

    it('returns undefined mcpConfigPath when no servers', () => {
      const ctx = makeContext({ mcpServers: [] });
      const result = captureEnrichedRequest(ctx, {});
      expect(result.mcpConfigPath).toBeUndefined();
    });

    it('preserves existing mcpConfigPath from request', () => {
      const servers = [makeMcpServer({ id: 'srv', name: 'test-mcp', command: 'node', args: ['srv.js'] })];
      const ctx = makeContext({ mcpServers: servers });
      const result = captureEnrichedRequest(ctx, { mcpConfigPath: '/existing/config.json' });
      expect(result.mcpConfigPath).toBe('/existing/config.json');
    });
  });

  describe('budget and permission', () => {
    it('applies maxBudgetUsd from providerConfig', () => {
      const ctx = makeContext({ providerConfig: { maxBudgetUsd: 5.0 } });
      const result = captureEnrichedRequest(ctx, {});
      expect(result.maxBudgetUsd).toBe(5.0);
    });

    it('preserves request maxBudgetUsd over provider config', () => {
      const ctx = makeContext({ providerConfig: { maxBudgetUsd: 5.0 } });
      const result = captureEnrichedRequest(ctx, { maxBudgetUsd: 10.0 });
      expect(result.maxBudgetUsd).toBe(10.0);
    });

    it('applies permissionMode from providerConfig', () => {
      const ctx = makeContext({ providerConfig: { permissionMode: 'bypassPermissions' } });
      const result = captureEnrichedRequest(ctx, {});
      expect(result.permissionMode).toBe('bypassPermissions');
    });

    it('preserves request permissionMode over provider config', () => {
      const ctx = makeContext({ providerConfig: { permissionMode: 'bypassPermissions' } });
      const result = captureEnrichedRequest(ctx, { permissionMode: 'plan' });
      expect(result.permissionMode).toBe('plan');
    });
  });

  describe('delegation', () => {
    it('delegates sendMessage to base provider', async () => {
      const events: ProviderEvent[] = [];
      const base = makeBaseProvider();
      const enricher = new ProviderEnricher(base, makeContext());

      for await (const event of enricher.sendMessage({ message: 'hi', sessionId: 's1', workingDirectory: '/tmp' })) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'text_delta', content: 'ok' });
    });

    it('delegates abort to base provider', () => {
      let abortedSessionId = '';
      const base: LLMProvider = {
        ...makeBaseProvider(),
        abort(sid: string) {
          abortedSessionId = sid;
        },
      };

      const enricher = new ProviderEnricher(base, makeContext());
      enricher.abort('ses-123');
      expect(abortedSessionId).toBe('ses-123');
    });

    it('delegates isAvailable to base provider', async () => {
      const base = makeBaseProvider();
      const enricher = new ProviderEnricher(base, makeContext());
      expect(await enricher.isAvailable()).toBe(true);
    });

    it('exposes base id and name', () => {
      const base = makeBaseProvider();
      const enricher = new ProviderEnricher(base, makeContext());
      expect(enricher.id).toBe('base-prov');
      expect(enricher.name).toBe('Base Provider');
    });
  });
});

describe('ProviderRegistry enrichment', () => {
  beforeAll(() => {
    process.env.MARS_DB_PATH = ':memory:';
    initDatabase();

    const db = getDb();

    db.exec(`
      INSERT INTO providers (id, name, provider_type, auth_method, enabled, is_default, config, created_at, updated_at)
      VALUES ('prov-1', 'Test Anthropic', 'anthropic', 'oauth', 1, 1, '{"maxBudgetUsd": 3.0, "permissionMode": "plan"}', ${now}, ${now})
    `);

    db.exec(`
      INSERT INTO projects (id, name, description, instructions, directory_path, provider_id, status, agent_ids, mcp_server_ids, created_at, updated_at)
      VALUES ('project-1', 'Project One', '', '', '/tmp/project-1', 'prov-1', 'active', '["agent-full"]', '["project-mcp","mcp-1"]', ${now}, ${now})
    `);

    db.exec(`
      INSERT INTO mcp_servers (id, name, transport_type, command, args, url, headers, env, enabled, created_at, updated_at)
      VALUES ('project-mcp', 'project-mcp', 'stdio', 'npx', '["project"]', NULL, '{}', '{}', 1, ${now}, ${now})
    `);

    db.exec(`
      INSERT INTO mcp_servers (id, name, transport_type, command, args, url, headers, env, enabled, created_at, updated_at)
      VALUES ('mcp-1', 'github-mcp', 'stdio', 'npx', '["-y","@mcp/github"]', NULL, '{}', '{"GITHUB_TOKEN":"ghp_test"}', 1, ${now}, ${now})
    `);

    db.exec(`
      INSERT INTO mcp_servers (id, name, transport_type, command, args, url, headers, env, enabled, created_at, updated_at)
      VALUES ('mcp-2', 'disabled-mcp', 'stdio', 'npx', '["disabled"]', NULL, '{}', '{}', 0, ${now}, ${now})
    `);

    db.exec(`
      INSERT INTO mcp_servers (id, name, transport_type, command, args, url, headers, env, enabled, created_at, updated_at)
      VALUES ('session-mcp', 'session-mcp', 'stdio', 'npx', '["session"]', NULL, '{}', '{}', 1, ${now}, ${now})
    `);

    db.exec(`
      INSERT INTO agents (id, name, provider_id, model_id, system_prompt, reasoning_level, mcp_server_ids, enabled, created_at, updated_at)
      VALUES ('agent-full', 'Full Agent', 'prov-1', 'claude-sonnet-4-20250514', 'You are a coding assistant.', 'medium', '["mcp-1","mcp-2"]', 1, ${now}, ${now})
    `);

    db.exec(`
      INSERT INTO agents (id, name, provider_id, model_id, system_prompt, reasoning_level, mcp_server_ids, enabled, created_at, updated_at)
      VALUES ('agent-bare', 'Bare Agent', 'prov-1', '', '', 'none', '[]', 1, ${now}, ${now})
    `);
  });

  it('getForAgent returns ProviderEnricher', () => {
    const registry = new ProviderRegistry();
    const provider = registry.getForAgent('agent-full');
    expect(provider).toBeInstanceOf(ProviderEnricher);
    expect(provider.id).toBe('prov-1');
  });

  it('enriches request with agent config fields', () => {
    const registry = new ProviderRegistry();
    const provider = registry.getForAgent('agent-full');

    expect(provider).toBeInstanceOf(ProviderEnricher);
    expect(provider.id).toBe('prov-1');
    expect(provider.name).toBe('Claude CLI');
  });

  it('throws for nonexistent agent', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.getForAgent('nonexistent')).toThrow('Agent not found');
  });

  it('throws for nonexistent provider', () => {
    const db = getDb();
    db.exec(`
      INSERT INTO agents (id, name, provider_id, model_id, system_prompt, reasoning_level, mcp_server_ids, enabled, created_at, updated_at)
      VALUES ('agent-bad-prov', 'Bad Provider Agent', 'nonexistent-prov', '', '', 'none', '[]', 1, ${now}, ${now})
    `);
    const registry = new ProviderRegistry();
    expect(() => registry.getForAgent('agent-bad-prov')).toThrow('Provider not found');
  });

  it('skips disabled MCP servers from enrichment context', () => {
    const registry = new ProviderRegistry();
    const provider = registry.getForAgent('agent-full');
    expect(provider).toBeInstanceOf(ProviderEnricher);
  });

  it('bare agent returns enricher with no enrichment fields', () => {
    const registry = new ProviderRegistry();
    const provider = registry.getForAgent('agent-bare');
    expect(provider).toBeInstanceOf(ProviderEnricher);
  });

  it('createEnrichmentContext preserves project-agent-session merge order and filters disabled MCPs', () => {
    const context = createEnrichmentContext('agent-full', {
      projectId: 'project-1',
      overrideMcpServerIds: ['session-mcp', 'project-mcp', 'mcp-2'],
    });

    expect(context.mcpServerIds).toEqual(['project-mcp', 'mcp-1', 'session-mcp']);
    expect(context.mcpServers.map((server) => server.id)).toEqual(['project-mcp', 'mcp-1', 'session-mcp']);
  });
});

describe('mergeMcpServerIds', () => {
  it('preserves project-agent-session order while removing duplicates', () => {
    expect(
      mergeMcpServerIds(['project-1', 'shared'], ['agent-1', 'shared'], ['session-1', 'project-1'])
    ).toEqual(['project-1', 'shared', 'agent-1', 'session-1']);
  });
});
