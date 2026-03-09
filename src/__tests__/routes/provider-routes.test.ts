import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { getDb, initDatabase } from '../../db/index';
import { handleProviderRoutes } from '../../routes/providers';

const now = Date.now();

async function callRoute(method: string, path: string, body?: unknown): Promise<Response | null> {
  const url = new URL(`http://localhost${path}`);
  const req = new Request(url.toString(), {
    method,
    ...(body !== undefined
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  return handleProviderRoutes(req, url);
}

beforeAll(() => {
  process.env.MARS_DB_PATH = ':memory:';
  initDatabase();
});

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM agents');
  db.exec('DELETE FROM providers');

  db.exec(`
    INSERT INTO providers (id, name, description, provider_type, auth_method, api_key, base_url, enabled, is_default, config, created_at, updated_at)
    VALUES ('prov-in-use', 'In Use Provider', '', 'anthropic', 'oauth', NULL, NULL, 1, 1, '{"useDirectApi":false}', ${now}, ${now})
  `);
  db.exec(`
    INSERT INTO providers (id, name, description, provider_type, auth_method, api_key, base_url, enabled, is_default, config, created_at, updated_at)
    VALUES ('prov-free', 'Unused Provider', '', 'openai', 'api_key', 'test-key', NULL, 1, 0, '{"useDirectApi":true}', ${now}, ${now})
  `);
  db.exec(`
    INSERT INTO agents (id, name, description, provider_id, model_id, system_prompt, reasoning_level, worker_count, mcp_server_ids, skill_ids, enabled, created_at, updated_at)
    VALUES ('agent-1', 'Bound Agent', '', 'prov-in-use', 'claude-sonnet-4.6', '', 'medium', 1, '[]', '[]', 1, ${now}, ${now})
  `);
  db.exec(`
    INSERT INTO agents (id, name, description, provider_id, model_id, system_prompt, reasoning_level, worker_count, mcp_server_ids, skill_ids, enabled, created_at, updated_at)
    VALUES ('agent-2', 'Second Bound Agent', '', 'prov-in-use', 'claude-haiku-4.5', '', 'medium', 1, '[]', '[]', 1, ${now}, ${now})
  `);
});

describe('Provider delete protection', () => {
  it('rejects deleting a provider that agents still reference', async () => {
    const response = await callRoute('DELETE', '/api/providers/prov-in-use');

    expect(response).not.toBeNull();
    expect(response!.status).toBe(409);

    const body = await response!.json() as { error: string };
    expect(body.error).toContain('Cannot delete provider "In Use Provider"');
    expect(body.error).toContain('2 agents still reference it');
    expect(body.error).toContain('Reassign or delete those agents first');

    const db = getDb();
    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM providers WHERE id = $id').get({ $id: 'prov-in-use' }) as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });

  it('deletes an unused provider successfully', async () => {
    const response = await callRoute('DELETE', '/api/providers/prov-free');

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const body = await response!.json() as { data: { deleted: boolean } };
    expect(body.data.deleted).toBe(true);

    const db = getDb();
    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM providers WHERE id = $id').get({ $id: 'prov-free' }) as { cnt: number };
    expect(remaining.cnt).toBe(0);
  });
});
