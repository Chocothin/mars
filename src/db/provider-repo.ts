import { getDb } from './index';
import type { Provider, ProviderQuery, ProviderType, AuthMethod, ProviderConfig } from '../types/provider';

interface ProviderRow {
  id: string;
  name: string;
  description: string;
  provider_type: string;
  auth_method: string;
  api_key: string | null;
  base_url: string | null;
  enabled: number;
  is_default: number;
  config: string;
  created_at: number;
  updated_at: number;
}

function rowToProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    providerType: row.provider_type as ProviderType,
    authMethod: row.auth_method as AuthMethod,
    apiKey: row.api_key,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    config: JSON.parse(row.config) as ProviderConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertProvider(provider: Provider): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO providers (id, name, description, provider_type, auth_method, api_key, base_url, enabled, is_default, config, created_at, updated_at)
    VALUES ($id, $name, $description, $providerType, $authMethod, $apiKey, $baseUrl, $enabled, $isDefault, $config, $createdAt, $updatedAt)
  `);
  stmt.run({
    $id: provider.id,
    $name: provider.name,
    $description: provider.description,
    $providerType: provider.providerType,
    $authMethod: provider.authMethod,
    $apiKey: provider.apiKey,
    $baseUrl: provider.baseUrl,
    $enabled: provider.enabled ? 1 : 0,
    $isDefault: provider.isDefault ? 1 : 0,
    $config: JSON.stringify(provider.config),
    $createdAt: provider.createdAt,
    $updatedAt: provider.updatedAt,
  });
}

export function getProviderById(id: string): Provider | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM providers WHERE id = $id LIMIT 1');
  const row = stmt.get({ $id: id }) as ProviderRow | undefined;
  return row ? rowToProvider(row) : null;
}

export function getProviderByName(name: string): Provider | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM providers WHERE name = $name LIMIT 1');
  const row = stmt.get({ $name: name }) as ProviderRow | undefined;
  return row ? rowToProvider(row) : null;
}

export function getDefaultProvider(): Provider | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM providers WHERE is_default = 1 LIMIT 1');
  const row = stmt.get() as ProviderRow | undefined;
  return row ? rowToProvider(row) : null;
}

export function updateProvider(id: string, updates: Partial<Provider>): boolean {
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
  if (updates.providerType !== undefined) {
    setClauses.push('provider_type = $providerType');
    params.$providerType = updates.providerType;
  }
  if (updates.authMethod !== undefined) {
    setClauses.push('auth_method = $authMethod');
    params.$authMethod = updates.authMethod;
  }
  if (updates.apiKey !== undefined) {
    setClauses.push('api_key = $apiKey');
    params.$apiKey = updates.apiKey;
  }
  if (updates.baseUrl !== undefined) {
    setClauses.push('base_url = $baseUrl');
    params.$baseUrl = updates.baseUrl;
  }
  if (updates.enabled !== undefined) {
    setClauses.push('enabled = $enabled');
    params.$enabled = updates.enabled ? 1 : 0;
  }
  if (updates.isDefault !== undefined) {
    setClauses.push('is_default = $isDefault');
    params.$isDefault = updates.isDefault ? 1 : 0;
  }
  if (updates.config !== undefined) {
    setClauses.push('config = $config');
    params.$config = JSON.stringify(updates.config);
  }

  setClauses.push('updated_at = $updatedAt');

  const sql = `UPDATE providers SET ${setClauses.join(', ')} WHERE id = $id`;
  const stmt = db.prepare(sql);
  const result = stmt.run(params);

  return result.changes > 0;
}

export function clearDefaultProvider(): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE providers SET is_default = 0, updated_at = $updatedAt WHERE is_default = 1');
  stmt.run({ $updatedAt: Date.now() });
}

export function deleteProvider(id: string): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM providers WHERE id = $id');
  const result = stmt.run({ $id: id });
  return result.changes > 0;
}

export function queryProviders(q: ProviderQuery): Provider[] {
  const db = getDb();
  let sql = 'SELECT * FROM providers WHERE 1=1';
  const params: Record<string, string | number | null> = {};

  if (q.providerType) {
    sql += ' AND provider_type = $providerType';
    params.$providerType = q.providerType;
  }
  if (q.authMethod) {
    sql += ' AND auth_method = $authMethod';
    params.$authMethod = q.authMethod;
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
  const rows = stmt.all(params) as ProviderRow[];
  return rows.map(rowToProvider);
}

export function getProviderHealthSummary(): { total: number; enabled: number; disabled: number; status: 'healthy' | 'degraded' | 'offline' } {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled,
      SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END) as disabled
    FROM providers
  `);
  const row = stmt.get() as { total: number; enabled: number | null; disabled: number | null };

  const total = row.total;
  const enabled = row.enabled ?? 0;
  const disabled = row.disabled ?? 0;

  const status = enabled === 0 ? 'offline' : disabled > 0 ? 'degraded' : 'healthy';
  return { total, enabled, disabled, status };
}
