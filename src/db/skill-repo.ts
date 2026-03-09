import { getDb } from './index';
import type { SkillQuery } from '../types/skill';

interface SkillRow {
  id: string;
  name: string;
  file_path: string;
  created_at: number;
  updated_at: number;
}

export interface SkillMetadata {
  id: string;
  name: string;
  filePath: string;
  createdAt: number;
  updatedAt: number;
}

function rowToMetadata(row: SkillRow): SkillMetadata {
  return {
    id: row.id,
    name: row.name,
    filePath: row.file_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertSkill(meta: SkillMetadata): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO skills (id, name, file_path, created_at, updated_at)
    VALUES ($id, $name, $filePath, $createdAt, $updatedAt)
  `);
  stmt.run({
    $id: meta.id,
    $name: meta.name,
    $filePath: meta.filePath,
    $createdAt: meta.createdAt,
    $updatedAt: meta.updatedAt,
  });
}

export function getSkillById(id: string): SkillMetadata | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM skills WHERE id = $id');
  const row = stmt.get({ $id: id }) as SkillRow | null;
  return row ? rowToMetadata(row) : null;
}

export function getSkillByName(name: string): SkillMetadata | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM skills WHERE name = $name');
  const row = stmt.get({ $name: name }) as SkillRow | null;
  return row ? rowToMetadata(row) : null;
}

export function updateSkillMeta(id: string, updates: Partial<SkillMetadata>): boolean {
  const db = getDb();
  const setClauses: string[] = [];
  const params: Record<string, string | number | null> = { $id: id };

  if (updates.name !== undefined) {
    setClauses.push('name = $name');
    params.$name = updates.name;
  }
  if (updates.filePath !== undefined) {
    setClauses.push('file_path = $filePath');
    params.$filePath = updates.filePath;
  }

  setClauses.push('updated_at = $updatedAt');
  params.$updatedAt = Date.now();

  if (setClauses.length <= 1) return false;

  const sql = `UPDATE skills SET ${setClauses.join(', ')} WHERE id = $id`;
  const stmt = db.prepare(sql);
  const result = stmt.run(params);
  return result.changes > 0;
}

export function deleteSkill(id: string): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM skills WHERE id = $id');
  const result = stmt.run({ $id: id });
  return result.changes > 0;
}

export function querySkills(q: SkillQuery): SkillMetadata[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (q.search !== undefined) {
    conditions.push('name LIKE $search');
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

  const sql = `SELECT * FROM skills ${whereClause} ORDER BY ${sortColumn} ${sortOrder} LIMIT ${limit} OFFSET ${offset}`;
  const stmt = db.prepare(sql);
  const rows = stmt.all(params) as SkillRow[];
  return rows.map(rowToMetadata);
}
