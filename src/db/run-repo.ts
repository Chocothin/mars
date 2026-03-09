import { getDb } from './index';
import type {
  Run,
  RunStatus,
  RunConfig,
  ExecutionPlan,
  RunResult,
} from '../orchestrator/types';

interface RunRow {
  id: string;
  project_id: string;
  root_task_ids: string;
  status: string;
  config: string;
  execution_plan: string | null;
  result: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    projectId: row.project_id,
    rootTaskIds: JSON.parse(row.root_task_ids) as string[],
    status: row.status as RunStatus,
    config: JSON.parse(row.config) as RunConfig,
    executionPlan: row.execution_plan ? (JSON.parse(row.execution_plan) as ExecutionPlan) : null,
    result: row.result ? (JSON.parse(row.result) as RunResult) : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function insertRun(run: Run): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO runs (id, project_id, root_task_ids, status, config, execution_plan, result, created_at, started_at, completed_at)
    VALUES ($id, $projectId, $rootTaskIds, $status, $config, $executionPlan, $result, $createdAt, $startedAt, $completedAt)
  `);
  stmt.run({
    $id: run.id,
    $projectId: run.projectId,
    $rootTaskIds: JSON.stringify(run.rootTaskIds),
    $status: run.status,
    $config: JSON.stringify(run.config),
    $executionPlan: run.executionPlan ? JSON.stringify(run.executionPlan) : null,
    $result: run.result ? JSON.stringify(run.result) : null,
    $createdAt: run.createdAt,
    $startedAt: run.startedAt,
    $completedAt: run.completedAt,
  });
}

export function getRunById(id: string): Run | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM runs WHERE id = $id LIMIT 1');
  const row = stmt.get({ $id: id }) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function updateRun(id: string, updates: Partial<Run>): boolean {
  const db = getDb();
  const setClauses: string[] = [];
  const params: Record<string, string | number | null> = { $id: id };

  if (updates.status !== undefined) {
    setClauses.push('status = $status');
    params.$status = updates.status;
  }
  if (updates.rootTaskIds !== undefined) {
    setClauses.push('root_task_ids = $rootTaskIds');
    params.$rootTaskIds = JSON.stringify(updates.rootTaskIds);
  }
  if (updates.config !== undefined) {
    setClauses.push('config = $config');
    params.$config = JSON.stringify(updates.config);
  }
  if (updates.executionPlan !== undefined) {
    setClauses.push('execution_plan = $executionPlan');
    params.$executionPlan = updates.executionPlan ? JSON.stringify(updates.executionPlan) : null;
  }
  if (updates.result !== undefined) {
    setClauses.push('result = $result');
    params.$result = updates.result ? JSON.stringify(updates.result) : null;
  }
  if (updates.startedAt !== undefined) {
    setClauses.push('started_at = $startedAt');
    params.$startedAt = updates.startedAt;
  }
  if (updates.completedAt !== undefined) {
    setClauses.push('completed_at = $completedAt');
    params.$completedAt = updates.completedAt;
  }

  if (setClauses.length === 0) return false;

  const sql = `UPDATE runs SET ${setClauses.join(', ')} WHERE id = $id`;
  const stmt = db.prepare(sql);
  const result = stmt.run(params);

  return result.changes > 0;
}

export interface RunQuery {
  projectId?: string;
  status?: RunStatus;
  sortBy?: 'createdAt' | 'startedAt';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export function queryRuns(q: RunQuery): Run[] {
  const db = getDb();
  let sql = 'SELECT * FROM runs WHERE 1=1';
  const params: Record<string, string | number | null> = {};

  if (q.projectId) {
    sql += ' AND project_id = $projectId';
    params.$projectId = q.projectId;
  }
  if (q.status) {
    sql += ' AND status = $status';
    params.$status = q.status;
  }

  const sortField = q.sortBy === 'startedAt' ? 'started_at' : 'created_at';
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
  const rows = stmt.all(params) as RunRow[];
  return rows.map(rowToRun);
}

export function deleteRun(id: string): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM runs WHERE id = $id');
  const result = stmt.run({ $id: id });
  return result.changes > 0;
}
