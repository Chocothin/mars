import type {
  Task,
  CreateTaskInput,
  UpdateTaskInput,
  TaskQuery,
  ITaskService,
  TaskUpdateResult,
  TaskAutoTransition,
} from '../types/task';
import type { TaskStatus } from '../types/project';
import {
  insertTask,
  getTaskById,
  getTaskByIdGlobal,
  updateTask,
  deleteTask,
  queryTasks,
  getMaxOrder,
  getTasksByColumn,
  batchUpdateOrder,
  hasChildren,
  insertDependenciesBatch,
  insertDependency,
  deleteDependency,
  getDependenciesForTask,
  getDependentsOfTask,
  allDependenciesDone,
  hasUnresolvedDependencies,
  getTransitiveDependencyIds,
} from '../db/task-repo';
import { getProjectById } from '../db/project-repo';
import { getAgentById } from '../db/agent-repo';
import { randomUUID } from 'node:crypto';

const FORWARD_STATUSES: TaskStatus[] = ['ready', 'in_progress', 'review', 'done'];

export class TaskService implements ITaskService {
  private ensureProjectExists(projectId: string): void {
    const project = getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
  }

  private validateAssignedAgent(projectId: string, agentId: string): void {
    const project = getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const agent = getAgentById(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    if (!project.agentIds.includes(agentId)) {
      throw new Error(`Agent ${agentId} is not assigned to project ${projectId}`);
    }
  }

  private async validateParentTask(projectId: string, parentTaskId: string): Promise<void> {
    const parent = getTaskById(projectId, parentTaskId);
    if (!parent) {
      throw new Error(`Parent task not found: ${parentTaskId}`);
    }
    if (parent.parentTaskId !== null) {
      throw new Error('Subtasks can only be one level deep. The specified parent is already a subtask.');
    }
  }

  private validateDependencyIds(projectId: string, taskId: string | null, dependsOnIds: string[], parentTaskId?: string | null): void {
    for (const depId of dependsOnIds) {
      if (depId === taskId) {
        throw new Error('A task cannot depend on itself');
      }
      const depTask = getTaskById(projectId, depId);
      if (!depTask) {
        throw new Error(`Dependency task not found: ${depId}`);
      }
      if (parentTaskId !== undefined) {
        if (parentTaskId) {
          if (depTask.parentTaskId !== parentTaskId) {
            throw new Error(
              `Subtask dependency must be within the same parent. Task "${depId}" belongs to parent "${depTask.parentTaskId ?? 'none'}", expected "${parentTaskId}".`,
            );
          }
        } else if (parentTaskId === null) {
          if (depTask.parentTaskId !== null) {
            throw new Error(
              `Parent task can only depend on other parent tasks. Task "${depId}" is a subtask of "${depTask.parentTaskId}".`,
            );
          }
        }
      }
    }
  }

  private detectCircularDependency(taskId: string, newDepId: string): void {
    const transitiveDeps = getTransitiveDependencyIds(newDepId);
    if (transitiveDeps.has(taskId)) {
      throw new Error(`Circular dependency detected: ${newDepId} already depends on ${taskId} (directly or transitively)`);
    }
  }

  private shouldAutoBlock(dependsOnIds: string[]): boolean {
    if (dependsOnIds.length === 0) return false;
    for (const depId of dependsOnIds) {
      const dep = getTaskByIdGlobal(depId);
      if (dep && dep.status !== 'done') return true;
    }
    return false;
  }

  private processAutoTransitions(completedTaskId: string): TaskAutoTransition[] {
    const transitions: TaskAutoTransition[] = [];
    const dependents = getDependentsOfTask(completedTaskId);

    for (const dep of dependents) {
      if (dep.status !== 'blocked') continue;
      if (!allDependenciesDone(dep.id)) continue;

      const maxOrder = getMaxOrder(dep.projectId, 'ready');
      updateTask(dep.id, { status: 'ready', order: maxOrder + 1 });

      transitions.push({
        taskId: dep.id,
        taskTitle: dep.title,
        from: 'blocked',
        to: 'ready',
      });
    }

    return transitions;
  }

  async create(projectId: string, input: CreateTaskInput): Promise<Task> {
    this.ensureProjectExists(projectId);

    if (input.parentTaskId) {
      await this.validateParentTask(projectId, input.parentTaskId);
    }

    const dependsOnIds = input.dependsOnTaskIds ?? [];
    if (dependsOnIds.length > 0) {
      this.validateDependencyIds(projectId, null, dependsOnIds, input.parentTaskId ?? null);
    }
    const assignedAgentType = input.assignedAgentType ?? null;

    const autoBlock = this.shouldAutoBlock(dependsOnIds);
    const status = autoBlock ? 'blocked' : (input.status ?? 'backlog');
    const maxOrder = getMaxOrder(projectId, status);

    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      projectId,
      parentTaskId: input.parentTaskId ?? null,
      title: input.title,
      description: input.description ?? '',
      status,
      priority: input.priority ?? 'medium',
      order: maxOrder + 1,
      assignedAgentType,
      assignedAgentId: input.assignedAgentId ?? null,
      dependsOnTaskIds: dependsOnIds,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      expectedOutputs: input.expectedOutputs ?? [],
      maxRetries: input.maxRetries ?? 2,
      retryCount: 0,
      reviewFeedback: null,
      createdAt: now,
      updatedAt: now,
    };

    insertTask(task);

    if (dependsOnIds.length > 0) {
      insertDependenciesBatch(task.id, dependsOnIds);
    }

    return { ...task, dependsOnTaskIds: dependsOnIds };
  }

  async getById(projectId: string, taskId: string): Promise<Task | null> {
    this.ensureProjectExists(projectId);
    return getTaskById(projectId, taskId);
  }

  async update(projectId: string, taskId: string, input: UpdateTaskInput): Promise<TaskUpdateResult | null> {
    this.ensureProjectExists(projectId);

    const existing = getTaskById(projectId, taskId);
    if (!existing) return null;

    const warnings: string[] = [];
    const statusChanging = input.status !== undefined && input.status !== existing.status;

    if (statusChanging && FORWARD_STATUSES.includes(input.status!) && hasUnresolvedDependencies(taskId)) {
      warnings.push(
        `Task has unresolved dependencies. Moving to '${input.status}' may cause issues. Dependencies should be completed first.`,
      );
    }

    if (statusChanging && input.status === 'done' && hasChildren(taskId)) {
      const children = queryTasks(projectId, { parentTaskId: taskId, limit: 500, offset: 0 });
      const incomplete = children.filter((c) => c.status !== 'done');
      if (incomplete.length > 0) {
        warnings.push(
          `Cannot mark parent task as done: ${incomplete.length} subtask(s) still incomplete (${incomplete.map((c) => c.title).join(', ')}).`,
        );
        delete input.status;
      }
    }

    const updates: Partial<Task> = {};
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description;
    if (input.priority !== undefined) updates.priority = input.priority;
    if (input.assignedAgentId !== undefined) {
      if (input.assignedAgentId !== null) {
        this.validateAssignedAgent(projectId, input.assignedAgentId);
      }
      updates.assignedAgentId = input.assignedAgentId;
    } else if (input.assignedAgentType !== undefined) {
      updates.assignedAgentType = input.assignedAgentType;
    }

    if (statusChanging) {
      updates.status = input.status;
      if (input.order !== undefined) {
        updates.order = input.order;
      } else {
        const maxOrder = getMaxOrder(projectId, input.status!);
        updates.order = maxOrder + 1;
      }
    } else if (input.order !== undefined) {
      updates.order = input.order;
    }

    const changed = updateTask(taskId, updates);
    if (!changed) {
      return { task: existing, warnings, autoTransitioned: [] };
    }

    if (statusChanging) {
      await this.reorderColumn(projectId, existing.status);
      await this.reorderColumn(projectId, input.status!);
    }

    let autoTransitioned: TaskAutoTransition[] = [];
    if (statusChanging && input.status === 'done') {
      autoTransitioned = this.processAutoTransitions(taskId);
      for (const t of autoTransitioned) {
        await this.reorderColumn(projectId, 'blocked');
        await this.reorderColumn(projectId, 'ready');
      }
    }

    const updated = getTaskById(projectId, taskId)!;
    return { task: updated, warnings, autoTransitioned };
  }

  async delete(projectId: string, taskId: string): Promise<boolean> {
    this.ensureProjectExists(projectId);

    const existing = getTaskById(projectId, taskId);
    if (!existing) return false;

    const childTasks = queryTasks(projectId, { parentTaskId: taskId, limit: 500, offset: 0 });
    const affectedStatuses = new Set<TaskStatus>([existing.status, ...childTasks.map((task) => task.status)]);

    for (const childTask of childTasks) {
      deleteTask(projectId, childTask.id);
    }

    const deleted = deleteTask(projectId, taskId);
    if (deleted) {
      for (const status of affectedStatuses) {
        await this.reorderColumn(projectId, status);
      }
    }
    return deleted;
  }

  async list(projectId: string, query: TaskQuery): Promise<Task[]> {
    this.ensureProjectExists(projectId);
    return queryTasks(projectId, query);
  }

  async reorderColumn(projectId: string, status: TaskStatus): Promise<void> {
    const tasks = getTasksByColumn(projectId, status);
    const updates = tasks.map((t, i) => ({ id: t.id, order: i }));
    if (updates.length > 0) {
      batchUpdateOrder(updates);
    }
  }

  async addDependency(projectId: string, taskId: string, dependsOnTaskId: string): Promise<void> {
    this.ensureProjectExists(projectId);

    const task = getTaskById(projectId, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const depTask = getTaskById(projectId, dependsOnTaskId);
    if (!depTask) throw new Error(`Dependency task not found: ${dependsOnTaskId}`);

    if (taskId === dependsOnTaskId) {
      throw new Error('A task cannot depend on itself');
    }

    this.detectCircularDependency(taskId, dependsOnTaskId);

    insertDependency({ taskId, dependsOnTaskId });

    if (task.status !== 'blocked' && depTask.status !== 'done') {
      const maxOrder = getMaxOrder(projectId, 'blocked');
      updateTask(taskId, { status: 'blocked', order: maxOrder + 1 });
      await this.reorderColumn(projectId, task.status);
      await this.reorderColumn(projectId, 'blocked');
    }
  }

  async removeDependency(projectId: string, taskId: string, dependsOnTaskId: string): Promise<void> {
    this.ensureProjectExists(projectId);

    const task = getTaskById(projectId, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const removed = deleteDependency(taskId, dependsOnTaskId);
    if (!removed) throw new Error('Dependency not found');

    if (task.status === 'blocked' && allDependenciesDone(taskId)) {
      const maxOrder = getMaxOrder(projectId, 'ready');
      updateTask(taskId, { status: 'ready', order: maxOrder + 1 });
      await this.reorderColumn(projectId, 'blocked');
      await this.reorderColumn(projectId, 'ready');
    }
  }

  async getDependencies(projectId: string, taskId: string): Promise<Task[]> {
    this.ensureProjectExists(projectId);

    const task = getTaskById(projectId, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    return getDependenciesForTask(taskId);
  }

  async assignAgent(projectId: string, taskId: string, agentId: string): Promise<Task | null> {
    this.ensureProjectExists(projectId);

    const task = getTaskById(projectId, taskId);
    if (!task) {
      return null;
    }

    this.validateAssignedAgent(projectId, agentId);
    updateTask(taskId, { assignedAgentId: agentId });
    return getTaskById(projectId, taskId);
  }

  async clearAssignedAgent(projectId: string, taskId: string): Promise<Task | null> {
    this.ensureProjectExists(projectId);

    const task = getTaskById(projectId, taskId);
    if (!task) {
      return null;
    }

    updateTask(taskId, { assignedAgentId: null });
    return getTaskById(projectId, taskId);
  }
}
