import { getDb } from './index';
import type { McpServer, McpServerQuery, TransportType } from '../types/mcp-server';

interface McpServerRow {
  id: string;
  name: string;
  description: string;
  transport_type: string;
  command: string | null;
  args: string;
  url: string | null;
  headers: string;
  env: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function rowToMcpServer(row: McpServerRow): McpServer {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    transportType: row.transport_type as TransportType,
    command: row.command,
    args: JSON.parse(row.args) as string[],
    url: row.url,
    headers: JSON.parse(row.headers) as Record<string, string>,
    env: JSON.parse(row.env) as Record<string, string>,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertMcpServer(server: McpServer): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO mcp_servers (id, name, description, transport_type, command, args, url, headers, env, enabled, created_at, updated_at)
    VALUES ($id, $name, $description, $transportType, $command, $args, $url, $headers, $env, $enabled, $createdAt, $updatedAt)
  `);
  stmt.run({
    $id: server.id,
    $name: server.name,
    $description: server.description,
    $transportType: server.transportType,
    $command: server.command,
    $args: JSON.stringify(server.args),
    $url: server.url,
    $headers: JSON.stringify(server.headers),
    $env: JSON.stringify(server.env),
    $enabled: server.enabled ? 1 : 0,
    $createdAt: server.createdAt,
    $updatedAt: server.updatedAt,
  });
}

export function getMcpServerById(id: string): McpServer | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM mcp_servers WHERE id = $id');
  const row = stmt.get({ $id: id }) as McpServerRow | null;
  return row ? rowToMcpServer(row) : null;
}

export function getMcpServerByName(name: string): McpServer | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM mcp_servers WHERE name = $name');
  const row = stmt.get({ $name: name }) as McpServerRow | null;
  return row ? rowToMcpServer(row) : null;
}

export function updateMcpServer(id: string, updates: Partial<McpServer>): boolean {
  const db = getDb();
  const setClauses: string[] = [];
  const params: Record<string, string | number | null> = { $id: id };

  if (updates.name !== undefined) {
    setClauses.push('name = $name');
    params.$name = updates.name;
  }
  if (updates.description !== undefined) {
    setClauses.push('description = $description');
    params.$description = updates.description;
  }
  if (updates.transportType !== undefined) {
    setClauses.push('transport_type = $transportType');
    params.$transportType = updates.transportType;
  }
  if (updates.command !== undefined) {
    setClauses.push('command = $command');
    params.$command = updates.command;
  }
  if (updates.args !== undefined) {
    setClauses.push('args = $args');
    params.$args = JSON.stringify(updates.args);
  }
  if (updates.url !== undefined) {
    setClauses.push('url = $url');
    params.$url = updates.url;
  }
  if (updates.headers !== undefined) {
    setClauses.push('headers = $headers');
    params.$headers = JSON.stringify(updates.headers);
  }
  if (updates.env !== undefined) {
    setClauses.push('env = $env');
    params.$env = JSON.stringify(updates.env);
  }
  if (updates.enabled !== undefined) {
    setClauses.push('enabled = $enabled');
    params.$enabled = updates.enabled ? 1 : 0;
  }

  setClauses.push('updated_at = $updatedAt');
  params.$updatedAt = Date.now();

  if (setClauses.length <= 1) return false;

  const sql = `UPDATE mcp_servers SET ${setClauses.join(', ')} WHERE id = $id`;
  const stmt = db.prepare(sql);
  const result = stmt.run(params);
  return result.changes > 0;
}

export function deleteMcpServer(id: string): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM mcp_servers WHERE id = $id');
  const result = stmt.run({ $id: id });
  return result.changes > 0;
}

export function queryMcpServers(q: McpServerQuery): McpServer[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (q.transportType !== undefined) {
    conditions.push('transport_type = $transportType');
    params.$transportType = q.transportType;
  }
  if (q.enabled !== undefined) {
    conditions.push('enabled = $enabled');
    params.$enabled = q.enabled ? 1 : 0;
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

  const sql = `SELECT * FROM mcp_servers ${whereClause} ORDER BY ${sortColumn} ${sortOrder} LIMIT ${limit} OFFSET ${offset}`;
  const stmt = db.prepare(sql);
  const rows = stmt.all(params) as McpServerRow[];
  return rows.map(rowToMcpServer);
}

export function getMcpServerHealthSummary(): { total: number; enabled: number; disabled: number; status: 'healthy' | 'degraded' | 'offline' } {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled,
      SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END) as disabled
    FROM mcp_servers
  `);
  const row = stmt.get() as { total: number; enabled: number | null; disabled: number | null };

  const total = row.total;
  const enabled = row.enabled ?? 0;
  const disabled = row.disabled ?? 0;

  const status = enabled === 0 ? 'offline' : disabled > 0 ? 'degraded' : 'healthy';
  return { total, enabled, disabled, status };
}
