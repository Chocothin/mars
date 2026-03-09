import { getDb } from './index';
import type { Project, ProjectQuery, ProjectStatus } from '../types/project';

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  directory_path: string;
  provider_id: string;
  status: string;
  agent_ids: string;
  mcp_server_ids: string;
  created_at: number;
  updated_at: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    directoryPath: row.directory_path,
    providerId: row.provider_id || undefined,
    status: row.status as ProjectStatus,
    agentIds: JSON.parse(row.agent_ids) as string[],
    mcpServerIds: JSON.parse(row.mcp_server_ids) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertProject(project: Project): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO projects (id, name, description, instructions, directory_path, provider_id, status, agent_ids, mcp_server_ids, created_at, updated_at)
    VALUES ($id, $name, $description, $instructions, $directoryPath, $providerId, $status, $agentIds, $mcpServerIds, $createdAt, $updatedAt)
  `);
  stmt.run({
    $id: project.id,
    $name: project.name,
    $description: project.description,
    $instructions: project.instructions,
    $directoryPath: project.directoryPath,
    $providerId: project.providerId ?? '',
    $status: project.status,
    $agentIds: JSON.stringify(project.agentIds),
    $mcpServerIds: JSON.stringify(project.mcpServerIds),
    $createdAt: project.createdAt,
    $updatedAt: project.updatedAt,
  });
}

export function getProjectById(id: string): Project | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM projects WHERE id = $id');
  const row = stmt.get({ $id: id }) as ProjectRow | null;
  return row ? rowToProject(row) : null;
}

export function getProjectByDirectory(directoryPath: string): Project | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM projects WHERE directory_path = $directoryPath');
  const row = stmt.get({ $directoryPath: directoryPath }) as ProjectRow | null;
  return row ? rowToProject(row) : null;
}

export function updateProject(id: string, updates: Partial<Project>): boolean {
  const db = getDb();
  const setClauses: string[] = [];
  const params: Record<string, string | number> = { $id: id };

  if (updates.name !== undefined) {
    setClauses.push('name = $name');
    params.$name = updates.name;
  }
  if (updates.description !== undefined) {
    setClauses.push('description = $description');
    params.$description = updates.description;
  }
  if (updates.instructions !== undefined) {
    setClauses.push('instructions = $instructions');
    params.$instructions = updates.instructions;
  }
  if (updates.providerId !== undefined) {
    setClauses.push('provider_id = $providerId');
    params.$providerId = updates.providerId;
  }
  if (updates.status !== undefined) {
    setClauses.push('status = $status');
    params.$status = updates.status;
  }
  if (updates.agentIds !== undefined) {
    setClauses.push('agent_ids = $agentIds');
    params.$agentIds = JSON.stringify(updates.agentIds);
  }
  if (updates.mcpServerIds !== undefined) {
    setClauses.push('mcp_server_ids = $mcpServerIds');
    params.$mcpServerIds = JSON.stringify(updates.mcpServerIds);
  }

  setClauses.push('updated_at = $updatedAt');
  params.$updatedAt = Date.now();

  if (setClauses.length <= 1) return false;

  const sql = `UPDATE projects SET ${setClauses.join(', ')} WHERE id = $id`;
  const stmt = db.prepare(sql);
  const result = stmt.run(params);
  return result.changes > 0;
}

export function deleteProject(id: string): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM projects WHERE id = $id');
  const result = stmt.run({ $id: id });
  return result.changes > 0;
}

export function queryProjects(q: ProjectQuery): Project[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (q.status !== undefined) {
    conditions.push('status = $status');
    params.$status = q.status;
  }
  if (q.search !== undefined) {
    conditions.push('(name LIKE $search OR description LIKE $search)');
    params.$search = `%${q.search}%`;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sortColumnMap: Record<string, string> = {
    name: 'name',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  };
  const sortColumn = q.sortBy ? sortColumnMap[q.sortBy] ?? 'updated_at' : 'updated_at';
  const sortOrder = q.sortOrder === 'asc' ? 'ASC' : 'DESC';

  const limit = q.limit ?? 50;
  const offset = q.offset ?? 0;

  const sql = `SELECT * FROM projects ${whereClause} ORDER BY ${sortColumn} ${sortOrder} LIMIT ${limit} OFFSET ${offset}`;
  const stmt = db.prepare(sql);
  const rows = stmt.all(params) as ProjectRow[];
  return rows.map(rowToProject);
}

export function countProjects(): number {
  const db = getDb();
  const stmt = db.prepare('SELECT COUNT(*) as cnt FROM projects');
  const row = stmt.get() as { cnt: number };
  return row.cnt;
}
