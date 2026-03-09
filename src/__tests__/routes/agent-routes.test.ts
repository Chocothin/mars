import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { initDatabase, getDb } from '../../db/index';
import { handleAgentRoutes } from '../../routes/agents';

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
  return handleAgentRoutes(req, url);
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
    VALUES ('openai-provider', 'OpenAI', '', 'openai', 'api_key', 'test-key', NULL, 1, 1, '{}', ${now}, ${now})
  `);
  db.exec(`
    INSERT INTO agents (id, name, description, provider_id, model_id, system_prompt, reasoning_level, worker_count, mcp_server_ids, skill_ids, enabled, created_at, updated_at)
    VALUES ('agent-1', 'Agent One', '', 'openai-provider', 'gpt-5.3-codex', '', 'medium', 1, '[]', '[]', 1, ${now}, ${now})
  `);
  db.exec(`
    INSERT INTO agents (id, name, description, provider_id, model_id, system_prompt, reasoning_level, worker_count, mcp_server_ids, skill_ids, enabled, created_at, updated_at)
    VALUES ('agent-2', 'Legacy Agent', '', 'openai-provider', 'unknown-model', '', 'medium', 1, '[]', '[]', 1, ${now}, ${now})
  `);
});

describe('Agent routes modelName enrichment', () => {
  it('returns synced modelName for known provider catalog models', async () => {
    const response = await callRoute('GET', '/api/agents/agent-1');

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = await response!.json() as { data: { modelId: string; modelName: string } };
    expect(data.data.modelId).toBe('gpt-5.3-codex');
    expect(data.data.modelName).toBe('Codex 5.3');
  });

  it('falls back to modelId when the model is not in the provider catalog', async () => {
    const response = await callRoute('GET', '/api/agents/agent-2');

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = await response!.json() as { data: { modelId: string; modelName: string } };
    expect(data.data.modelId).toBe('unknown-model');
    expect(data.data.modelName).toBe('unknown-model');
  });

  it('includes synced modelName in list responses', async () => {
    const response = await callRoute('GET', '/api/agents?limit=10');

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = await response!.json() as { data: Array<{ id: string; modelName: string }> };
    const known = data.data.find((agent) => agent.id === 'agent-1');
    expect(known?.modelName).toBe('Codex 5.3');
  });

  it('keeps stale agents readable when their provider is missing', async () => {
    const db = getDb();
    db.exec("DELETE FROM providers WHERE id = 'openai-provider'");

    const detailResponse = await callRoute('GET', '/api/agents/agent-1');
    const listResponse = await callRoute('GET', '/api/agents?limit=10');

    expect(detailResponse).not.toBeNull();
    expect(detailResponse!.status).toBe(200);
    expect(listResponse).not.toBeNull();
    expect(listResponse!.status).toBe(200);

    const detailData = await detailResponse!.json() as { data: { modelId: string; modelName: string } };
    const listData = await listResponse!.json() as { data: Array<{ id: string; modelName: string }> };

    expect(detailData.data.modelName).toBe(detailData.data.modelId);
    expect(listData.data.find((agent) => agent.id === 'agent-1')?.modelName).toBe('gpt-5.3-codex');
  });
});
