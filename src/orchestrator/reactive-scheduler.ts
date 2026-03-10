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
            AND dep.status NOT IN ('done', 'failed', 'cancelled')
        )
        AND (
          parent_task_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM task_dependencies ptd
            INNER JOIN tasks pdep ON pdep.id = ptd.depends_on_task_id
            WHERE ptd.task_id = tasks.parent_task_id
              AND pdep.status NOT IN ('done', 'failed', 'cancelled')
          )
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
            AND dep.status NOT IN ('done', 'failed', 'cancelled')
        )
        AND (
          parent_task_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM task_dependencies ptd
            INNER JOIN tasks pdep ON pdep.id = ptd.depends_on_task_id
            WHERE ptd.task_id = tasks.parent_task_id
              AND pdep.status NOT IN ('done', 'failed', 'cancelled')
          )
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
            AND dep.status NOT IN ('done', 'failed', 'cancelled')
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
  findReadyForAgent(agentType: string, agentId: string, scopeTaskIds: string[]): Task | null {
    if (scopeTaskIds.length === 0) return null;

    const db = getDb();
    const placeholders = scopeTaskIds.map(() => '?').join(',');

    const sql = `
      SELECT * FROM tasks
      WHERE id IN (${placeholders})
        AND status = 'ready'
        AND assigned_agent_type IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM json_each(assigned_agent_type) WHERE json_each.value = ?
        )
        AND (assigned_agent_id IS NULL OR assigned_agent_id = ?)
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
    const row = stmt.get(...scopeTaskIds, agentType, agentId) as Record<string, unknown> | null;
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

  // ─── Parent Status Derivation ───

  /**
   * 부모 태스크의 status를 자식 status에서 파생.
   * 규칙 (우선순위 순):
   *   1. 부모간 의존성 미충족 → blocked (변경 안 함)
   *   2. 자식 중 in_progress ≥1 → parent = in_progress
   *   3. 자식 중 in_progress 0 AND failed ≥1 → parent = failed
   *   4. 모든 자식 done/cancelled → parent = done
   *   5. 그 외 → 변경 없음
   * 매 tick 호출.
   */
  refreshParentStatuses(scopeTaskIds: string[]): string[] {
    if (scopeTaskIds.length === 0) return [];

    const db = getDb();
    const placeholders = scopeTaskIds.map(() => '?').join(',');
    const now = Date.now();

    const sql = `
      WITH parent_child_stats AS (
        SELECT
          p.id AS parent_id,
          p.status AS current_status,
          COUNT(*) AS total_children,
          SUM(CASE WHEN c.status = 'in_progress' THEN 1 ELSE 0 END) AS cnt_in_progress,
          SUM(CASE WHEN c.status = 'failed' THEN 1 ELSE 0 END) AS cnt_failed,
          SUM(CASE WHEN c.status IN ('done', 'cancelled') THEN 1 ELSE 0 END) AS cnt_terminal
        FROM tasks p
        INNER JOIN tasks c ON c.parent_task_id = p.id
        WHERE p.id IN (${placeholders})
          AND NOT EXISTS (
            SELECT 1 FROM task_dependencies td
            INNER JOIN tasks dep ON dep.id = td.depends_on_task_id
            WHERE td.task_id = p.id
              AND dep.status NOT IN ('done', 'failed', 'cancelled')
          )
        GROUP BY p.id, p.status
      )
      SELECT parent_id, current_status,
        CASE
          WHEN cnt_in_progress > 0 THEN 'in_progress'
          WHEN cnt_in_progress = 0 AND cnt_failed > 0 THEN 'failed'
          WHEN cnt_terminal = total_children THEN 'done'
          ELSE NULL
        END AS derived_status
      FROM parent_child_stats
    `;

    const rows = db.prepare(sql).all(...scopeTaskIds) as Array<{
      parent_id: string;
      current_status: string;
      derived_status: string | null;
    }>;

    const changed: string[] = [];
    const updateStmt = db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?');

    for (const row of rows) {
      if (row.derived_status && row.derived_status !== row.current_status) {
        updateStmt.run(row.derived_status, now, row.parent_id);
        changed.push(row.parent_id);
      }
    }

    return changed;
  }

  // ─── Decomposable Task Discovery ───

  /**
   * 디컴포징 대상 task 검색 (에이전트 할당과 무관).
   * 조건:
   *   - status NOT IN (done, cancelled, failed)
   *   - 자식 없음 (= leaf이거나 아직 분해 안 된 부모)
   *   - assigned_agent_id IS NULL (현재 실행 중이 아닌 task)
   * 정렬: deps 충족된 task 우선, 그 다음 created_at 오름차순.
   */
  findDecomposableTasks(scopeTaskIds: string[]): Task[] {
    if (scopeTaskIds.length === 0) return [];

    const db = getDb();
    const placeholders = scopeTaskIds.map(() => '?').join(',');

    const sql = `
      SELECT * FROM tasks
      WHERE id IN (${placeholders})
        AND status NOT IN ('done', 'cancelled', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM tasks child WHERE child.parent_task_id = tasks.id
        )
        AND assigned_agent_id IS NULL
        AND (assigned_agent_type IS NULL OR assigned_agent_type = '[]')
      ORDER BY
        CASE WHEN NOT EXISTS (
          SELECT 1 FROM task_dependencies td
          INNER JOIN tasks dep ON dep.id = td.depends_on_task_id
          WHERE td.task_id = tasks.id AND dep.status != 'done'
        ) THEN 0 ELSE 1 END,
        created_at ASC
    `;

    const rows = db.prepare(sql).all(...scopeTaskIds) as Array<Record<string, unknown>>;
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
