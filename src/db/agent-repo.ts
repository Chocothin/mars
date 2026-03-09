import { getDb } from './index';
import type { Agent, AgentQuery, ReasoningLevel } from '../types/agent';

interface AgentRow {
  id: string;
  name: string;
  description: string;
  provider_id: string;
  model_id: string;
  system_prompt: string;
  reasoning_level: string;
  worker_count: number;
  mcp_server_ids: string;
  skill_ids: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    providerId: row.provider_id,
    modelId: row.model_id,
    systemPrompt: row.system_prompt,
    reasoningLevel: row.reasoning_level as ReasoningLevel,
    workerCount: row.worker_count,
    mcpServerIds: JSON.parse(row.mcp_server_ids) as string[],
    skillIds: JSON.parse(row.skill_ids) as string[],
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertAgent(agent: Agent): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO agents (id, name, description, provider_id, model_id, system_prompt, reasoning_level, worker_count, mcp_server_ids, skill_ids, enabled, created_at, updated_at)
    VALUES ($id, $name, $description, $providerId, $modelId, $systemPrompt, $reasoningLevel, $workerCount, $mcpServerIds, $skillIds, $enabled, $createdAt, $updatedAt)
  `);
  stmt.run({
    $id: agent.id,
    $name: agent.name,
    $description: agent.description,
    $providerId: agent.providerId,
    $modelId: agent.modelId,
    $systemPrompt: agent.systemPrompt,
    $reasoningLevel: agent.reasoningLevel,
    $workerCount: agent.workerCount,
    $mcpServerIds: JSON.stringify(agent.mcpServerIds),
    $skillIds: JSON.stringify(agent.skillIds ?? []),
    $enabled: agent.enabled ? 1 : 0,
    $createdAt: agent.createdAt,
    $updatedAt: agent.updatedAt,
  });
}

export function getAgentById(id: string): Agent | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM agents WHERE id = $id LIMIT 1');
  const row = stmt.get({ $id: id }) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

export function getAgentByName(name: string): Agent | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM agents WHERE name = $name LIMIT 1');
  const row = stmt.get({ $name: name }) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

export function updateAgent(id: string, updates: Partial<Agent>): boolean {
  const db = getDb();
  const setClauses: string[] = [];
  const params: Record<string, string | number | null> = { $id: id, $updatedAt: Date.now() };

  if (updates.name !== undefined) {
    setClauses.push('name = $name');
    params.$name = updates.name;
  }
  if (updates.description !== undefined) {
    setClauses.push('description = $description');
    params.$description = updates.description;
  }
  if (updates.providerId !== undefined) {
    setClauses.push('provider_id = $providerId');
    params.$providerId = updates.providerId;
  }
  if (updates.modelId !== undefined) {
    setClauses.push('model_id = $modelId');
    params.$modelId = updates.modelId;
  }
  if (updates.systemPrompt !== undefined) {
    setClauses.push('system_prompt = $systemPrompt');
    params.$systemPrompt = updates.systemPrompt;
  }
  if (updates.reasoningLevel !== undefined) {
    setClauses.push('reasoning_level = $reasoningLevel');
    params.$reasoningLevel = updates.reasoningLevel;
  }
  if (updates.workerCount !== undefined) {
    setClauses.push('worker_count = $workerCount');
    params.$workerCount = updates.workerCount;
  }
  if (updates.mcpServerIds !== undefined) {
    setClauses.push('mcp_server_ids = $mcpServerIds');
    params.$mcpServerIds = JSON.stringify(updates.mcpServerIds);
  }
  if (updates.skillIds !== undefined) {
    setClauses.push('skill_ids = $skillIds');
    params.$skillIds = JSON.stringify(updates.skillIds);
  }
  if (updates.enabled !== undefined) {
    setClauses.push('enabled = $enabled');
    params.$enabled = updates.enabled ? 1 : 0;
  }

  setClauses.push('updated_at = $updatedAt');

  const sql = `UPDATE agents SET ${setClauses.join(', ')} WHERE id = $id`;
  const stmt = db.prepare(sql);
  const result = stmt.run(params);

  return result.changes > 0;
}

export function deleteAgent(id: string): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM agents WHERE id = $id');
  const result = stmt.run({ $id: id });
  return result.changes > 0;
}

export function queryAgents(q: AgentQuery): Agent[] {
  const db = getDb();
  let sql = 'SELECT * FROM agents WHERE 1=1';
  const params: Record<string, string | number | null> = {};

  if (q.providerId) {
    sql += ' AND provider_id = $providerId';
    params.$providerId = q.providerId;
  }
  if (q.modelId) {
    sql += ' AND model_id = $modelId';
    params.$modelId = q.modelId;
  }
  if (q.reasoningLevel) {
    sql += ' AND reasoning_level = $reasoningLevel';
    params.$reasoningLevel = q.reasoningLevel;
  }
  if (q.enabled !== undefined) {
    sql += ' AND enabled = $enabled';
    params.$enabled = q.enabled ? 1 : 0;
  }
  if (q.search) {
    sql += ' AND (name LIKE $search OR description LIKE $search)';
    params.$search = `%${q.search}%`;
  }

  const sortField = q.sortBy === 'name' ? 'name' : q.sortBy === 'createdAt' ? 'created_at' : 'updated_at';
  const sortOrder = q.sortOrder === 'asc' ? 'ASC' : 'DESC';
  sql += ` ORDER BY ${sortField} ${sortOrder}`;

  if (q.limit) {
    sql += ' LIMIT $limit';
    params.$limit = q.limit;
  }
  if (q.offset) {
    sql += ' OFFSET $offset';
    params.$offset = q.offset;
  }

  const stmt = db.prepare(sql);
  const rows = stmt.all(params) as AgentRow[];
  return rows.map(rowToAgent);
}

export function countAgents(): number {
  const db = getDb();
  const stmt = db.prepare('SELECT COUNT(*) as cnt FROM agents');
  const row = stmt.get() as { cnt: number };
  return row.cnt;
}

export function countAgentsByProviderId(providerId: string): number {
  const db = getDb();
  const stmt = db.prepare('SELECT COUNT(*) as cnt FROM agents WHERE provider_id = $providerId');
  const row = stmt.get({ $providerId: providerId }) as { cnt: number };
  return row.cnt;
}
