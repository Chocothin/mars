import { beforeAll, describe, expect, it } from 'bun:test';
import { initDatabase, getDb } from '../../db/index';
import { handleMcpServerRoutes } from '../../routes/mcp-servers';
import { getMcpServerByName } from '../../db/mcp-server-repo';

async function callRoute(method: string, path: string, body?: unknown): Promise<Response | null> {
  const url = new URL('http://localhost' + path);
  const init: RequestInit = { method };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }

  const req = new Request(url.toString(), init);
  return handleMcpServerRoutes(req, url);
}

beforeAll(() => {
  process.env.MARS_DB_PATH = ':memory:';
  initDatabase();

  const now = Date.now();
  const db = getDb();
  db.exec(`
    INSERT INTO providers (id, name, provider_type, auth_method, enabled, is_default, config, created_at, updated_at)
    VALUES ('prov-1', 'Test Provider', 'anthropic', 'oauth', 1, 1, '{}', ${now}, ${now})
  `);
  db.exec(`
    INSERT INTO agents (id, name, provider_id, model_id, system_prompt, reasoning_level, mcp_server_ids, enabled, created_at, updated_at)
    VALUES ('agent-1', 'Agent One', 'prov-1', 'claude-test', '', 'none', '["secure-server"]', 1, ${now}, ${now})
  `);
  db.exec(`
    INSERT INTO projects (id, name, directory_path, status, agent_ids, mcp_server_ids, created_at, updated_at)
    VALUES ('project-1', 'Project One', '/tmp', 'active', '["agent-1"]', '["secure-server"]', ${now}, ${now})
  `);
});

describe('MCP server API redaction', () => {
  it('redacts env and headers in create/get/list/update responses while preserving stored values', async () => {
    const createResponse = await callRoute('POST', '/api/mcp-servers', {
      name: 'secure-server',
      transportType: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: {
        Authorization: 'sensitive-header-value',
      },
      env: {
        API_KEY: 'sensitive-env-value',
      },
    });

    expect(createResponse).not.toBeNull();
    expect(createResponse!.status).toBe(201);

    const created = await createResponse!.json() as { data: { id: string; headers: Record<string, string>; env: Record<string, string> } };
    expect(created.data.headers).toEqual({ Authorization: '[REDACTED]' });
    expect(created.data.env).toEqual({ API_KEY: '[REDACTED]' });

    const stored = getMcpServerByName('secure-server');
    expect(stored).not.toBeNull();
    expect(Object.keys(stored!.headers)).toEqual(['Authorization']);
    expect(Object.keys(stored!.env)).toEqual(['API_KEY']);
    expect(stored!.headers.Authorization).not.toBe('[REDACTED]');
    expect(stored!.env.API_KEY).not.toBe('[REDACTED]');

    const getResponse = await callRoute('GET', `/api/mcp-servers/${created.data.id}`);
    const fetched = await getResponse!.json() as { data: { headers: Record<string, string>; env: Record<string, string> } };
    expect(fetched.data.headers).toEqual({ Authorization: '[REDACTED]' });
    expect(fetched.data.env).toEqual({ API_KEY: '[REDACTED]' });

    const listResponse = await callRoute('GET', '/api/mcp-servers');
    const listed = await listResponse!.json() as { data: Array<{ id: string; headers: Record<string, string>; env: Record<string, string> }> };
    const listedServer = listed.data.find((server) => server.id === created.data.id);
    expect(listedServer).toBeDefined();
    expect(listedServer?.headers).toEqual({ Authorization: '[REDACTED]' });
    expect(listedServer?.env).toEqual({ API_KEY: '[REDACTED]' });

    const updateResponse = await callRoute('PATCH', `/api/mcp-servers/${created.data.id}`, {
      env: {
        API_KEY: 'updated-sensitive-env-value',
      },
      headers: {
        Authorization: 'updated-sensitive-header-value',
      },
    });
    const updated = await updateResponse!.json() as { data: { headers: Record<string, string>; env: Record<string, string> } };
    expect(updated.data.headers).toEqual({ Authorization: '[REDACTED]' });
    expect(updated.data.env).toEqual({ API_KEY: '[REDACTED]' });

    const storedAfterUpdate = getMcpServerByName('secure-server');
    expect(storedAfterUpdate).not.toBeNull();
    expect(storedAfterUpdate!.headers.Authorization).not.toBe('[REDACTED]');
    expect(storedAfterUpdate!.env.API_KEY).not.toBe('[REDACTED]');
  });

  it('marks affected terminal sessions as restart-required on update and delete', async () => {
    const db = getDb();
    const now = Date.now();

    const createResponse = await callRoute('POST', '/api/mcp-servers', {
      name: 'restart-server',
      transportType: 'stdio',
      command: 'node',
      args: ['server.js'],
    });
    expect(createResponse).not.toBeNull();
    expect(createResponse!.status).toBe(201);
    const created = await createResponse!.json() as { data: { id: string } };

    db.exec(`UPDATE agents SET mcp_server_ids = '["${created.data.id}"]' WHERE id = 'agent-1'`);
    db.exec(`UPDATE projects SET mcp_server_ids = '["${created.data.id}"]' WHERE id = 'project-1'`);
    db.exec('DELETE FROM terminal_sessions');
    db.exec(`
      INSERT INTO terminal_sessions (
        id, project_id, agent_id, mcp_server_ids, working_directory, status, cli_session_id,
        restart_required, restart_reason, restart_marked_at, created_at, updated_at
      )
      VALUES (
        'session-1', 'project-1', 'agent-1', '["secure-server"]', '/tmp', 'idle', NULL,
        0, '', 0, ${now}, ${now}
      )
    `);

    const updateResponse = await callRoute('PATCH', `/api/mcp-servers/${created.data.id}`, {
      description: 'updated',
    });

    expect(updateResponse).not.toBeNull();
    expect(updateResponse!.status).toBe(200);

    const afterUpdate = db.query(`SELECT restart_required, restart_reason FROM terminal_sessions WHERE id = 'session-1'`).get() as {
      restart_required: number;
      restart_reason: string;
    };
    expect(afterUpdate.restart_required).toBe(1);
    expect(afterUpdate.restart_reason).toContain('changed');

    const deleteResponse = await callRoute('DELETE', `/api/mcp-servers/${created.data.id}`);
    expect(deleteResponse).not.toBeNull();
    expect(deleteResponse!.status).toBe(200);

    const afterDelete = db.query(`SELECT restart_required, restart_reason FROM terminal_sessions WHERE id = 'session-1'`).get() as {
      restart_required: number;
      restart_reason: string;
    };
    expect(afterDelete.restart_required).toBe(1);
    expect(afterDelete.restart_reason).toContain('removed');
  });
});
