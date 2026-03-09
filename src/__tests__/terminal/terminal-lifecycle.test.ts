import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { getDb, initDatabase } from '../../db/index';
import { insertMessage, updateSessionLifecycle } from '../../db/terminal-repo';
import { handleAgentRoutes } from '../../routes/agents';
import { handleProjectRoutes } from '../../routes/projects';
import { handleProviderRoutes } from '../../routes/providers';
import { handleTerminalRoutes } from '../../routes/terminal';
import { providerRegistry } from '../../terminal/provider/registry';
import { buildPtyCliLaunchSpec, resolveTerminalRuntime } from '../../terminal/runtime-spec';
import { SessionAccessTokenManager } from '../../terminal/session-access-token-manager';
import { sessionAccessTokenManager } from '../../terminal/session-access-token-manager';
import { terminalService } from '../../terminal/service';
import { shouldMarkPtySessionRestart } from '../../terminal/pty-runtime-manager';
import { TerminalWsHandler } from '../../terminal/ws-handler';
import type { WsData } from '../../terminal/ws-handler';

const now = Date.now();

async function callRoute(
  handler: (req: Request, url: URL) => Promise<Response | null>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | null> {
  const url = new URL(`http://localhost${path}`);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  return handler(new Request(url.toString(), init), url);
}

beforeAll(() => {
  process.env.MARS_DB_PATH = ':memory:';
  initDatabase();
});

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM terminal_messages');
  db.exec('DELETE FROM terminal_sessions');
  db.exec('DELETE FROM projects');
  db.exec('DELETE FROM agents');
  db.exec('DELETE FROM providers');
  db.exec('DELETE FROM mcp_servers');

  db.exec(`
    INSERT INTO providers (id, name, description, provider_type, auth_method, api_key, base_url, enabled, is_default, config, created_at, updated_at)
    VALUES ('prov-1', 'Claude OAuth', '', 'anthropic', 'oauth', NULL, NULL, 1, 1, '{"useDirectApi":false,"cliPath":"/tmp/claude","defaultModel":"claude-sonnet-4.6","permissionMode":"plan","customArgs":["--verbose"]}', ${now}, ${now})
  `);
  db.exec(`
    INSERT INTO providers (id, name, description, provider_type, auth_method, api_key, base_url, enabled, is_default, config, created_at, updated_at)
    VALUES ('prov-2', 'Secondary Provider', '', 'anthropic', 'oauth', NULL, NULL, 1, 0, '{"useDirectApi":false,"cliPath":"/tmp/claude"}', ${now}, ${now})
  `);
  db.exec(`
    INSERT INTO agents (id, name, description, provider_id, model_id, system_prompt, reasoning_level, worker_count, mcp_server_ids, skill_ids, enabled, created_at, updated_at)
    VALUES ('agent-1', 'Terminal Agent', '', 'prov-1', 'claude-haiku-4.5', '', 'none', 2, '[]', '[]', 1, ${now}, ${now})
  `);
  db.exec(`
    INSERT INTO projects (id, name, description, instructions, directory_path, provider_id, status, agent_ids, mcp_server_ids, created_at, updated_at)
    VALUES ('project-1', 'Terminal Project', '', '', '/tmp/mars-project', '', 'active', '["agent-1"]', '[]', ${now}, ${now})
  `);
  db.exec(`
    INSERT INTO mcp_servers (id, name, description, transport_type, command, args, url, headers, env, enabled, created_at, updated_at)
    VALUES ('mcp-1', 'Project MCP', '', 'stdio', 'node', '["server.js"]', NULL, '{}', '{}', 1, ${now}, ${now})
  `);

  providerRegistry.clear();
});

describe('terminal lifecycle hardening', () => {
  it('keeps general session GET sanitized and exposes recovery access from a narrow route', async () => {
    const createResponse = await callRoute(handleTerminalRoutes, 'POST', '/api/terminal/sessions', {
      projectId: 'project-1',
      agentId: 'agent-1',
    });

    expect(createResponse).not.toBeNull();
    const created = await createResponse?.json() as {
      data: { session: { id: string }; accessToken: string };
    };

    const freshManager = new SessionAccessTokenManager();
    expect(freshManager.validate(created.data.session.id, created.data.accessToken)).toBe(true);

    const getResponse = await callRoute(handleTerminalRoutes, 'GET', `/api/terminal/sessions/${created.data.session.id}`);
    expect(getResponse).not.toBeNull();

    const fetched = await getResponse?.json() as {
      data: { id: string; accessToken?: string };
    };
    expect(fetched.data.id).toBe(created.data.session.id);
    expect(fetched.data.accessToken).toBeUndefined();

    const accessResponse = await callRoute(handleTerminalRoutes, 'POST', `/api/terminal/sessions/${created.data.session.id}/access`);
    expect(accessResponse).not.toBeNull();
    const refreshed = await accessResponse?.json() as {
      data: { session: { id: string }; accessToken: string };
    };
    expect(refreshed.data.session.id).toBe(created.data.session.id);
    expect(refreshed.data.accessToken).toBe(created.data.accessToken);
  });

  it('marks provider, agent, and project runtime changes as restart-required and invalidates provider cache', async () => {
    const providerSession = await terminalService.getOrCreateSession('project-1', 'agent-1');
    const providerToken = providerSession.accessToken;
    providerRegistry.get('prov-1');
    expect(providerRegistry.has('prov-1')).toBe(true);

    const providerResponse = await callRoute(handleProviderRoutes, 'PATCH', '/api/providers/prov-1', {
      config: { defaultModel: 'claude-opus-4.6' },
    });
    expect(providerResponse?.status).toBe(200);

    const refreshedProviderSession = await terminalService.getSession(providerSession.id);
    expect(refreshedProviderSession?.restartRequired).toBe(true);
    expect(refreshedProviderSession?.cliSessionId).toBeNull();
    expect(refreshedProviderSession?.accessToken).not.toBe(providerToken);
    expect(providerRegistry.has('prov-1')).toBe(false);

    const agentSession = await terminalService.restartSession(providerSession.id);
    expect(agentSession).not.toBeNull();
    const agentResponse = await callRoute(handleAgentRoutes, 'PATCH', '/api/agents/agent-1', {
      modelId: 'claude-sonnet-4.6',
    });
    expect(agentResponse?.status).toBe(200);

    const refreshedAgentSession = await terminalService.getSession(providerSession.id);
    expect(refreshedAgentSession?.restartRequired).toBe(true);
    expect(refreshedAgentSession?.restartReason).toContain('Agent');

    const projectSession = await terminalService.restartSession(providerSession.id);
    expect(projectSession).not.toBeNull();
    const projectResponse = await callRoute(handleProjectRoutes, 'PATCH', '/api/projects/project-1', {
      mcpServerIds: ['mcp-1'],
    });
    expect(projectResponse?.status).toBe(200);

    const refreshedProjectSession = await terminalService.getSession(providerSession.id);
    expect(refreshedProjectSession?.restartRequired).toBe(true);
    expect(refreshedProjectSession?.restartReason).toContain('Project');
  });

  it('builds PTY CLI launch config with Mars MCP config and runtime flags', async () => {
    const session = await terminalService.getOrCreateSession('project-1', 'agent-1', ['mcp-1']);
    const runtime = resolveTerminalRuntime(session);
    const launch = buildPtyCliLaunchSpec(runtime);

    expect(launch).not.toBeNull();
    expect(launch?.command).toEqual([
      '/tmp/claude',
      '--model',
      'claude-sonnet-4.6',
      '--permission-mode',
      'plan',
      '--mcp-config',
      runtime.mcpConfigPath!,
      '--verbose',
    ]);
    expect(runtime.mcpConfigPath).toBeDefined();
    expect(existsSync(runtime.mcpConfigPath!)).toBe(true);
  });

  it('builds Codex PTY launch config with workspace-write sandbox and -c MCP flags', async () => {
    const db = getDb();
    db.exec(`
      INSERT INTO providers (id, name, description, provider_type, auth_method, api_key, base_url, enabled, is_default, config, created_at, updated_at)
      VALUES ('prov-openai', 'Codex Provider', '', 'openai', 'api_key', 'test-key', NULL, 1, 0, '{"useDirectApi":false,"cliPath":"/tmp/codex"}', ${now}, ${now})
    `);
    db.exec(`
      INSERT INTO agents (id, name, description, provider_id, model_id, system_prompt, reasoning_level, worker_count, mcp_server_ids, skill_ids, enabled, created_at, updated_at)
      VALUES ('agent-openai', 'Codex Agent', '', 'prov-openai', 'gpt-5.3-codex', '', 'none', 1, '[]', '[]', 1, ${now}, ${now})
    `);
    db.exec(`
      INSERT INTO projects (id, name, description, instructions, directory_path, provider_id, status, agent_ids, mcp_server_ids, created_at, updated_at)
      VALUES ('project-openai', 'Codex Project', '', '', '/tmp/mars-codex-project', '', 'active', '["agent-openai"]', '[]', ${now}, ${now})
    `);

    const session = await terminalService.getOrCreateSession('project-openai', 'agent-openai', ['mcp-1']);
    const runtime = resolveTerminalRuntime(session);
    const launch = buildPtyCliLaunchSpec(runtime);

    expect(launch).not.toBeNull();
    expect(launch?.command).not.toContain('--mcp-config');

    const baseArgs = [
      '/tmp/codex',
      '--model',
      'gpt-5.3-codex',
      '--cd',
      '/tmp/mars-codex-project',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
    ];
    expect(launch?.command.slice(0, baseArgs.length)).toEqual(baseArgs);
    expect(launch?.command).toContain('-c');
    expect(launch?.command.some((arg: string) => arg.includes('mcp_servers.Project MCP.type="stdio"'))).toBe(true);
    expect(launch?.command.some((arg: string) => arg.includes('mcp_servers.Project MCP.command="node"'))).toBe(true);
  });

  it('restart rotates token, clears stale CLI reuse, preserves history, and bumps runtime version', async () => {
    const session = await terminalService.getOrCreateSession('project-1', 'agent-1');
    const originalToken = session.accessToken;
    const originalVersion = session.runtimeVersion ?? 1;

    updateSessionLifecycle(session.id, {
      cliSessionId: 'cli-old',
      restartRequired: true,
      restartReason: 'Runtime changed',
      restartMarkedAt: Date.now(),
    });
    insertMessage({
      id: 'msg-1',
      sessionId: session.id,
      role: 'assistant',
      type: 'text',
      content: 'persist me',
      metadata: null,
      createdAt: Date.now(),
    });

    const restarted = await terminalService.restartSession(session.id);
    const messages = await terminalService.getMessages({ sessionId: session.id, limit: 10, offset: 0 });

    expect(restarted).not.toBeNull();
    expect(restarted?.id).toBe(session.id);
    expect(restarted?.cliSessionId).toBeNull();
    expect(restarted?.restartRequired).toBe(false);
    expect(restarted?.accessToken).not.toBe(originalToken);
    expect(restarted?.runtimeVersion).toBe(originalVersion + 1);
    expect(messages.map((message) => message.content)).toEqual(['persist me']);
  });

  it('does not mark sessions restart-required for project providerId-only edits', async () => {
    const session = await terminalService.getOrCreateSession('project-1', 'agent-1');

    const response = await callRoute(handleProjectRoutes, 'PATCH', '/api/projects/project-1', {
      providerId: 'prov-2',
    });

    expect(response?.status).toBe(200);

    const refreshed = await terminalService.getSession(session.id);
    expect(refreshed?.restartRequired).toBe(false);
  });

  it('invalidates sessions created before the current launch-policy version', async () => {
    const session = await terminalService.getOrCreateSession('project-1', 'agent-1', ['mcp-1']);

    updateSessionLifecycle(session.id, {
      runtimeFingerprint: 'legacy-fingerprint',
      restartRequired: false,
      restartReason: null,
      restartMarkedAt: null,
    });

    const refreshed = await terminalService.getSession(session.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed?.restartRequired).toBe(true);
    expect(refreshed?.restartReason).toContain('Terminal runtime changed');
  });

  it('drops stale websocket subscribers after token rotation', async () => {
    const session = await terminalService.getOrCreateSession('project-1', 'agent-1');
    const handler = new TerminalWsHandler();
    const sent: string[] = [];
    const ws = {
      data: { connectionId: 'conn-1' } as WsData,
      send(message: string) {
        sent.push(message);
      },
    };

    handler.handleOpen(ws as never);
    handler.handleMessage(ws as never, JSON.stringify({
      type: 'subscribe',
      sessionId: session.id,
      accessToken: session.accessToken,
    }));

    sent.length = 0;
    sessionAccessTokenManager.rotate(session.id);

    handler.broadcastToSession(session.id, { type: 'content_delta', sessionId: session.id, delta: 'stale' });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] ?? '{}')).toEqual({
      type: 'error',
      sessionId: session.id,
      error: 'Invalid terminal session access token',
    });

    sent.length = 0;
    handler.broadcastToSession(session.id, { type: 'content_delta', sessionId: session.id, delta: 'after-prune' });
    expect(sent).toHaveLength(0);
  });

  it('detects clean CLI self-update exits and marks restart-required', () => {
    expect(shouldMarkPtySessionRestart('provider_cli', 'Update complete. Please restart to continue.', 0, null)).toBe(true);
    expect(shouldMarkPtySessionRestart('shell_fallback', 'Please restart to continue.', 0, null)).toBe(false);
    expect(shouldMarkPtySessionRestart('provider_cli', 'Please restart to continue.', 1, null)).toBe(false);
  });
});
