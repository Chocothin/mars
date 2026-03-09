import { getDb } from '../db/index';
import { eventBus } from '../events/bus';
import * as taskRepo from '../db/task-repo';
import type { Task } from '../types/task';

export interface ClaimResult {
  taskId: string;
  agentId: string;
  claimedAt: number;
}

export interface IClaimManager {
  claimTask(taskId: string, agentId: string, runId: string): ClaimResult | null;
  claimNextReady(agentId: string, runId: string): ClaimResult | null;
  releaseClaim(taskId: string, reason: 'completed' | 'failed' | 'timeout' | 'retry'): void;
  getClaimedTasks(agentId: string): Task[];
  getReadyTasks(runId: string): Task[];
  refreshReadyTasks(runId: string): number;
  isAllDone(runId: string): boolean;
}

export class ClaimManager implements IClaimManager {
  claimTask(taskId: string, agentId: string, runId: string): ClaimResult | null {
    const db = getDb();
    const now = Date.now();

    const row = db.prepare(`
      UPDATE tasks
      SET status = 'in_progress',
          assigned_agent_id = $agentId,
          updated_at = $now
      WHERE id = $taskId
        AND status = 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies td
          JOIN tasks dep ON dep.id = td.depends_on_task_id
          WHERE td.task_id = $taskId AND dep.status != 'done'
        )
        AND NOT EXISTS (
          SELECT 1 FROM tasks self
          JOIN task_dependencies ptd ON ptd.task_id = self.parent_task_id
          JOIN tasks pdep ON pdep.id = ptd.depends_on_task_id
          WHERE self.id = $taskId
            AND self.parent_task_id IS NOT NULL
            AND pdep.status != 'done'
        )
      RETURNING id
    `).get({ $agentId: agentId, $now: now, $taskId: taskId }) as { id: string } | null;

    if (!row) return null;

    const result: ClaimResult = { taskId: row.id, agentId, claimedAt: now };
    eventBus.emit({ type: 'task:claimed', taskId: row.id, agentId, runId });
    return result;
  }

  claimNextReady(agentId: string, runId: string): ClaimResult | null {
    const db = getDb();
    const now = Date.now();

    const run = db.prepare('SELECT project_id FROM runs WHERE id = $runId').get({ $runId: runId }) as { project_id: string } | null;
    if (!run) return null;

    const row = db.prepare(`
      UPDATE tasks
      SET status = 'in_progress',
          assigned_agent_id = $agentId,
          updated_at = $now
      WHERE id = (
        SELECT t.id FROM tasks t
        WHERE t.project_id = $projectId
          AND t.status = 'ready'
          AND t.assigned_agent_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM task_dependencies td
            JOIN tasks dep ON dep.id = td.depends_on_task_id
            WHERE td.task_id = t.id AND dep.status != 'done'
          )
          AND NOT EXISTS (
            SELECT 1 FROM tasks self
            JOIN task_dependencies ptd ON ptd.task_id = self.parent_task_id
            JOIN tasks pdep ON pdep.id = ptd.depends_on_task_id
            WHERE self.id = t.id
              AND self.parent_task_id IS NOT NULL
              AND pdep.status != 'done'
          )
        ORDER BY t."order" ASC, t.created_at ASC
        LIMIT 1
      )
      RETURNING id
    `).get({ $agentId: agentId, $now: now, $projectId: run.project_id }) as { id: string } | null;

    if (!row) return null;

    const result: ClaimResult = { taskId: row.id, agentId, claimedAt: now };
    eventBus.emit({ type: 'task:claimed', taskId: row.id, agentId, runId });
    return result;
  }

  releaseClaim(taskId: string, reason: 'completed' | 'failed' | 'timeout' | 'retry'): void {
    const db = getDb();
    const now = Date.now();

    if (reason === 'retry') {
      const task = db.prepare('SELECT project_id FROM tasks WHERE id = $id').get({ $id: taskId }) as { project_id: string } | null;
      const runRow = db.prepare('SELECT id FROM runs WHERE project_id = $pid ORDER BY created_at DESC LIMIT 1')
        .get({ $pid: task?.project_id ?? '' }) as { id: string } | null;
      eventBus.emit({ type: 'task:unclaimed', taskId, reason: 'manual', runId: runRow?.id ?? '' });
      return;
    }

    if (reason === 'completed') {
      const completedTask = db.prepare('SELECT parent_task_id, project_id FROM tasks WHERE id = $id')
        .get({ $id: taskId }) as { parent_task_id: string | null; project_id: string } | null;

      if (completedTask) {
        const isTerminal = (s: string) => s === 'done' || s === 'failed';
        const children = taskRepo.queryTasks(completedTask.project_id, {
          parentTaskId: taskId, limit: 500, offset: 0,
        });
        const hasIncompleteChildren = children.length > 0 &&
          children.some((c) => !isTerminal(c.status));

        if (!hasIncompleteChildren) {
          db.prepare("UPDATE tasks SET status = 'done', updated_at = $now WHERE id = $id")
            .run({ $id: taskId, $now: now });
        }

        if (completedTask.parent_task_id) {
          const siblings = taskRepo.queryTasks(completedTask.project_id, {
            parentTaskId: completedTask.parent_task_id, limit: 500, offset: 0,
          });
          if (siblings.every((s) => s.status === 'done')) {
            const parentRow = db.prepare('SELECT status FROM tasks WHERE id = $id')
              .get({ $id: completedTask.parent_task_id }) as { status: string } | null;
            if (parentRow && parentRow.status === 'in_progress') {
              db.prepare("UPDATE tasks SET status = 'done', updated_at = $now WHERE id = $id")
                .run({ $id: completedTask.parent_task_id, $now: now });
            }
          }
        }
      }
    } else {
      // Check retry limit before setting task back to ready
      const taskRow = db.prepare('SELECT retry_count, max_retries FROM tasks WHERE id = $id')
        .get({ $id: taskId }) as { retry_count: number; max_retries: number } | null;
      const retryCount = taskRow?.retry_count ?? 0;
      const maxRetries = taskRow?.max_retries ?? 2;

      if (retryCount >= maxRetries) {
        // Exceeded retry limit — mark task as permanently failed
        db.prepare("UPDATE tasks SET status = 'failed', assigned_agent_id = NULL, updated_at = $now WHERE id = $id")
          .run({ $id: taskId, $now: now });
      } else {
        db.prepare("UPDATE tasks SET status = 'ready', assigned_agent_id = NULL, updated_at = $now WHERE id = $id")
          .run({ $id: taskId, $now: now });
      }
    }

    const task = db.prepare('SELECT project_id FROM tasks WHERE id = $id').get({ $id: taskId }) as { project_id: string } | null;
    const runRow = db.prepare('SELECT id FROM runs WHERE project_id = $pid ORDER BY created_at DESC LIMIT 1')
      .get({ $pid: task?.project_id ?? '' }) as { id: string } | null;

    if (reason !== 'completed') {
      const eventReason: 'timeout' | 'crash' | 'manual' = reason === 'timeout' ? 'timeout' : 'crash';
      eventBus.emit({ type: 'task:unclaimed', taskId, reason: eventReason, runId: runRow?.id ?? '' });
    }
  }

  getClaimedTasks(agentId: string): Task[] {
    return taskRepo.queryTasksGlobal({ status: 'in_progress', assignedAgentId: agentId });
  }

  getReadyTasks(runId: string): Task[] {
    const db = getDb();
    const run = db.prepare('SELECT project_id FROM runs WHERE id = $runId').get({ $runId: runId }) as { project_id: string } | null;
    if (!run) return [];
    return taskRepo.queryTasks(run.project_id, { status: 'ready' });
  }

  refreshReadyTasks(runId: string): number {
    const db = getDb();
    const run = db.prepare('SELECT project_id FROM runs WHERE id = $runId').get({ $runId: runId }) as { project_id: string } | null;
    if (!run) return 0;

    let transitioned = 0;

    const backlogTasks = taskRepo.queryTasks(run.project_id, { status: 'backlog' });
    for (const task of backlogTasks) {
      // For subtasks: parent's own dependencies must also be met
      if (task.parentTaskId && !taskRepo.allDependenciesDone(task.parentTaskId)) {
        continue;
      }
      if (!taskRepo.hasDependencies(task.id) || taskRepo.allDependenciesDone(task.id)) {
        taskRepo.updateTask(task.id, { status: 'ready' });
        transitioned++;
      }
    }

    const blockedTasks = taskRepo.queryTasks(run.project_id, { status: 'blocked' });
    for (const task of blockedTasks) {
      // For subtasks: parent's own dependencies must also be met
      if (task.parentTaskId && !taskRepo.allDependenciesDone(task.parentTaskId)) {
        continue;
      }
      if (taskRepo.allDependenciesDone(task.id)) {
        taskRepo.updateTask(task.id, { status: 'ready' });
        transitioned++;
      }
    }

    return transitioned;
  }

  isAllDone(runId: string): boolean {
    const db = getDb();
    const run = db.prepare('SELECT execution_plan FROM runs WHERE id = $runId').get({ $runId: runId }) as { execution_plan: string | null } | null;
    if (!run) return true;

    if (!run.execution_plan) return false;

    let planTaskIds: string[];
    try {
      const plan = JSON.parse(run.execution_plan) as { batches: Array<{ taskIds: string[] }> };
      planTaskIds = plan.batches.flatMap(b => b.taskIds);
    } catch {
      return false;
    }

    if (planTaskIds.length === 0) return true;

    const placeholders = planTaskIds.map(() => '?').join(',');
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM tasks WHERE id IN (${placeholders}) AND status NOT IN ('done', 'failed')`
    ).get(...planTaskIds) as { cnt: number };

    return row.cnt === 0;
  }
}
