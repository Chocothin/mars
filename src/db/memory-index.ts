import { getDb } from './index';
import type { MemoryMetadata, MemoryQuery, MemoryStats, MemoryTier } from '../types/memory';

interface MemoryFileRow {
  id: string;
  tier: string;
  scope: string;
  filename: string;
  file_path: string;
  size_bytes: number;
  token_count: number;
  is_protected: number;
  tags: string | null;
  created_at: number;
  updated_at: number;
  last_accessed_at: number;
  access_count: number;
  checksum: string;
}

function rowToMetadata(row: MemoryFileRow): MemoryMetadata {
  return {
    id: row.id,
    tier: row.tier as MemoryTier,
    scope: row.scope,
    filename: row.filename,
    filePath: row.file_path,
    sizeBytes: row.size_bytes,
    tokenCount: row.token_count,
    isProtected: row.is_protected === 1,
    tags: row.tags ? JSON.parse(row.tags) as string[] : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    checksum: row.checksum,
  };
}

export function indexFile(metadata: MemoryMetadata): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO memory_files (id, tier, scope, filename, file_path, size_bytes, token_count, is_protected, tags, created_at, updated_at, last_accessed_at, access_count, checksum)
    VALUES ($id, $tier, $scope, $filename, $filePath, $sizeBytes, $tokenCount, $isProtected, $tags, $createdAt, $updatedAt, $lastAccessedAt, $accessCount, $checksum)
  `);
  stmt.run({
    $id: metadata.id,
    $tier: metadata.tier,
    $scope: metadata.scope,
    $filename: metadata.filename,
    $filePath: metadata.filePath,
    $sizeBytes: metadata.sizeBytes,
    $tokenCount: metadata.tokenCount,
    $isProtected: metadata.isProtected ? 1 : 0,
    $tags: JSON.stringify(metadata.tags),
    $createdAt: metadata.createdAt,
    $updatedAt: metadata.updatedAt,
    $lastAccessedAt: metadata.lastAccessedAt,
    $accessCount: metadata.accessCount,
    $checksum: metadata.checksum,
  });
}

export function updateMetadata(id: string, updates: Partial<MemoryMetadata>): boolean {
  const db = getDb();
  const setClauses: string[] = [];
  const params: Record<string, string | number> = { $id: id };

  if (updates.filename !== undefined) {
    setClauses.push('filename = $filename');
    params.$filename = updates.filename;
  }
  if (updates.filePath !== undefined) {
    setClauses.push('file_path = $filePath');
    params.$filePath = updates.filePath;
  }
  if (updates.sizeBytes !== undefined) {
    setClauses.push('size_bytes = $sizeBytes');
    params.$sizeBytes = updates.sizeBytes;
  }
  if (updates.tokenCount !== undefined) {
    setClauses.push('token_count = $tokenCount');
    params.$tokenCount = updates.tokenCount;
  }
  if (updates.isProtected !== undefined) {
    setClauses.push('is_protected = $isProtected');
    params.$isProtected = updates.isProtected ? 1 : 0;
  }
  if (updates.tags !== undefined) {
    setClauses.push('tags = $tags');
    params.$tags = JSON.stringify(updates.tags);
  }
  if (updates.checksum !== undefined) {
    setClauses.push('checksum = $checksum');
    params.$checksum = updates.checksum;
  }
  if (updates.updatedAt !== undefined) {
    setClauses.push('updated_at = $updatedAt');
    params.$updatedAt = updates.updatedAt;
  }

  if (setClauses.length === 0) return false;

  const sql = `UPDATE memory_files SET ${setClauses.join(', ')} WHERE id = $id`;
  const stmt = db.prepare(sql);
  const result = stmt.run(params);
  return result.changes > 0;
}

export function removeFile(id: string): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM memory_files WHERE id = $id');
  const result = stmt.run({ $id: id });
  return result.changes > 0;
}

export function queryFiles(q: MemoryQuery): MemoryMetadata[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (q.tier !== undefined) {
    conditions.push('tier = $tier');
    params.$tier = q.tier;
  }
  if (q.scope !== undefined) {
    conditions.push('scope = $scope');
    params.$scope = q.scope;
  }
  if (q.isProtected !== undefined) {
    conditions.push('is_protected = $isProtected');
    params.$isProtected = q.isProtected ? 1 : 0;
  }
  if (q.tags && q.tags.length > 0) {
    const tagConditions = q.tags.map((tag, i) => {
      const paramKey = `$tag${i}`;
      params[paramKey] = `%"${tag}"%`;
      return `tags LIKE ${paramKey}`;
    });
    conditions.push(`(${tagConditions.join(' AND ')})`);
  }
  if (q.search !== undefined) {
    conditions.push('(filename LIKE $search OR file_path LIKE $search)');
    params.$search = `%${q.search}%`;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sortColumnMap: Record<string, string> = {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    lastAccessedAt: 'last_accessed_at',
    sizeBytes: 'size_bytes',
    tokenCount: 'token_count',
  };
  const sortColumn = q.sortBy ? sortColumnMap[q.sortBy] ?? 'updated_at' : 'updated_at';
  const sortOrder = q.sortOrder === 'asc' ? 'ASC' : 'DESC';

  const limit = q.limit ?? 50;
  const offset = q.offset ?? 0;

  const sql = `SELECT * FROM memory_files ${whereClause} ORDER BY ${sortColumn} ${sortOrder} LIMIT ${limit} OFFSET ${offset}`;
  const stmt = db.prepare(sql);
  const rows = stmt.all(params) as MemoryFileRow[];
  return rows.map(rowToMetadata);
}

export function getById(id: string): MemoryMetadata | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM memory_files WHERE id = $id');
  const row = stmt.get({ $id: id }) as MemoryFileRow | null;
  return row ? rowToMetadata(row) : null;
}

export function recordAccess(id: string): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE memory_files
    SET last_accessed_at = $now, access_count = access_count + 1
    WHERE id = $id
  `);
  stmt.run({ $id: id, $now: Date.now() });
}

interface StatsRow {
  total_files: number;
  total_size: number;
  total_tokens: number;
  protected_files: number;
  compactable_files: number;
}

interface TierStatsRow {
  tier: string;
  files: number;
  size_bytes: number;
  tokens: number;
}

export function getStats(tier?: MemoryTier, scope?: string): MemoryStats {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (tier !== undefined) {
    conditions.push('tier = $tier');
    params.$tier = tier;
  }
  if (scope !== undefined) {
    conditions.push('scope = $scope');
    params.$scope = scope;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const summaryStmt = db.prepare(`
    SELECT
      COUNT(*) as total_files,
      COALESCE(SUM(size_bytes), 0) as total_size,
      COALESCE(SUM(token_count), 0) as total_tokens,
      COALESCE(SUM(CASE WHEN is_protected = 1 THEN 1 ELSE 0 END), 0) as protected_files,
      COALESCE(SUM(CASE WHEN is_protected = 0 THEN 1 ELSE 0 END), 0) as compactable_files
    FROM memory_files ${whereClause}
  `);
  const summary = summaryStmt.get(params) as StatsRow;

  const tierStmt = db.prepare(`
    SELECT
      tier,
      COUNT(*) as files,
      COALESCE(SUM(size_bytes), 0) as size_bytes,
      COALESCE(SUM(token_count), 0) as tokens
    FROM memory_files ${whereClause}
    GROUP BY tier
  `);
  const tierRows = tierStmt.all(params) as TierStatsRow[];

  const emptyTierStats = { files: 0, sizeBytes: 0, tokens: 0 };
  const byTier: Record<MemoryTier, { files: number; sizeBytes: number; tokens: number }> = {
    global: { ...emptyTierStats },
    project: { ...emptyTierStats },
    agent: { ...emptyTierStats },
  };

  for (const row of tierRows) {
    const t = row.tier as MemoryTier;
    if (t in byTier) {
      byTier[t] = { files: row.files, sizeBytes: row.size_bytes, tokens: row.tokens };
    }
  }

  return {
    totalFiles: summary.total_files,
    totalSizeBytes: summary.total_size,
    totalTokens: summary.total_tokens,
    protectedFiles: summary.protected_files,
    compactableFiles: summary.compactable_files,
    byTier,
  };
}
