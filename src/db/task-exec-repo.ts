import { getDb } from './index';
import type {
  TaskExecution,
  TaskExecutionStatus,
  TaskExecutionInput,
  TaskExecutionOutput,
} from '../orchestrator/types';

interface TaskExecRow {
  id: string;
  run_id: string;
  task_id: string;
  agent_id: string;
  session_id: string | null;
  status: string;
  attempt: number;
  input: string;
  output: string | null;
  started_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  error: string | null;
}

function rowToTaskExecution(row: TaskExecRow): TaskExecution {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    status: row.status as TaskExecutionStatus,
    attempt: row.attempt,
    input: JSON.parse(row.input) as TaskExecutionInput,
    output: row.output ? (JSON.parse(row.output) as TaskExecutionOutput) : null,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    error: row.error,
  };
}

export function insertTaskExecution(exec: TaskExecution): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO task_executions (id, run_id, task_id, agent_id, session_id, status, attempt, input, output, started_at, completed_at, duration_ms, error)
    VALUES ($id, $runId, $taskId, $agentId, $sessionId, $status, $attempt, $input, $output, $startedAt, $completedAt, $durationMs, $error)
  `);
  stmt.run({
    $id: exec.id,
    $runId: exec.runId,
    $taskId: exec.taskId,
    $agentId: exec.agentId,
    $sessionId: exec.sessionId,
    $status: exec.status,
    $attempt: exec.attempt,
    $input: JSON.stringify(exec.input),
    $output: exec.output ? JSON.stringify(exec.output) : null,
    $startedAt: exec.startedAt,
    $completedAt: exec.completedAt,
    $durationMs: exec.durationMs,
    $error: exec.error,
  });
}

export function getTaskExecutionById(id: string): TaskExecution | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM task_executions WHERE id = $id LIMIT 1');
  const row = stmt.get({ $id: id }) as TaskExecRow | undefined;
  return row ? rowToTaskExecution(row) : null;
}

export function getTaskExecutionsByRunId(runId: string): TaskExecution[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM task_executions WHERE run_id = $runId ORDER BY started_at ASC');
  const rows = stmt.all({ $runId: runId }) as TaskExecRow[];
  return rows.map(rowToTaskExecution);
}

export function getTaskExecutionsByTaskId(taskId: string): TaskExecution[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM task_executions WHERE task_id = $taskId ORDER BY attempt ASC');
  const rows = stmt.all({ $taskId: taskId }) as TaskExecRow[];
  return rows.map(rowToTaskExecution);
}

export function updateTaskExecution(id: string, updates: Partial<TaskExecution>): boolean {
  const db = getDb();
  const setClauses: string[] = [];
  const params: Record<string, string | number | null> = { $id: id };

  if (updates.agentId !== undefined) {
    setClauses.push('agent_id = $agentId');
    params.$agentId = updates.agentId;
  }
  if (updates.status !== undefined) {
    setClauses.push('status = $status');
    params.$status = updates.status;
  }
  if (updates.sessionId !== undefined) {
    setClauses.push('session_id = $sessionId');
    params.$sessionId = updates.sessionId;
  }
  if (updates.attempt !== undefined) {
    setClauses.push('attempt = $attempt');
    params.$attempt = updates.attempt;
  }
  if (updates.input !== undefined) {
    setClauses.push('input = $input');
    params.$input = JSON.stringify(updates.input);
  }
  if (updates.output !== undefined) {
    setClauses.push('output = $output');
    params.$output = updates.output ? JSON.stringify(updates.output) : null;
  }
  if (updates.startedAt !== undefined) {
    setClauses.push('started_at = $startedAt');
    params.$startedAt = updates.startedAt;
  }
  if (updates.completedAt !== undefined) {
    setClauses.push('completed_at = $completedAt');
    params.$completedAt = updates.completedAt;
  }
  if (updates.durationMs !== undefined) {
    setClauses.push('duration_ms = $durationMs');
    params.$durationMs = updates.durationMs;
  }
  if (updates.error !== undefined) {
    setClauses.push('error = $error');
    params.$error = updates.error;
  }

  if (setClauses.length === 0) return false;

  const sql = `UPDATE task_executions SET ${setClauses.join(', ')} WHERE id = $id`;
  const stmt = db.prepare(sql);
  const result = stmt.run(params);

  return result.changes > 0;
}

export function deleteTaskExecution(id: string): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM task_executions WHERE id = $id');
  const result = stmt.run({ $id: id });
  return result.changes > 0;
}

export function deleteTaskExecutionsByRunId(runId: string): number {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM task_executions WHERE run_id = $runId');
  const result = stmt.run({ $runId: runId });
  return result.changes;
}
