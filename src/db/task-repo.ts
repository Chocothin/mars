import { getDb } from './index';
import type { Task, TaskQuery, TaskDependency } from '../types/task';
import type { TaskStatus } from '../types/project';

interface TaskRow {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  title: string;
  description: string;
  status: string;
  priority: string;
  order: number;
  assigned_agent_type: string | null;
  assigned_agent_id: string | null;
  acceptance_criteria: string;
  expected_outputs: string;
  max_retries: number;
  retry_count: number;
  review_feedback: string | null;
  created_at: number;
  updated_at: number;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    description: row.description,
    status: row.status as Task['status'],
    priority: row.priority as Task['priority'],
    order: row.order,
    assignedAgentType: JSON.parse(row.assigned_agent_type || '[]') as string[],
    assignedAgentId: row.assigned_agent_id,
    dependsOnTaskIds: getDependencyIds(row.id),
    acceptanceCriteria: JSON.parse(row.acceptance_criteria || '[]'),
    expectedOutputs: JSON.parse(row.expected_outputs || '[]'),
    maxRetries: row.max_retries ?? 2,
    retryCount: row.retry_count ?? 0,
    reviewFeedback: row.review_feedback ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertTask(task: Task): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO tasks (id, project_id, parent_task_id, title, description, status, priority, "order", assigned_agent_type, assigned_agent_id, acceptance_criteria, expected_outputs, max_retries, retry_count, review_feedback, created_at, updated_at)
    VALUES ($id, $projectId, $parentTaskId, $title, $description, $status, $priority, $order, $assignedAgentType, $assignedAgentId, $acceptanceCriteria, $expectedOutputs, $maxRetries, $retryCount, $reviewFeedback, $createdAt, $updatedAt)
  `);
  stmt.run({
    $id: task.id,
    $projectId: task.projectId,
    $parentTaskId: task.parentTaskId,
    $title: task.title,
    $description: task.description,
    $status: task.status,
    $priority: task.priority,
    $order: task.order,
    $assignedAgentType: task.assignedAgentType.length > 0 ? JSON.stringify(task.assignedAgentType) : null,
    $assignedAgentId: task.assignedAgentId,
    $acceptanceCriteria: JSON.stringify(task.acceptanceCriteria ?? []),
    $expectedOutputs: JSON.stringify(task.expectedOutputs ?? []),
    $maxRetries: task.maxRetries ?? 2,
    $retryCount: task.retryCount ?? 0,
    $reviewFeedback: task.reviewFeedback ?? null,
    $createdAt: task.createdAt,
    $updatedAt: task.updatedAt,
  });
}

export function getTaskById(projectId: string, taskId: string): Task | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM tasks WHERE id = $id AND project_id = $projectId');
  const row = stmt.get({ $id: taskId, $projectId: projectId }) as TaskRow | null;
  return row ? rowToTask(row) : null;
}

export function getTaskByIdGlobal(taskId: string): Task | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM tasks WHERE id = $id');
  const row = stmt.get({ $id: taskId }) as TaskRow | null;
  return row ? rowToTask(row) : null;
}

export function updateTask(taskId: string, updates: Partial<Task>): boolean {
  const db = getDb();
  const setClauses: string[] = [];
  const params: Record<string, string | number | null> = { $id: taskId };

  if (updates.title !== undefined) {
    setClauses.push('title = $title');
    params.$title = updates.title;
  }
  if (updates.description !== undefined) {
    setClauses.push('description = $description');
    params.$description = updates.description;
  }
  if (updates.status !== undefined) {
    setClauses.push('status = $status');
    params.$status = updates.status;
  }
  if (updates.priority !== undefined) {
    setClauses.push('priority = $priority');
    params.$priority = updates.priority;
  }
  if (updates.order !== undefined) {
    setClauses.push('"order" = $order');
    params.$order = updates.order;
  }
  if (updates.assignedAgentType !== undefined) {
    setClauses.push('assigned_agent_type = $assignedAgentType');
    const types = updates.assignedAgentType;
    params.$assignedAgentType = types && types.length > 0 ? JSON.stringify(types) : null;
  }
  if (updates.assignedAgentId !== undefined) {
    setClauses.push('assigned_agent_id = $assignedAgentId');
    params.$assignedAgentId = updates.assignedAgentId;
  }
  if (updates.acceptanceCriteria !== undefined) {
    setClauses.push('acceptance_criteria = $acceptanceCriteria');
    params.$acceptanceCriteria = JSON.stringify(updates.acceptanceCriteria);
  }
  if (updates.expectedOutputs !== undefined) {
    setClauses.push('expected_outputs = $expectedOutputs');
    params.$expectedOutputs = JSON.stringify(updates.expectedOutputs);
  }
  if (updates.maxRetries !== undefined) {
    setClauses.push('max_retries = $maxRetries');
    params.$maxRetries = updates.maxRetries;
  }
  if (updates.retryCount !== undefined) {
    setClauses.push('retry_count = $retryCount');
    params.$retryCount = updates.retryCount;
  }
  if (updates.reviewFeedback !== undefined) {
    setClauses.push('review_feedback = $reviewFeedback');
    params.$reviewFeedback = updates.reviewFeedback;
  }

  setClauses.push('updated_at = $updatedAt');
  params.$updatedAt = Date.now();

  if (setClauses.length <= 1) return false;

  const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = $id`;
  const stmt = db.prepare(sql);
  const result = stmt.run(params);
  return result.changes > 0;
}

export function deleteTask(projectId: string, taskId: string): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM tasks WHERE id = $id AND project_id = $projectId');
  const result = stmt.run({ $id: taskId, $projectId: projectId });
  return result.changes > 0;
}

export function queryTasks(projectId: string, q: TaskQuery): Task[] {
  const db = getDb();
  const conditions: string[] = ['project_id = $projectId'];
  const params: Record<string, string | number | null> = { $projectId: projectId };

  if (q.status !== undefined) {
    conditions.push('status = $status');
    params.$status = q.status;
  }
  if (q.priority !== undefined) {
    conditions.push('priority = $priority');
    params.$priority = q.priority;
  }
  if (q.parentTaskId !== undefined) {
    if (q.parentTaskId === null) {
      conditions.push('parent_task_id IS NULL');
    } else {
      conditions.push('parent_task_id = $parentTaskId');
      params.$parentTaskId = q.parentTaskId;
    }
  }
  if (q.assignedAgentType !== undefined) {
    conditions.push('EXISTS (SELECT 1 FROM json_each(assigned_agent_type) WHERE json_each.value = $assignedAgentType)');
    params.$assignedAgentType = q.assignedAgentType;
  }
  if (q.assignedAgentId !== undefined) {
    conditions.push('assigned_agent_id = $assignedAgentId');
    params.$assignedAgentId = q.assignedAgentId;
  }
  if (q.search !== undefined) {
    conditions.push('(title LIKE $search OR description LIKE $search)');
    params.$search = `%${q.search}%`;
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const sortColumnMap: Record<string, string> = {
    order: '"order"',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    priority: 'priority',
  };
  const sortColumn = q.sortBy ? sortColumnMap[q.sortBy] ?? '"order"' : '"order"';
  const sortOrder = q.sortOrder === 'desc' ? 'DESC' : 'ASC';

  const limit = q.limit ?? 100;
  const offset = q.offset ?? 0;

  const sql = `SELECT * FROM tasks ${whereClause} ORDER BY ${sortColumn} ${sortOrder} LIMIT ${limit} OFFSET ${offset}`;
  const stmt = db.prepare(sql);
  const rows = stmt.all(params) as TaskRow[];
  return rows.map(rowToTask);
}

export function queryTasksGlobal(q: TaskQuery & { projectId?: string }): Task[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, string | number | null> = {};

  if (q.projectId !== undefined) {
    conditions.push('project_id = $projectId');
    params.$projectId = q.projectId;
  }
  if (q.status !== undefined) {
    conditions.push('status = $status');
    params.$status = q.status;
  }
  if (q.priority !== undefined) {
    conditions.push('priority = $priority');
    params.$priority = q.priority;
  }
  if (q.parentTaskId !== undefined) {
    if (q.parentTaskId === null) {
      conditions.push('parent_task_id IS NULL');
    } else {
      conditions.push('parent_task_id = $parentTaskId');
      params.$parentTaskId = q.parentTaskId;
    }
  }
  if (q.assignedAgentType !== undefined) {
    conditions.push('EXISTS (SELECT 1 FROM json_each(assigned_agent_type) WHERE json_each.value = $assignedAgentType)');
    params.$assignedAgentType = q.assignedAgentType;
  }
  if (q.assignedAgentId !== undefined) {
    conditions.push('assigned_agent_id = $assignedAgentId');
    params.$assignedAgentId = q.assignedAgentId;
  }
  if (q.search !== undefined) {
    conditions.push('(title LIKE $search OR description LIKE $search)');
    params.$search = `%${q.search}%`;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sortColumnMap: Record<string, string> = {
    order: '"order"',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    priority: 'priority',
  };
  const sortColumn = q.sortBy ? sortColumnMap[q.sortBy] ?? '"order"' : '"order"';
  const sortOrder = q.sortOrder === 'desc' ? 'DESC' : 'ASC';

  const limit = q.limit ?? 100;
  const offset = q.offset ?? 0;

  const sql = `SELECT * FROM tasks ${whereClause} ORDER BY ${sortColumn} ${sortOrder} LIMIT ${limit} OFFSET ${offset}`;
  const stmt = db.prepare(sql);
  const rows = stmt.all(params) as TaskRow[];
  return rows.map(rowToTask);
}

export function countTasks(projectId?: string): number {
  const db = getDb();

  if (projectId) {
    const scopedStmt = db.prepare('SELECT COUNT(*) as cnt FROM tasks WHERE project_id = $projectId');
    const row = scopedStmt.get({ $projectId: projectId }) as { cnt: number };
    return row.cnt;
  }

  const stmt = db.prepare('SELECT COUNT(*) as cnt FROM tasks');
  const row = stmt.get() as { cnt: number };
  return row.cnt;
}

export function getTaskStatusBreakdown(projectId?: string): Record<string, number> {
  const db = getDb();

  const sql = projectId
    ? 'SELECT status, COUNT(*) as cnt FROM tasks WHERE project_id = $projectId GROUP BY status'
    : 'SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status';

  const stmt = db.prepare(sql);
  const rows = projectId
    ? (stmt.all({ $projectId: projectId }) as Array<{ status: string; cnt: number }>)
    : (stmt.all() as Array<{ status: string; cnt: number }>);

  const breakdown: Record<string, number> = {};
  for (const row of rows) {
    breakdown[row.status] = row.cnt;
  }

  return breakdown;
}

export function getMaxOrder(projectId: string, status: TaskStatus): number {
  const db = getDb();
  const stmt = db.prepare('SELECT MAX("order") as max_order FROM tasks WHERE project_id = $projectId AND status = $status');
  const row = stmt.get({ $projectId: projectId, $status: status }) as { max_order: number | null } | null;
  return row?.max_order ?? -1;
}

export function getTasksByColumn(projectId: string, status: TaskStatus): Task[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM tasks WHERE project_id = $projectId AND status = $status ORDER BY "order" ASC');
  const rows = stmt.all({ $projectId: projectId, $status: status }) as TaskRow[];
  return rows.map(rowToTask);
}

export function batchUpdateOrder(updates: Array<{ id: string; order: number }>): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE tasks SET "order" = $order, updated_at = $updatedAt WHERE id = $id');
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const u of updates) {
      stmt.run({ $id: u.id, $order: u.order, $updatedAt: now });
    }
  });
  tx();
}

export function hasChildren(taskId: string): boolean {
  const db = getDb();
  const stmt = db.prepare('SELECT COUNT(*) as cnt FROM tasks WHERE parent_task_id = $taskId');
  const row = stmt.get({ $taskId: taskId }) as { cnt: number };
  return row.cnt > 0;
}

export function getChildTaskIds(taskId: string): string[] {
  const db = getDb();
  const stmt = db.prepare('SELECT id FROM tasks WHERE parent_task_id = $taskId');
  const rows = stmt.all({ $taskId: taskId }) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

function getDependencyIds(taskId: string): string[] {
  const db = getDb();
  const stmt = db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = $taskId');
  const rows = stmt.all({ $taskId: taskId }) as Array<{ depends_on_task_id: string }>;
  return rows.map((r) => r.depends_on_task_id);
}

export function insertDependency(dep: TaskDependency): void {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES ($taskId, $dependsOnTaskId)',
  );
  stmt.run({ $taskId: dep.taskId, $dependsOnTaskId: dep.dependsOnTaskId });
}

export function insertDependenciesBatch(taskId: string, dependsOnIds: string[]): void {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES ($taskId, $dependsOnTaskId)',
  );
  const tx = db.transaction(() => {
    for (const depId of dependsOnIds) {
      stmt.run({ $taskId: taskId, $dependsOnTaskId: depId });
    }
  });
  tx();
}

export function deleteDependency(taskId: string, dependsOnTaskId: string): boolean {
  const db = getDb();
  const stmt = db.prepare(
    'DELETE FROM task_dependencies WHERE task_id = $taskId AND depends_on_task_id = $dependsOnTaskId',
  );
  const result = stmt.run({ $taskId: taskId, $dependsOnTaskId: dependsOnTaskId });
  return result.changes > 0;
}

export function getDependenciesForTask(taskId: string): Task[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT t.* FROM tasks t
    INNER JOIN task_dependencies td ON t.id = td.depends_on_task_id
    WHERE td.task_id = $taskId
  `);
  const rows = stmt.all({ $taskId: taskId }) as TaskRow[];
  return rows.map(rowToTask);
}

export function getDependentsOfTask(taskId: string): Task[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT t.* FROM tasks t
    INNER JOIN task_dependencies td ON t.id = td.task_id
    WHERE td.depends_on_task_id = $taskId
  `);
  const rows = stmt.all({ $taskId: taskId }) as TaskRow[];
  return rows.map(rowToTask);
}

export function allDependenciesDone(taskId: string): boolean {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT COUNT(*) as cnt FROM task_dependencies td
    INNER JOIN tasks t ON t.id = td.depends_on_task_id
    WHERE td.task_id = $taskId AND t.status != 'done'
  `);
  const row = stmt.get({ $taskId: taskId }) as { cnt: number };
  return row.cnt === 0;
}

export function hasDependencies(taskId: string): boolean {
  const db = getDb();
  const stmt = db.prepare('SELECT COUNT(*) as cnt FROM task_dependencies WHERE task_id = $taskId');
  const row = stmt.get({ $taskId: taskId }) as { cnt: number };
  return row.cnt > 0;
}

export function hasUnresolvedDependencies(taskId: string): boolean {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT COUNT(*) as cnt FROM task_dependencies td
    INNER JOIN tasks t ON t.id = td.depends_on_task_id
    WHERE td.task_id = $taskId AND t.status != 'done'
  `);
  const row = stmt.get({ $taskId: taskId }) as { cnt: number };
  return row.cnt > 0;
}

export function getTransitiveDependencyIds(taskId: string): Set<string> {
  const visited = new Set<string>();
  const queue = [taskId];

  while (queue.length > 0) {
    const current = queue.pop()!;
    const depIds = getDependencyIds(current);
    for (const depId of depIds) {
      if (!visited.has(depId)) {
        visited.add(depId);
        queue.push(depId);
      }
    }
  }

  return visited;
}
