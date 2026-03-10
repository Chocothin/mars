import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { Run, RunConfig, RunStatus, TaskExecution, TaskExecutionInput, RunResult, TaskExecutionOutput } from './types';
import type { IAgentService, Agent } from '../types/agent';
import type { Task, ITaskService } from '../types/task';
import type { ICliExecutor } from '../types/provider';
import type { IMessageService } from '../messaging/service';
import type { IResultReviewer } from './reviewer';
import type { ITaskDecomposer } from './decomposer';
import type { MatchedPair } from './task-matcher';
import { ContextBuilder } from '../execution/context-builder';
import { InteractionGate } from '../hitl/interaction-gate';
import { eventBus } from '../events/bus';
import { insertRun, getRunById, updateRun, queryRuns } from '../db/run-repo';
import { insertTaskExecution, updateTaskExecution, getTaskExecutionsByRunId } from '../db/task-exec-repo';
import { getTaskByIdGlobal, updateTask as updateTaskInDb } from '../db/task-repo';
import { getProjectById } from '../db/project-repo';
import { getAgentById } from '../db/agent-repo';
import { getDb } from '../db/index';
import { AgentPool, type AgentPoolEntry } from './agent-pool';
import { ReactiveScheduler } from './reactive-scheduler';
import { TaskMatcher } from './task-matcher';
import { AgentProcess } from './agent-process';
import type { AgentProcessConfig } from './agent-process';

// ─── Defaults ───

const DEFAULT_RUN_CONFIG: RunConfig = {
  maxConcurrency: 3,
  maxRetries: 1,
  timeoutMs: 3 * 60 * 60 * 1000,
  taskTimeoutMs: 900000,
  autoReview: true,
  requireHumanApproval: false,
  hitl: null,
};

// ─── Interface ───

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

// ─── Engine ───

const GRACEFUL_MARKER_PATH = join(process.env.HOME ?? '/tmp', '.mars', 'graceful-shutdown-runs.json');

const TICK_INTERVAL_MS = 1000;

export class OrchestratorEngine implements IOrchestratorEngine {
  private pool: AgentPool;
  private scheduler: ReactiveScheduler;
  private matcher: TaskMatcher;
  private contextBuilder: ContextBuilder;
  private interactionGate: InteractionGate;
  private agentService: IAgentService;
  private taskService: ITaskService;
  private cliExecutor: ICliExecutor;
  private messageService: IMessageService;
  private reviewer: IResultReviewer;
  private decomposer: ITaskDecomposer;
  private activeRuns = new Map<string, AbortController>();
  private processes = new Map<string, AgentProcess>();
  private decomposing = new Set<string>();

  constructor(deps: {
    pool: AgentPool;
    scheduler: ReactiveScheduler;
    contextBuilder: ContextBuilder;
    interactionGate: InteractionGate;
    agentService: IAgentService;
    taskService: ITaskService;
    cliExecutor: ICliExecutor;
    messageService: IMessageService;
    reviewer: IResultReviewer;
    decomposer: ITaskDecomposer;
  }) {
    this.pool = deps.pool;
    this.scheduler = deps.scheduler;
    this.matcher = new TaskMatcher(this.pool, this.scheduler);
    this.contextBuilder = deps.contextBuilder;
    this.interactionGate = deps.interactionGate;
    this.agentService = deps.agentService;
    this.taskService = deps.taskService;
    this.cliExecutor = deps.cliExecutor;
    this.messageService = deps.messageService;
    this.reviewer = deps.reviewer;
    this.decomposer = deps.decomposer;
  }

  // ─── Accessors ───

  getAgentPool(): AgentPool { return this.pool; }

  // ─── Public API ───

  async createRun(projectId: string, taskIds: string[], config?: Partial<RunConfig>): Promise<Run> {
    const project = getProjectById(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (taskIds.length === 0) throw new Error('At least one taskId is required');

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
    const cas = db.prepare(
      "UPDATE runs SET status = 'running', started_at = $now WHERE id = $id AND status = 'pending'"
    ).run({ $id: runId, $now: Date.now() });
    if (cas.changes === 0) {
      const run = getRunById(runId);
      throw new Error(`Run ${runId} is not in pending state (current: ${run?.status ?? 'not found'})`);
    }

    const run = getRunById(runId)!;
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);

    try {
      eventBus.emit({ type: 'run:started', runId });
      await this.registerAgents(run);
      await this.coreLoop(run, controller.signal);

      const finalRun = getRunById(runId);
      if (finalRun && this.isNonTerminal(finalRun.status)) {
        this.finalizeRun(runId);
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

    updateRun(runId, { status: 'paused' });
    eventBus.emit({ type: 'run:paused', runId });
  }

  async resumeRun(runId: string): Promise<void> {
    const run = getRunById(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    updateRun(runId, { status: 'running' });

    const controller = new AbortController();
    this.activeRuns.set(runId, controller);

    try {
      await this.registerAgents(run);
      await this.coreLoop(run, controller.signal);

      const finalRun = getRunById(runId);
      if (finalRun && this.isNonTerminal(finalRun.status)) {
        this.finalizeRun(runId);
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
    if (controller) controller.abort();

    this.interactionGate.cancelAllForRun(runId, 'Run cancelled');

    const now = Date.now();
    const db = getDb();
    db.prepare(
      "UPDATE tasks SET status = 'cancelled', assigned_agent_id = NULL, updated_at = $now WHERE project_id = $pid AND status IN ('in_progress', 'ready')"
    ).run({ $pid: run.projectId, $now: now });

    for (const [agentId, proc] of this.processes) {
      if (proc.runId === runId) {
        proc.terminate();
        this.processes.delete(agentId);
      }
    }

    updateRun(runId, { status: 'cancelled', completedAt: now });
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

  // ─── Core Loop ───

  private async coreLoop(run: Run, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const scopeTaskIds = this.scheduler.collectAllTaskIds(run.rootTaskIds);

      this.scheduler.activateBacklogTasks(scopeTaskIds);
      this.scheduler.refreshReadyTasks(scopeTaskIds);
      this.scheduler.refreshParentStatuses(scopeTaskIds);

      if (this.scheduler.isAllDone(scopeTaskIds)) break;

      // Decomposition: 직접 호출 (matcher/pool 미경유)
      const decomposable = this.scheduler.findDecomposableTasks(scopeTaskIds);
      for (const task of decomposable) {
        if (signal.aborted) break;
        if (this.decomposing.has(task.id)) continue;
        this.triggerDecomposition(run, task);
      }

      // Execution: matcher로 ready leaf ↔ idle agent 매칭
      const pairs = this.matcher.match(scopeTaskIds);
      for (const pair of pairs) {
        if (signal.aborted) break;
        this.dispatchTask(run, pair, signal);
      }

      await this.sleep(TICK_INTERVAL_MS);
    }
  }

  // ─── Task Dispatch ───

  private dispatchTask(run: Run, pair: MatchedPair, signal: AbortSignal): void {
    const { agent, task } = pair;

    const assignResult = this.pool.assign(agent.agentId, task.id);
    if (!assignResult.success) return;

    updateTaskInDb(task.id, { status: 'in_progress', assignedAgentId: agent.agentId });
    eventBus.emit({ type: 'task:assigned', taskId: task.id, agentId: agent.agentId, runId: run.id });

    this.dispatchExecution(run, agent, task, signal);
  }

  private dispatchExecution(run: Run, agent: AgentPoolEntry, task: Task, _signal: AbortSignal): void {
    const proc = this.getOrCreateProcess(agent.agentId, run);

    proc.execute(task, [], (chunk) => {
      eventBus.emit({ type: 'task:progress', taskId: task.id, chunk });
    }).then(async (result) => {
      await this.onTaskCompleted(run, task.id, agent.agentId, result.output);
    }).catch((error) => {
      this.onTaskFailed(run, task.id, agent.agentId, error);
    });
  }

  private triggerDecomposition(run: Run, task: Task): void {
    this.decomposing.add(task.id);
    const project = getProjectById(run.projectId);
    const projectContext = project?.directoryPath ?? '';

    eventBus.emit({ type: 'decompose:started', taskId: task.id });

    this.decomposer.decompose(task.id, projectContext)
      .then(() => {
        eventBus.emit({ type: 'decompose:approved', taskId: task.id, subtaskIds: [] });
      })
      .catch((err) => {
        console.error(`[Run ${run.id}] Decomposition failed for ${task.id}:`, err);
        updateTaskInDb(task.id, { status: 'failed' });
      })
      .finally(() => {
        this.decomposing.delete(task.id);
      });
  }

  private async onTaskCompleted(
    run: Run,
    taskId: string,
    agentId: string,
    output: TaskExecutionOutput,
  ): Promise<void> {
    const task = getTaskByIdGlobal(taskId);

    if (run.config.autoReview && task?.acceptanceCriteria?.length) {
      updateTaskInDb(taskId, { status: 'review' });
      const execution = this.buildExecution(run.id, taskId, agentId, 'completed', output);
      const reviewResult = await this.reviewer.reviewWithCriteria(execution, task, {
        projectDirectory: getProjectById(task.projectId)?.directoryPath ?? '',
      });

      if (!reviewResult.passed) {
        const retryCount = (task.retryCount ?? 0) + 1;
        const maxRetries = task.maxRetries ?? run.config.maxRetries;
        if (retryCount <= maxRetries) {
          updateTaskInDb(taskId, {
            status: 'ready',
            retryCount,
            reviewFeedback: reviewResult.feedback,
            assignedAgentId: null,
          });
          this.pool.release(agentId);
          eventBus.emit({ type: 'task:retrying', taskId, attempt: retryCount });
          return;
        }
        updateTaskInDb(taskId, { status: 'failed' });
        this.pool.release(agentId);
        return;
      }
    }

    updateTaskInDb(taskId, { status: 'done' });
    this.pool.release(agentId);

    const exec = this.buildExecution(run.id, taskId, agentId, 'completed', output);
    insertTaskExecution(exec);
  }

  private onTaskFailed(run: Run, taskId: string, agentId: string, error: unknown): void {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Run ${run.id}] Task ${taskId} failed:`, errorMsg);

    const task = getTaskByIdGlobal(taskId);
    const retryCount = (task?.retryCount ?? 0) + 1;
    const maxRetries = task?.maxRetries ?? run.config.maxRetries;

    if (retryCount <= maxRetries) {
      updateTaskInDb(taskId, {
        status: 'ready',
        retryCount,
        assignedAgentId: null,
      });
      eventBus.emit({ type: 'task:retrying', taskId, attempt: retryCount });
    } else {
      updateTaskInDb(taskId, { status: 'failed' });
      const exec = this.buildExecution(run.id, taskId, agentId, 'failed', null);
      exec.error = errorMsg;
      insertTaskExecution(exec);
    }

    this.pool.release(agentId);
  }

  // ─── Agent Registration ───

  private async registerAgents(run: Run): Promise<void> {
    const agents = await this.agentService.list({ enabled: true });
    for (const agent of agents) {
      this.pool.register(agent, run.id);
    }
  }

  private getOrCreateProcess(agentId: string, run: Run): AgentProcess {
    const existing = this.processes.get(agentId);
    if (existing && existing.runId === run.id && existing.getState() !== 'terminated') {
      return existing;
    }

    const entry = this.pool.get(agentId);
    if (!entry) throw new Error(`Agent ${agentId} not in pool`);

    const project = getProjectById(run.projectId);
    if (!project) throw new Error(`Project not found: ${run.projectId}`);

    const agentRecord = getAgentById(agentId);
    if (!agentRecord) throw new Error(`Agent record not found: ${agentId}`);

    const config: AgentProcessConfig = {
      agent: agentRecord,
      cliExecutor: this.cliExecutor,
      contextBuilder: this.contextBuilder,
      projectDirectory: project.directoryPath,
      projectId: run.projectId,
      runId: run.id,
    };

    const proc = new AgentProcess(config);
    this.processes.set(agentId, proc);
    return proc;
  }

  // ─── Finalization ───

  private finalizeRun(runId: string): void {
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

  private buildRunResult(executions: TaskExecution[]): RunResult {
    const latestByTask = new Map<string, TaskExecution>();
    for (const exec of executions) {
      const existing = latestByTask.get(exec.taskId);
      if (!existing || (exec.startedAt ?? 0) > (existing.startedAt ?? 0)) {
        latestByTask.set(exec.taskId, exec);
      }
    }
    const latest = Array.from(latestByTask.values());

    return {
      totalTasks: latest.length,
      completedTasks: latest.filter(e => e.status === 'completed').length,
      failedTasks: latest.filter(e => e.status === 'failed').length,
      skippedTasks: latest.filter(e => e.status === 'skipped').length,
      totalDurationMs: latest.reduce((sum, e) => sum + (e.durationMs ?? 0), 0),
      taskResults: latest,
    };
  }

  private buildExecution(
    runId: string,
    taskId: string,
    agentId: string,
    status: TaskExecution['status'],
    output: TaskExecutionOutput | null,
  ): TaskExecution {
    return {
      id: randomUUID(),
      runId,
      taskId,
      agentId,
      sessionId: null,
      status,
      attempt: 1,
      input: { prompt: '', systemPrompt: '', tools: [], context: '', workingDirectory: '', orchestrationBrief: null },
      output,
      startedAt: Date.now(),
      completedAt: Date.now(),
      durationMs: 0,
      error: null,
    };
  }

  // ─── Helpers ───

  private isNonTerminal(status: RunStatus): boolean {
    return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Crash Recovery ───

  recoverZombieRuns(): string[] {
    const db = getDb();
    const zombieStatuses = ['decomposing', 'scheduling', 'running', 'reviewing'];
    const placeholders = zombieStatuses.map(() => '?').join(',');
    const now = Date.now();

    const zombieRuns = db.prepare(
      `SELECT id, project_id, status FROM runs WHERE status IN (${placeholders})`
    ).all(...zombieStatuses) as Array<{ id: string; project_id: string; status: string }>;

    if (zombieRuns.length === 0) {
      this.clearGracefulMarker();
      return [];
    }

    const gracefulRunIds = this.readGracefulMarker();
    const isDev = process.env.NODE_ENV !== 'production';
    const recoveredRunIds: string[] = [];

    for (const run of zombieRuns) {
      const shouldReset = gracefulRunIds.has(run.id) || isDev;

      if (shouldReset) {
        db.prepare(
          "UPDATE runs SET status = 'pending', started_at = NULL, execution_plan = NULL, result = NULL WHERE id = $id"
        ).run({ $id: run.id });
        recoveredRunIds.push(run.id);
      } else {
        db.prepare(
          "UPDATE runs SET status = 'failed', completed_at = $now, result = $result WHERE id = $id"
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

      db.prepare(
        "UPDATE tasks SET status = 'ready', assigned_agent_id = NULL, updated_at = $now WHERE project_id = $pid AND status = 'in_progress'"
      ).run({ $pid: run.project_id, $now: now });

      this.interactionGate.cancelAllForRun(run.id, 'Server restarted');
    }

    this.clearGracefulMarker();

    if (recoveredRunIds.length > 0) {
      console.log(`[CrashRecovery] Recovered ${recoveredRunIds.length} run(s), auto-resuming...`);
      for (const runId of recoveredRunIds) {
        this.startRun(runId).catch((err) => {
          console.error(`[CrashRecovery] Failed to auto-resume run ${runId}:`, err);
        });
      }
    }

    return recoveredRunIds;
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

  // ─── Lifecycle ───

  writeGracefulMarkerSync(): void {
    this.writeGracefulMarker();
  }

  dispose(): void {
    this.writeGracefulMarker();
    for (const [, controller] of this.activeRuns) {
      controller.abort();
    }
    for (const [, proc] of this.processes) {
      proc.terminate();
    }
    this.processes.clear();
    this.pool.shutdown();
  }
}
