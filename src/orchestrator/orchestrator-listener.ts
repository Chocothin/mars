import { eventBus } from '../events/bus';
import type { ExtractEvent } from '../events/types';
import type { OrchestratorRegistry } from './orchestrator-registry';
import type { ReactiveScheduler } from './reactive-scheduler';
import * as messageRepo from '../messaging/repo';
import { getRunById } from '../db/run-repo';
import { getTaskByIdGlobal } from '../db/task-repo';

// ─── Configuration ───

const DEBOUNCE_MS = 5_000;
const COOLDOWN_MS = 15_000;
const MAX_CONCURRENT = 2;
const MAX_INVOCATIONS_PER_RUN = 30;
const MAX_BATCH_SIZE = 10;
const RETRY_DELAY_MS = 5_000;

// ─── Types ───

interface AccumulatedEvent {
  type: string;
  timestamp: number;
  summary: string;
  projectId: string;
  runId?: string;
}

// ─── OrchestratorListener: 이벤트 기반 오케스트레이터 wake-up ───

export class OrchestratorListener {
  private unsubscribers: Array<() => void> = [];
  private pendingEvents = new Map<string, AccumulatedEvent[]>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastInvocation = new Map<string, number>();
  private activeInvocations = 0;
  private runInvocationCounts = new Map<string, number>();

  constructor(
    private registry: OrchestratorRegistry,
    private scheduler: ReactiveScheduler,
  ) {
    this.subscribe();
    console.log('[OrchestratorListener] Initialized');
  }

  private subscribe(): void {
    this.unsubscribers.push(
      eventBus.on('run:stalled', (event) => this.onRunStalled(event)),
    );

    this.unsubscribers.push(
      eventBus.on('message:sent', (event) => this.onMessageSent(event)),
    );

    this.unsubscribers.push(
      eventBus.on('run:completed', (event) => this.onRunTerminal(event, 'completed')),
    );

    this.unsubscribers.push(
      eventBus.on('run:failed', (event) => this.onRunTerminal(event, 'failed')),
    );

    // NOTE: task:completed is intentionally NOT subscribed — prevents infinite loops
  }

  // ─── Event Handlers ───

  private onRunStalled(event: ExtractEvent<'run:stalled'>): void {
    const run = getRunById(event.runId);
    if (!run) return;

    this.enqueue(run.projectId, {
      type: 'run:stalled',
      timestamp: Date.now(),
      summary: `Run Stalled: ${event.reason}`,
      projectId: run.projectId,
      runId: event.runId,
    });
  }

  private onMessageSent(event: ExtractEvent<'message:sent'>): void {
    if (event.to !== 'orchestrator') return;

    const msg = messageRepo.getMessageById(event.messageId);
    if (!msg) return;

    const run = getRunById(msg.runId);
    if (!run) return;

    const payloadSummary = typeof msg.payload?.summary === 'string'
      ? msg.payload.summary
      : JSON.stringify(msg.payload).slice(0, 200);

    this.enqueue(run.projectId, {
      type: `message:${msg.type}`,
      timestamp: Date.now(),
      summary: `${msg.type} from ${event.from}: ${payloadSummary}`,
      projectId: run.projectId,
      runId: msg.runId,
    });
  }

  private onRunTerminal(event: { runId: string }, status: 'completed' | 'failed'): void {
    const run = getRunById(event.runId);
    if (!run) return;

    this.enqueue(run.projectId, {
      type: `run:${status}`,
      timestamp: Date.now(),
      summary: `Run ${status}`,
      projectId: run.projectId,
      runId: event.runId,
    });

    this.runInvocationCounts.delete(event.runId);
  }

  // ─── Debounce & Dispatch ───

  private enqueue(projectId: string, event: AccumulatedEvent): void {
    const pending = this.pendingEvents.get(projectId) ?? [];
    if (pending.length >= MAX_BATCH_SIZE) {
      pending.shift();
    }
    pending.push(event);
    this.pendingEvents.set(projectId, pending);

    const existing = this.debounceTimers.get(projectId);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(projectId, setTimeout(() => {
      this.debounceTimers.delete(projectId);
      this.tryDispatch(projectId);
    }, DEBOUNCE_MS));
  }

  private async tryDispatch(projectId: string): Promise<void> {
    const lastTime = this.lastInvocation.get(projectId) ?? 0;
    const elapsed = Date.now() - lastTime;
    if (elapsed < COOLDOWN_MS) {
      const remaining = COOLDOWN_MS - elapsed;
      this.debounceTimers.set(projectId, setTimeout(() => {
        this.debounceTimers.delete(projectId);
        this.tryDispatch(projectId);
      }, remaining));
      return;
    }

    if (this.activeInvocations >= MAX_CONCURRENT) {
      this.debounceTimers.set(projectId, setTimeout(() => {
        this.debounceTimers.delete(projectId);
        this.tryDispatch(projectId);
      }, RETRY_DELAY_MS));
      return;
    }

    const events = this.pendingEvents.get(projectId);
    if (!events || events.length === 0) return;
    this.pendingEvents.delete(projectId);

    const runIds = new Set(events.map(e => e.runId).filter((id): id is string => !!id));
    for (const runId of runIds) {
      const count = this.runInvocationCounts.get(runId) ?? 0;
      if (count >= MAX_INVOCATIONS_PER_RUN) {
        console.warn(`[OrchestratorListener] Run ${runId} reached max invocations (${MAX_INVOCATIONS_PER_RUN}), skipping`);
        return;
      }
    }

    this.activeInvocations++;
    this.lastInvocation.set(projectId, Date.now());
    for (const runId of runIds) {
      this.runInvocationCounts.set(runId, (this.runInvocationCounts.get(runId) ?? 0) + 1);
    }

    try {
      await this.invokeOrchestrator(projectId, events);
    } catch (error) {
      console.error(`[OrchestratorListener] Failed to invoke orchestrator for project ${projectId}:`, error);
    } finally {
      this.activeInvocations--;
    }
  }

  // ─── Orchestrator Invocation ───

  private async invokeOrchestrator(projectId: string, events: AccumulatedEvent[]): Promise<void> {
    const session = await this.registry.getOrCreate(projectId);
    session.resetSession();

    const prompt = this.buildWakeUpPrompt(events);

    console.log(`[OrchestratorListener] Waking orchestrator for project ${projectId} with ${events.length} event(s)`);

    try {
      const response = await session.send(prompt);
      console.log(`[OrchestratorListener] Orchestrator responded (${response.length} chars)`);
    } catch (error) {
      console.error(`[OrchestratorListener] Orchestrator session error:`, error);
      this.registry.terminate(projectId);
    }
  }

  private buildWakeUpPrompt(events: AccumulatedEvent[]): string {
    const sections: string[] = [];

    sections.push(`## Events (${events.length})`);
    for (const event of events) {
      const ago = this.formatTimeAgo(event.timestamp);
      sections.push(`- **${event.summary}** *(${ago})*`);
    }

    const runIds = [...new Set(events.map(e => e.runId).filter((id): id is string => !!id))];
    for (const runId of runIds) {
      const run = getRunById(runId);
      if (!run) continue;

      const scopeTaskIds = this.scheduler.collectAllTaskIds(run.rootTaskIds);
      const breakdown = this.scheduler.getStatusBreakdown(scopeTaskIds);

      sections.push('');
      sections.push(`## Run State (${runId.slice(0, 8)})`);
      sections.push(`Status: **${run.status}**`);
      sections.push(`Tasks: ${breakdown.done} done, ${breakdown.in_progress} in-progress, ${breakdown.ready} ready, ${breakdown.blocked} blocked, ${breakdown.failed} failed`);

      if (breakdown.failed > 0) {
        sections.push('');
        sections.push('### Failed Tasks');
        for (const id of scopeTaskIds) {
          const task = getTaskByIdGlobal(id);
          if (task && task.status === 'failed') {
            sections.push(`- **${task.title}** (${task.id.slice(0, 8)}) — retries: ${task.retryCount}/${task.maxRetries}`);
          }
        }
      }

      if (breakdown.blocked > 0) {
        sections.push('');
        sections.push('### Blocked Tasks');
        for (const id of scopeTaskIds) {
          const task = getTaskByIdGlobal(id);
          if (task && task.status === 'blocked') {
            sections.push(`- **${task.title}** (${task.id.slice(0, 8)})`);
          }
        }
      }
    }

    sections.push('');
    sections.push('## Your Decision');
    sections.push('Analyze the events and run state above, then take action using MCP tools:');
    sections.push('1. `task_create` — Create replacement tasks with a different approach');
    sections.push('2. `task_update` — Change priority, status, or description of existing tasks');
    sections.push('3. `message_send` — Send instructions to specific agents');
    sections.push('4. `run_create` + `run_start` — Create and start a new run if needed');
    sections.push('5. **NO_ACTION** — If the situation will resolve itself, respond with "NO_ACTION" and explain why');

    return sections.join('\n');
  }

  private formatTimeAgo(timestamp: number): string {
    const diffSec = Math.floor((Date.now() - timestamp) / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}min ago`;
    return `${Math.floor(diffMin / 60)}h ago`;
  }

  // ─── Lifecycle ───

  dispose(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];

    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.pendingEvents.clear();
  }
}
