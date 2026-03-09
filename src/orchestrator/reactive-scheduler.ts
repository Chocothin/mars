import { getDb } from '../db/index';
import type { Task } from '../types/task';
import type { TaskStatus } from '../types/project';
import { getTaskByIdGlobal } from '../db/task-repo';

// ─── ReactiveScheduler: 정적 batch 없이 동적 의존성 기반 스케줄링 ───

export class ReactiveScheduler {

  // ─── Task Readiness ───

  /**
   * blocked → ready 전이: 모든 의존성이 done인 blocked task를 ready로.
   * RETURNING으로 전이된 task ID 반환. 매 tick 호출.
   */
  refreshReadyTasks(scopeTaskIds: string[]): string[] {
    if (scopeTaskIds.length === 0) return [];

    const db = getDb();
    const placeholders = scopeTaskIds.map(() => '?').join(',');

    const sql = `
      UPDATE tasks 
      SET status = 'ready', updated_at = ?
      WHERE id IN (${placeholders})
        AND status = 'blocked'
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies td
          INNER JOIN tasks dep ON dep.id = td.depends_on_task_id
          WHERE td.task_id = tasks.id
            AND dep.status != 'done'
        )
      RETURNING id
    `;

    const stmt = db.prepare(sql);
    const rows = stmt.all(Date.now(), ...scopeTaskIds) as Array<{ id: string }>;
    return rows.map(r => r.id);
  }

  /**
   * backlog task 활성화: 의존성 없으면 ready, 있으면 blocked.
   * 새로 생성된 task가 스케줄링 사이클에 진입하는 진입점.
   */
  activateBacklogTasks(scopeTaskIds: string[]): string[] {
    if (scopeTaskIds.length === 0) return [];

    const db = getDb();
    const placeholders = scopeTaskIds.map(() => '?').join(',');
    const now = Date.now();

    const readySql = `
      UPDATE tasks
      SET status = 'ready', updated_at = ?
      WHERE id IN (${placeholders})
        AND status = 'backlog'
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies td
          INNER JOIN tasks dep ON dep.id = td.depends_on_task_id
          WHERE td.task_id = tasks.id
            AND dep.status != 'done'
        )
      RETURNING id
    `;
    const readyRows = db.prepare(readySql).all(now, ...scopeTaskIds) as Array<{ id: string }>;

    const blockedSql = `
      UPDATE tasks
      SET status = 'blocked', updated_at = ?
      WHERE id IN (${placeholders})
        AND status = 'backlog'
        AND EXISTS (
          SELECT 1 FROM task_dependencies td
          INNER JOIN tasks dep ON dep.id = td.depends_on_task_id
          WHERE td.task_id = tasks.id
            AND dep.status != 'done'
        )
    `;
    db.prepare(blockedSql).run(now, ...scopeTaskIds);

    return readyRows.map(r => r.id);
  }

  // ─── Task Finding ───

  /**
   * 주어진 agentType에 매칭되는 ready leaf task를 priority→order→createdAt 순으로 1개 반환.
   * leaf task = 자식이 없는 task (직접 실행 대상).
   */
  findReadyForAgent(agentType: string, scopeTaskIds: string[]): Task | null {
    if (scopeTaskIds.length === 0) return null;

    const db = getDb();
    const placeholders = scopeTaskIds.map(() => '?').join(',');

    const sql = `
      SELECT * FROM tasks
      WHERE id IN (${placeholders})
        AND status = 'ready'
        AND assigned_agent_type = ?
        AND NOT EXISTS (
          SELECT 1 FROM tasks child WHERE child.parent_task_id = tasks.id
        )
      ORDER BY
        CASE priority
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END,
        "order" ASC,
        created_at ASC
      LIMIT 1
    `;

    const stmt = db.prepare(sql);
    const row = stmt.get(...scopeTaskIds, agentType) as Record<string, unknown> | null;
    if (!row) return null;

    return getTaskByIdGlobal(row.id as string);
  }

  /**
   * 미분해 부모 task 검출.
   * 컨벤션: assignedAgentType이 NULL이고 자식이 없는 task = 분해 필요.
   */
  findUndecomposedParents(scopeTaskIds: string[]): Task[] {
    if (scopeTaskIds.length === 0) return [];

    const db = getDb();
    const placeholders = scopeTaskIds.map(() => '?').join(',');

    const sql = `
      SELECT * FROM tasks
      WHERE id IN (${placeholders})
        AND status IN ('backlog', 'ready')
        AND assigned_agent_type IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM tasks child WHERE child.parent_task_id = tasks.id
        )
      ORDER BY "order" ASC
    `;

    const stmt = db.prepare(sql);
    const rows = stmt.all(...scopeTaskIds) as Array<Record<string, unknown>>;

    return rows
      .map(r => getTaskByIdGlobal(r.id as string))
      .filter((t): t is Task => t !== null);
  }

  // ─── Completion Check ───

  isAllDone(scopeTaskIds: string[]): boolean {
    if (scopeTaskIds.length === 0) return true;

    const db = getDb();
    const placeholders = scopeTaskIds.map(() => '?').join(',');

    const sql = `
      SELECT COUNT(*) as cnt FROM tasks
      WHERE id IN (${placeholders})
        AND status NOT IN ('done', 'failed', 'cancelled')
    `;

    const stmt = db.prepare(sql);
    const row = stmt.get(...scopeTaskIds) as { cnt: number };
    return row.cnt === 0;
  }

  getStatusBreakdown(scopeTaskIds: string[]): Record<TaskStatus, number> {
    if (scopeTaskIds.length === 0) {
      return { backlog: 0, blocked: 0, ready: 0, in_progress: 0, review: 0, done: 0, failed: 0, cancelled: 0 };
    }

    const db = getDb();
    const placeholders = scopeTaskIds.map(() => '?').join(',');

    const sql = `
      SELECT status, COUNT(*) as cnt FROM tasks
      WHERE id IN (${placeholders})
      GROUP BY status
    `;

    const stmt = db.prepare(sql);
    const rows = stmt.all(...scopeTaskIds) as Array<{ status: string; cnt: number }>;

    const breakdown: Record<string, number> = {
      backlog: 0, blocked: 0, ready: 0, in_progress: 0, review: 0, done: 0, failed: 0, cancelled: 0,
    };
    for (const row of rows) {
      breakdown[row.status] = row.cnt;
    }

    return breakdown as Record<TaskStatus, number>;
  }

  // ─── Scope Management ───

  /**
   * root task IDs로부터 전체 하위 트리를 BFS로 수집.
   * run scope 내 모든 task ID를 반환.
   */
  collectAllTaskIds(rootTaskIds: string[]): string[] {
    if (rootTaskIds.length === 0) return [];

    const db = getDb();
    const all = new Set<string>(rootTaskIds);
    const queue = [...rootTaskIds];

    const stmt = db.prepare('SELECT id FROM tasks WHERE parent_task_id = ?');

    while (queue.length > 0) {
      const parentId = queue.pop()!;
      const children = stmt.all(parentId) as Array<{ id: string }>;
      for (const child of children) {
        if (!all.has(child.id)) {
          all.add(child.id);
          queue.push(child.id);
        }
      }
    }

    return Array.from(all);
  }
}
