import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { Run, RunConfig, RunStatus, ExecutionPlan, TaskExecution, DependencyEdge, TaskExecutionInput, RunResult, OrchestrationBrief, PriorTaskResult } from './types';
import type { AgentContext, RunnerCallbacks, AgentSession } from '../execution/types';
import type { IAgentRunner } from '../execution/agent-runner';
import type { InteractionRequest } from '../hitl/types';
import type { IAgentService } from '../types/agent';
import type { Task } from '../types/task';
import type { ITaskService } from '../types/task';
import type { ProposedSubtask, ExtractEvent } from '../events/types';
import type { IClaimManager } from './claim';
import type { IHeartbeatManager } from './heartbeat';
import type { IMessageService } from '../messaging/service';
import type { IResultReviewer } from './reviewer';
import { TaskDecomposer } from './decomposer';
import { TaskScheduler } from './scheduler';
import { ContextBuilder } from '../execution/context-builder';
import { InteractionGate } from '../hitl/interaction-gate';
import { eventBus } from '../events/bus';
import { insertRun, getRunById, updateRun, queryRuns } from '../db/run-repo';
import { insertTaskExecution, updateTaskExecution, getTaskExecutionsByRunId } from '../db/task-exec-repo';
import { getTaskByIdGlobal, updateTask as updateTaskInDb, hasChildren, getChildTaskIds } from '../db/task-repo';
import { getProjectById } from '../db/project-repo';
import { getDb } from '../db/index';

interface TaskExecutionContext {
  batchIndex: number;
  totalBatches: number;
  dependencyGraph: DependencyEdge[];
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_RUN_CONFIG: RunConfig = {
  maxConcurrency: 3,
  maxRetries: 1,
  timeoutMs: 3 * 60 * 60 * 1000,
  taskTimeoutMs: 900000,
  autoReview: true,
  requireHumanApproval: true,
  hitl: null,
};

// ─── Interface ───────────────────────────────────────────────────────────────

interface IOrchestratorEngine {
  createRun(projectId: string, taskIds: string[], config?: Partial<RunConfig>): Promise<Run>;
  startRun(runId: string): Promise<void>;
  pauseRun(runId: string): Promise<void>;
  resumeRun(runId: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  getRunStatus(runId: string): Promise<Run>;
  listRuns(query?: {
    projectId?: string;
    status?: RunStatus;
    limit?: number;
    offset?: number;
  }): Promise<Run[]>;
  listActiveRuns(projectId?: string): Promise<Run[]>;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

const GRACEFUL_MARKER_PATH = join(process.env.HOME ?? '/tmp', '.mars', 'graceful-shutdown-runs.json');

export class OrchestratorEngine implements IOrchestratorEngine {
  private decomposer: TaskDecomposer;
  private scheduler: TaskScheduler;
  private runner: IAgentRunner;
  private contextBuilder: ContextBuilder;
  private interactionGate: InteractionGate;
  private agentService: IAgentService;
  private taskService: ITaskService;
  private claimManager: IClaimManager;
  private heartbeatManager: IHeartbeatManager;
  private messageService: IMessageService;
  private reviewer: IResultReviewer;
  private activeRuns = new Map<string, AbortController>();

  constructor(deps: {
    decomposer: TaskDecomposer;
    scheduler: TaskScheduler;
    runner: IAgentRunner;
    contextBuilder: ContextBuilder;
    interactionGate: InteractionGate;
    agentService: IAgentService;
    taskService: ITaskService;
    claimManager: IClaimManager;
    heartbeatManager: IHeartbeatManager;
    messageService: IMessageService;
    reviewer: IResultReviewer;
  }) {
    this.decomposer = deps.decomposer;
    this.scheduler = deps.scheduler;
    this.runner = deps.runner;
    this.contextBuilder = deps.contextBuilder;
    this.interactionGate = deps.interactionGate;
    this.agentService = deps.agentService;
    this.taskService = deps.taskService;
    this.claimManager = deps.claimManager;
    this.heartbeatManager = deps.heartbeatManager;
    this.messageService = deps.messageService;
    this.reviewer = deps.reviewer;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async createRun(projectId: string, taskIds: string[], config?: Partial<RunConfig>): Promise<Run> {
    const project = getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (taskIds.length === 0) {
      throw new Error('At least one taskId is required');
    }

    for (const taskId of taskIds) {
      const task = getTaskByIdGlobal(taskId);
      if (!task || task.projectId !== projectId) {
        throw new Error(`Task not found in project ${projectId}: ${taskId}`);
      }
    }

    const run: Run = {
      id: randomUUID(),
      projectId,
      status: 'pending',
      rootTaskIds: taskIds,
      config: { ...DEFAULT_RUN_CONFIG, ...config },
      executionPlan: null,
      result: null,
      startedAt: null,
      completedAt: null,
      createdAt: Date.now(),
    };
    insertRun(run);
    eventBus.emit({ type: 'run:created', runId: run.id, projectId });
    return run;
  }

  async startRun(runId: string): Promise<void> {
    const db = getDb();
    const casResult = db.prepare(
      "UPDATE runs SET status = 'decomposing', started_at = $now WHERE id = $id AND status = 'pending'"
    ).run({ $id: runId, $now: Date.now() });
    if (casResult.changes === 0) {
      const run = getRunById(runId);
      throw new Error(`Run ${runId} is not in pending state (current: ${run?.status ?? 'not found'})`);
    }

    const run = getRunById(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const controller = new AbortController();
    this.activeRuns.set(runId, controller);

    try {
      this.interactionGate.setApprovalMode(runId, run.config.requireHumanApproval);
      eventBus.emit({ type: 'run:started', runId });
      const allTaskIds = await this.phaseDecomposition(runId, run.rootTaskIds, controller.signal);
      if (controller.signal.aborted) return;

      // Phase 2: Scheduling
      this.updateRunStatus(runId, 'scheduling');
      const plan = await this.phaseScheduling(runId, allTaskIds, controller.signal);
      if (controller.signal.aborted) return;
      updateRun(runId, { executionPlan: plan });

      // Phase 3: Self-claim loop (replaces Execution + Review phases)
      this.updateRunStatus(runId, 'running');
      await this.selfClaimLoop(runId, plan, controller.signal);
      if (controller.signal.aborted) return;

      const finalRun = getRunById(runId);
      if (finalRun && this.isNonTerminalStatus(finalRun.status)) {
        const executions = getTaskExecutionsByRunId(runId);
        const result = this.buildRunResult(executions);
        const finalStatus = result.failedTasks > 0 ? 'failed' : 'completed';
        updateRun(runId, { status: finalStatus, completedAt: Date.now(), result });
        if (finalStatus === 'completed') {
          eventBus.emit({ type: 'run:completed', runId, result });
        } else {
          eventBus.emit({ type: 'run:failed', runId, error: `${result.failedTasks} task(s) failed` });
        }
      }
    } catch (error) {
      console.error(`[Run ${runId}] Engine error:`, error);
      if (!controller.signal.aborted) {
        const executions = getTaskExecutionsByRunId(runId);
        const result = this.buildRunResult(executions);
        updateRun(runId, { status: 'failed', result, completedAt: Date.now() });
        eventBus.emit({ type: 'run:failed', runId, error: String(error) });
      }
    } finally {
      this.interactionGate.clearRunOverrides(runId);
      this.activeRuns.delete(runId);
    }
  }

  async pauseRun(runId: string): Promise<void> {
    const run = getRunById(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const controller = this.activeRuns.get(runId);
    if (controller) {
      controller.abort();
      this.activeRuns.delete(runId);
    }

    this.updateRunStatus(runId, 'paused');
    eventBus.emit({ type: 'run:paused', runId });
  }

  async resumeRun(runId: string): Promise<void> {
    const run = getRunById(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (!run.executionPlan) throw new Error(`No execution plan for run: ${runId}`);

    this.updateRunStatus(runId, 'running');

    const pendingIds = await this.interactionGate.getPendingForRun(runId);
    const pendingPromises: Array<Promise<unknown>> = [];
    for (const id of pendingIds) {
      const promise = this.interactionGate.getPendingPromise(id);
      if (promise) {
        pendingPromises.push(promise);
      }
    }

    if (pendingPromises.length > 0) {
      await Promise.all(pendingPromises);
    }

    const controller = new AbortController();
    this.activeRuns.set(runId, controller);

    try {
      await this.selfClaimLoop(runId, run.executionPlan, controller.signal);
      if (controller.signal.aborted) return;

      const finalRun = getRunById(runId);
      if (finalRun && this.isNonTerminalStatus(finalRun.status)) {
        const executions = getTaskExecutionsByRunId(runId);
        const result = this.buildRunResult(executions);
        const finalStatus = result.failedTasks > 0 ? 'failed' : 'completed';
        updateRun(runId, { status: finalStatus, completedAt: Date.now(), result });
        if (finalStatus === 'completed') {
          eventBus.emit({ type: 'run:completed', runId, result });
        } else {
          eventBus.emit({ type: 'run:failed', runId, error: `${result.failedTasks} task(s) failed` });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const executions = getTaskExecutionsByRunId(runId);
        const result = this.buildRunResult(executions);
        updateRun(runId, { status: 'failed', result, completedAt: Date.now() });
        eventBus.emit({ type: 'run:failed', runId, error: String(error) });
      }
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const run = getRunById(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const controller = this.activeRuns.get(runId);
    if (controller) {
      controller.abort();
    }

    this.interactionGate.cancelAllForRun(runId, 'Run cancelled');

    const executions = getTaskExecutionsByRunId(runId);
    const now = Date.now();
    for (const exec of executions) {
      if (exec.status === 'running' || exec.status === 'pending' || exec.status === 'assigned') {
        updateTaskExecution(exec.id, { status: 'cancelled', completedAt: now });
      }
    }

    const db = getDb();
    const planTaskIds = run.executionPlan?.batches.flatMap(b => b.taskIds) ?? [];
    if (planTaskIds.length > 0) {
      const placeholders = planTaskIds.map(() => '?').join(',');
      db.prepare(
        `UPDATE tasks SET status = 'cancelled', assigned_agent_id = NULL, updated_at = ?
         WHERE id IN (${placeholders}) AND status IN ('in_progress', 'ready')`
      ).run(now, ...planTaskIds);
    } else {
      db.prepare(
        "UPDATE tasks SET status = 'cancelled', assigned_agent_id = NULL, updated_at = $now WHERE project_id = $pid AND status IN ('in_progress', 'ready')"
      ).run({ $pid: run.projectId, $now: now });
    }

    this.heartbeatManager.stopMonitoring(runId);
    db.prepare(
      "UPDATE agent_heartbeats SET status = 'offline' WHERE run_id = $runId"
    ).run({ $runId: runId });

    this.updateRunStatus(runId, 'cancelled');
    updateRun(runId, { completedAt: now });
    eventBus.emit({ type: 'run:cancelled', runId });
  }

  async getRunStatus(runId: string): Promise<Run> {
    const run = getRunById(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  async listRuns(query: {
    projectId?: string;
    status?: RunStatus;
    limit?: number;
    offset?: number;
  } = {}): Promise<Run[]> {
    return queryRuns({
      projectId: query.projectId,
      status: query.status,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      limit: query.limit,
      offset: query.offset,
    });
  }

  async listActiveRuns(projectId?: string): Promise<Run[]> {
    return this.listRuns({ projectId, status: 'running' });
  }

  // ─── Phase 1: Decomposition ──────────────────────────────────────────────

  private async phaseDecomposition(
    runId: string,
    rootTaskIds: string[],
    signal: AbortSignal,
  ): Promise<string[]> {
    const allTaskIds: string[] = [...rootTaskIds];

    for (const taskId of rootTaskIds) {
      if (signal.aborted) return allTaskIds;

      // Resume support: skip tasks that already have subtasks from a previous run
      if (hasChildren(taskId)) {
        const existingChildIds = getChildTaskIds(taskId);
        allTaskIds.push(...existingChildIds);
        console.log(`[decomposition] Skipping task ${taskId} — already has ${existingChildIds.length} subtasks (resume)`);
        continue;
      }

      const taskForCtx = getTaskByIdGlobal(taskId);
      const projectForCtx = taskForCtx ? getProjectById(taskForCtx.projectId) : null;
      const projectContext = projectForCtx
        ? `Project: ${projectForCtx.name}. ${projectForCtx.description ?? ''}. Directory: ${projectForCtx.directoryPath ?? 'unknown'}`
        : '';
      const subtasks = await this.decomposer.propose(taskId, projectContext);
      if (!subtasks || subtasks.length === 0) continue;

      const response = await this.interactionGate.request({
        type: 'decomposition_approval',
        runId,
        taskId,
        fallbackAction: 'auto_approve',
        timeoutMs: 10 * 60 * 1000,
        question: {
          title: 'Task Decomposition Approval',
          description: `Task ${taskId} has been decomposed into ${subtasks.length} subtasks.`,
          payload: { parentTaskId: taskId, subtasks },
          suggestedAction: 'approve',
          suggestedMessage: null,
          options: [
            { value: 'approve', label: 'Approve', description: 'Accept decomposition', isDefault: true },
            { value: 'reject', label: 'Reject', description: 'Reject and skip decomposition', isDefault: false },
            { value: 'modify', label: 'Modify', description: 'Modify subtasks', isDefault: false },
          ],
        },
        metadata: { source: 'orchestrator' },
      });

      if (signal.aborted) return allTaskIds;

      if (response.action === 'approve') {
        const created = await this.decomposer.confirm(taskId, subtasks);
        for (const sub of created) {
          allTaskIds.push(sub.id);
        }
      } else if (response.action === 'reject' || response.action === 'skip') {
        throw new Error(`Decomposition rejected for task ${taskId}: ${response.message ?? 'rejected'}`);
      } else if (response.action === 'modify') {
        const modifiedSubtasks = (response.modifiedPayload?.subtasks as ProposedSubtask[]) ?? subtasks;
        const created = await this.decomposer.confirm(taskId, modifiedSubtasks);
        for (const sub of created) {
          allTaskIds.push(sub.id);
        }
      }
    }

    return allTaskIds;
  }

  // ─── Phase 2: Scheduling ─────────────────────────────────────────────────

  private async phaseScheduling(
    runId: string,
    allTaskIds: string[],
    signal: AbortSignal,
  ): Promise<ExecutionPlan> {
    const dependencies: DependencyEdge[] = [];

    for (const taskId of allTaskIds) {
      const task = getTaskByIdGlobal(taskId);
      if (task && task.dependsOnTaskIds) {
        for (const depId of task.dependsOnTaskIds) {
          dependencies.push({ fromTaskId: depId, toTaskId: taskId, type: 'blocks' });
        }
      }
    }

    const plan = this.scheduler.createPlan(allTaskIds, dependencies);

    const response = await this.interactionGate.request({
      type: 'plan_approval',
      runId,
      fallbackAction: 'auto_approve',
      timeoutMs: 10 * 60 * 1000,
      question: {
        title: 'Execution Plan Approval',
        description: `Execution plan: ${plan.batches.length} batches, ${allTaskIds.length} total tasks.`,
        payload: {
          plan: {
            totalBatches: plan.batches.length,
            totalTasks: allTaskIds.length,
            batches: plan.batches,
          },
        },
        suggestedAction: 'approve',
        suggestedMessage: null,
        options: [
          { value: 'approve', label: 'Approve', description: 'Accept plan', isDefault: true },
          { value: 'reject', label: 'Reject', description: 'Reject and cancel run', isDefault: false },
        ],
      },
      metadata: { source: 'orchestrator' },
    });

    if (signal.aborted) return plan;

    if (response.action === 'reject') {
      this.updateRunStatus(runId, 'cancelled');
      throw new Error('Execution plan rejected');
    }

    return plan;
  }

  // ─── Self-Claim Loop ─────────────────────────────────────────────────────

  private async selfClaimLoop(runId: string, plan: ExecutionPlan, signal: AbortSignal): Promise<void> {
    this.heartbeatManager.startMonitoring(runId, 5000);

    // Register all enabled agents as idle for this run
    const enabledAgents = await this.agentService.list({ enabled: true });
    for (const agent of enabledAgents) {
      this.heartbeatManager.ping(agent.id, runId, 'idle');
    }

    // Initial blocked → ready transition
    this.claimManager.refreshReadyTasks(runId);

    // Notify agents about run start
    this.messageService.broadcast(runId, 'orchestrator', 'plan_approval', {
      plan: { batches: plan.batches.length, tasks: plan.batches.flatMap(b => b.taskIds).length },
    });

    while (!signal.aborted) {
      if (this.claimManager.isAllDone(runId)) break;

      this.recoverStuckExecutions(runId);
      this.claimManager.refreshReadyTasks(runId);

      const idleAgentIds = new Set(this.heartbeatManager.getIdleAgents(runId));
      for (const agentId of idleAgentIds) {
        this.heartbeatManager.ping(agentId, runId, 'idle');
      }
      if (idleAgentIds.size > 0) {
        const readyTasks = this.claimManager.getReadyTasks(runId);

        for (const task of readyTasks) {
          if (idleAgentIds.size === 0) break;

          let targetAgentId: string | null = null;

          if (task.assignedAgentId && idleAgentIds.has(task.assignedAgentId)) {
            targetAgentId = task.assignedAgentId;
          } else if (!task.assignedAgentId) {
            targetAgentId = idleAgentIds.values().next().value ?? null;
          }

          if (!targetAgentId) continue;

          const claim = this.claimManager.claimTask(task.id, targetAgentId, runId);
          if (claim) {
            idleAgentIds.delete(targetAgentId);
            const attempt = (task.retryCount ?? 0) + 1;
            this.executeClaimedTask(runId, claim.taskId, claim.agentId, signal, attempt).catch(err => {
              console.error(`Task execution failed: ${claim.taskId}`, err);
              const db = getDb();
              db.prepare(
                "UPDATE tasks SET retry_count = retry_count + 1, updated_at = $now WHERE id = $id"
              ).run({ $id: claim.taskId, $now: Date.now() });
              this.claimManager.releaseClaim(claim.taskId, 'failed');
            });
          }
        }
      }

      await this.sleep(1000);
    }

    this.heartbeatManager.stopMonitoring(runId);
    this.reviewer.disposeSession(runId);
  }

  // ─── Stuck Execution Recovery ───────────────────────────────────────────

  private recoverStuckExecutions(runId: string): void {
    const timedOutAgents = this.heartbeatManager.getTimedOutAgents(runId, 30000);
    if (timedOutAgents.length === 0) return;

    const allExecutions = getTaskExecutionsByRunId(runId);
    for (const agentId of timedOutAgents) {
      const stuckExec = allExecutions.find(e => e.agentId === agentId && e.status === 'running');
      if (!stuckExec) continue;

      const task = getTaskByIdGlobal(stuckExec.taskId);
      if (!task) continue;

      const maxRetries = task.maxRetries ?? 2;
      const nextRetry = (task.retryCount ?? 0) + 1;
      const canRetry = nextRetry <= maxRetries;

      updateTaskExecution(stuckExec.id, {
        status: 'failed',
        error: `Agent ${agentId} timed out (no heartbeat for 30s)`,
        completedAt: Date.now(),
      });

      if (canRetry) {
        updateTaskInDb(stuckExec.taskId, {
          status: 'ready',
          retryCount: nextRetry,
          assignedAgentId: null,
        });
        this.claimManager.releaseClaim(stuckExec.taskId, 'retry');
        eventBus.emit({ type: 'task:retrying', taskId: stuckExec.taskId, attempt: nextRetry });
      } else {
        this.claimManager.releaseClaim(stuckExec.taskId, 'failed');
      }

      this.heartbeatManager.ping(agentId, runId, 'idle');
    }
  }

  // ─── Task Execution ──────────────────────────────────────────────────────

  private async executeClaimedTask(runId: string, taskId: string, agentId: string, signal: AbortSignal, attempt = 1): Promise<TaskExecution> {
    const emptyInput: TaskExecutionInput = {
      prompt: '',
      systemPrompt: '',
      tools: [],
      context: '',
      workingDirectory: '',
      orchestrationBrief: null,
    };

    const execution: TaskExecution = {
      id: randomUUID(),
      runId,
      taskId,
      agentId,
      sessionId: null,
      status: 'pending',
      attempt,
      input: emptyInput,
      output: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      error: null,
    };
    insertTaskExecution(execution);

    const task = getTaskByIdGlobal(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const project = getProjectById(task.projectId);
    if (!project) throw new Error(`Project not found: ${task.projectId}`);

    updateTaskExecution(execution.id, { agentId, status: 'running', startedAt: Date.now() });

    const agent = await this.agentService.getById(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    // Heartbeat ping: mark agent as working on this task
    this.heartbeatManager.ping(agentId, runId, 'working', taskId);

    const plan = getRunById(runId)?.executionPlan;
    const execCtx: TaskExecutionContext = {
      batchIndex: 0,
      totalBatches: plan?.batches.length ?? 1,
      dependencyGraph: plan?.dependencyGraph ?? [],
    };

    const brief = this.buildOrchestrationBrief(runId, task, execCtx);
    const unreadMessages = this.messageService.getUnread(agentId, runId);

    // Auto-mark injected messages as read — agents see them via context but rarely call mark_read themselves
    for (const msg of unreadMessages) {
      this.messageService.markRead(msg.id, agentId);
    }

    const run = getRunById(runId);
    const context: AgentContext = await this.contextBuilder.build({
      agent,
      task,
      priorResults: [],
      projectId: task.projectId,
      projectDirectory: project.directoryPath,
      orchestrationBrief: brief,
      unreadMessages,
      autonomousMode: !run?.config.requireHumanApproval,
    });

    eventBus.emit({ type: 'task:assigned', taskId, agentId, runId });

    const callbacks: RunnerCallbacks = {
      onStart: (session: AgentSession) => {
        updateTaskExecution(execution.id, { sessionId: session.id });
        eventBus.emit({ type: 'task:started', taskId, agentId, sessionId: session.id });
      },
      onChunk: (sessionId: string, chunk: string) => {
        eventBus.emit({ type: 'task:progress', taskId, chunk });
      },
      onToolUse: (sessionId: string, tool: string) => {
        eventBus.emit({ type: 'task:tool_use', taskId, tool });
      },
      onComplete: (sessionId: string, output) => {
        eventBus.emit({ type: 'task:completed', taskId, output });
      },
      onError: (sessionId: string, error: Error) => {
        eventBus.emit({ type: 'task:failed', taskId, error: error.message, attempt: execution.attempt });
      },
    };

    const heartbeatInterval = setInterval(() => {
      this.heartbeatManager.ping(agentId, runId, 'working', taskId);
    }, 10000);

    try {
      const startTime = Date.now();
      const taskTimeout = run?.config.taskTimeoutMs ?? 900000;
      const output = await Promise.race([
        this.runner.run(context, execution.id, callbacks, signal),
        this.sleep(taskTimeout).then(() => {
          throw new Error(`Task execution timed out after ${taskTimeout}ms`);
        }),
      ]);
      clearInterval(heartbeatInterval);
      const durationMs = Date.now() - startTime;

      updateTaskExecution(execution.id, {
        status: 'completed',
        output,
        completedAt: Date.now(),
        durationMs,
      });

      const freshTask = getTaskByIdGlobal(taskId);
      const currentRun = getRunById(runId);

      if (currentRun?.config.autoReview && freshTask?.acceptanceCriteria?.length) {
        updateTaskInDb(taskId, { status: 'review' });
        const completedExecution: TaskExecution = {
          ...execution,
          agentId,
          status: 'completed',
          output,
          completedAt: Date.now(),
          durationMs,
        };
        const reviewResult = await this.reviewer.reviewWithCriteria(completedExecution, freshTask, {
          projectDirectory: project.directoryPath,
        });

        if (!reviewResult.passed) {
          if ((freshTask.retryCount ?? 0) < (freshTask.maxRetries ?? 2)) {
            updateTaskExecution(execution.id, {
              status: 'failed',
              error: reviewResult.feedback,
              completedAt: Date.now(),
              durationMs,
            });
            updateTaskInDb(taskId, {
              status: 'ready',
              retryCount: (freshTask.retryCount ?? 0) + 1,
              reviewFeedback: reviewResult.feedback,
              assignedAgentId: null,
            });
            this.claimManager.releaseClaim(taskId, 'retry');
            this.heartbeatManager.ping(agentId, runId, 'idle');
            eventBus.emit({ type: 'task:retrying', taskId, attempt: (freshTask.retryCount ?? 0) + 1 });
            return { ...execution, status: 'retrying' as const, agentId, output, completedAt: Date.now(), durationMs };
          }
          updateTaskExecution(execution.id, {
            status: 'failed',
            error: `Review failed after ${freshTask.maxRetries} attempts: ${reviewResult.feedback}`,
            completedAt: Date.now(),
            durationMs,
          });
          this.claimManager.releaseClaim(taskId, 'failed');
          this.heartbeatManager.ping(agentId, runId, 'idle');
          return { ...execution, status: 'failed', agentId, output, completedAt: Date.now(), durationMs };
        }
      }

      this.claimManager.releaseClaim(taskId, 'completed');
      this.heartbeatManager.ping(agentId, runId, 'idle');

      return { ...execution, agentId, status: 'completed', output, completedAt: Date.now(), durationMs };
    } catch (error) {
      clearInterval(heartbeatInterval);
      const durationMs = Date.now() - (execution.startedAt ?? Date.now());
      updateTaskExecution(execution.id, {
        status: 'failed',
        error: String(error),
        completedAt: Date.now(),
        durationMs,
      });

      const db = getDb();
      db.prepare(
        "UPDATE tasks SET retry_count = retry_count + 1, updated_at = $now WHERE id = $id"
      ).run({ $id: taskId, $now: Date.now() });

      this.claimManager.releaseClaim(taskId, 'failed');
      this.heartbeatManager.ping(agentId, runId, 'idle');

      throw error;
    }
  }

  // ─── Brief Construction ──────────────────────────────────────────────────

  private buildOrchestrationBrief(
    runId: string,
    task: Task,
    execCtx: TaskExecutionContext,
  ): OrchestrationBrief {
    const run = getRunById(runId);
    const rootTitles = (run?.rootTaskIds ?? [])
      .map((id) => getTaskByIdGlobal(id))
      .filter((t): t is Task => t !== null)
      .map((t) => t.title);
    const runGoal = rootTitles.length > 0 ? rootTitles.join('; ') : 'Unknown goal';

    const predecessorIds = new Set(
      execCtx.dependencyGraph
        .filter((e) => e.toTaskId === task.id)
        .map((e) => e.fromTaskId),
    );
    const priorResults: PriorTaskResult[] = [];
    if (predecessorIds.size > 0) {
      const executions = getTaskExecutionsByRunId(runId);
      for (const exec of executions) {
        if (predecessorIds.has(exec.taskId) && exec.status === 'completed' && exec.output) {
          const predTask = getTaskByIdGlobal(exec.taskId);
          priorResults.push({
            taskId: exec.taskId,
            taskTitle: predTask?.title ?? exec.taskId,
            result: exec.output.result,
            filesModified: exec.output.filesModified,
          });
        }
      }
    }

    const downstreamEdges = execCtx.dependencyGraph.filter((e) => e.fromTaskId === task.id);
    let downstreamHint: string | null = null;
    if (downstreamEdges.length > 0) {
      const names = downstreamEdges
        .map((e) => getTaskByIdGlobal(e.toTaskId))
        .filter((t): t is Task => t !== null)
        .map((t) => t.title);
      downstreamHint = names.length > 0
        ? `Downstream tasks depend on your output: ${names.join(', ')}`
        : null;
    }

    return {
      runGoal,
      taskObjective: task.description || task.title,
      priorResults,
      positionInPlan: `Batch ${execCtx.batchIndex + 1} of ${execCtx.totalBatches}`,
      downstreamHint,
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private updateRunStatus(runId: string, status: Run['status']): void {
    updateRun(runId, { status });
  }

  private buildRunResult(executions: TaskExecution[]): RunResult {
    const latestByTask = new Map<string, TaskExecution>();
    for (const exec of executions) {
      const existing = latestByTask.get(exec.taskId);
      if (!existing || (exec.startedAt ?? 0) > (existing.startedAt ?? 0)) {
        latestByTask.set(exec.taskId, exec);
      }
    }
    const latestExecutions = Array.from(latestByTask.values());

    const completed = latestExecutions.filter((e) => e.status === 'completed');
    const failed = latestExecutions.filter((e) => e.status === 'failed');
    const skipped = latestExecutions.filter((e) => e.status === 'skipped');
    const totalDuration = latestExecutions.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);

    return {
      totalTasks: latestExecutions.length,
      completedTasks: completed.length,
      failedTasks: failed.length,
      skippedTasks: skipped.length,
      totalDurationMs: totalDuration,
      taskResults: latestExecutions,
    };
  }

  private isNonTerminalStatus(status: RunStatus): boolean {
    return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Crash Recovery ──────────────────────────────────────────────────────

  /**
   * Recover zombie runs left in non-terminal states after a server restart.
   * Runs that were active during a graceful shutdown are reset to 'pending' (restartable).
   * Truly orphaned runs (hard crash) are marked 'failed'.
   * Must be called once during engine initialization.
   */
  recoverZombieRuns(): number {
    const db = getDb();
    const zombieStatuses = ['decomposing', 'scheduling', 'running', 'reviewing'];
    const placeholders = zombieStatuses.map(() => '?').join(',');
    const now = Date.now();

    const zombieRuns = db.prepare(
      `SELECT id, project_id, status FROM runs WHERE status IN (${placeholders})`
    ).all(...zombieStatuses) as Array<{ id: string; project_id: string; status: string }>;

    if (zombieRuns.length === 0) {
      this.clearGracefulMarker();
      return 0;
    }

    const gracefulRunIds = this.readGracefulMarker();
    const isDev = process.env.NODE_ENV !== 'production';

    for (const run of zombieRuns) {
      const wasGraceful = gracefulRunIds.has(run.id);
      const shouldResetToPending = wasGraceful || isDev;

      if (shouldResetToPending) {
        const reason = wasGraceful ? 'graceful restart' : 'dev-mode restart';
        console.log(`[Crash Recovery] ${reason} detected for run ${run.id} (was: ${run.status}) → resetting to pending`);
        db.prepare(
          `UPDATE runs SET status = 'pending', started_at = NULL, execution_plan = NULL, result = NULL WHERE id = $id`
        ).run({ $id: run.id });
      } else {
        console.log(`[Crash Recovery] Hard crash detected for run ${run.id} (was: ${run.status}) → marking failed`);
        db.prepare(
          `UPDATE runs SET status = 'failed', completed_at = $now, result = $result WHERE id = $id`
        ).run({
          $id: run.id,
          $now: now,
          $result: JSON.stringify({
            totalTasks: 0, completedTasks: 0, failedTasks: 0, skippedTasks: 0,
            totalDurationMs: 0, taskResults: [],
            error: `Server crashed while run was in '${run.status}' state`,
          }),
        });
      }

      const runRecord = getRunById(run.id);
      const crashPlanTaskIds = runRecord?.executionPlan?.batches.flatMap(b => b.taskIds) ?? [];
      if (crashPlanTaskIds.length > 0) {
        const ph = crashPlanTaskIds.map(() => '?').join(',');
        db.prepare(
          `UPDATE tasks SET status = 'ready', assigned_agent_id = NULL, updated_at = ?
           WHERE id IN (${ph}) AND status = 'in_progress'`
        ).run(now, ...crashPlanTaskIds);
      } else {
        db.prepare(
          `UPDATE tasks SET status = 'ready', assigned_agent_id = NULL, updated_at = $now
           WHERE project_id = $pid AND status = 'in_progress'`
        ).run({ $pid: run.project_id, $now: now });
      }

      db.prepare(
        `UPDATE agent_heartbeats SET status = 'offline' WHERE run_id = $runId`
      ).run({ $runId: run.id });

      this.interactionGate.cancelAllForRun(run.id, 'Server restarted');
    }

    this.clearGracefulMarker();
    console.log(`[Crash Recovery] Recovered ${zombieRuns.length} run(s) (${gracefulRunIds.size} graceful, ${zombieRuns.length - gracefulRunIds.size} crashed)`);
    return zombieRuns.length;
  }

  private writeGracefulMarker(): void {
    const runIds = Array.from(this.activeRuns.keys());
    if (runIds.length === 0) return;
    try {
      writeFileSync(GRACEFUL_MARKER_PATH, JSON.stringify({ runIds, timestamp: Date.now() }));
    } catch { /* best effort */ }
  }

  private readGracefulMarker(): Set<string> {
    try {
      if (!existsSync(GRACEFUL_MARKER_PATH)) return new Set();
      const data = JSON.parse(readFileSync(GRACEFUL_MARKER_PATH, 'utf-8')) as { runIds: string[] };
      return new Set(data.runIds);
    } catch {
      return new Set();
    }
  }

  private clearGracefulMarker(): void {
    try {
      if (existsSync(GRACEFUL_MARKER_PATH)) unlinkSync(GRACEFUL_MARKER_PATH);
    } catch { /* best effort */ }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  writeGracefulMarkerSync(): void {
    this.writeGracefulMarker();
  }

  dispose(): void {
    this.writeGracefulMarker();
    for (const [runId, controller] of this.activeRuns) {
      controller.abort();
    }
    this.heartbeatManager.dispose();
  }
}
