import { eventBus } from '../events/bus';
import { InteractionStore } from './interaction-store';
import type {
  Interaction,
  InteractionRequest,
  InteractionResponse,
  Deferred,
  SimpleApprovalConfig,
  FallbackAction,
  ResponseAction,
} from './types';

export class InteractionGate {
  private pending: Map<string, Deferred<InteractionResponse>>;
  private timeouts: Map<string, Timer>;
  private config: SimpleApprovalConfig;
  private runApprovalOverrides: Map<string, boolean>;

  private store: InteractionStore;

  constructor(deps: {
    store: InteractionStore;
    config: SimpleApprovalConfig;
  }) {
    this.pending = new Map();
    this.timeouts = new Map();
    this.store = deps.store;
    this.config = deps.config;
    this.runApprovalOverrides = new Map();
  }

  setApprovalMode(runId: string, approvalRequired: boolean): void {
    this.runApprovalOverrides.set(runId, approvalRequired);
  }

  /** @deprecated Legacy compat for engine.ts — will be removed in TODO 8 */
  setRunOverrides(_runId: string, _overrides: unknown): void {
    // no-op: autonomy rules are ignored in binary approval mode
  }

  clearRunOverrides(runId: string): void {
    this.runApprovalOverrides.delete(runId);
  }

  async request(req: InteractionRequest): Promise<InteractionResponse> {
    const approvalRequired = this.runApprovalOverrides.get(req.runId) ?? this.config.approvalRequired;

    if (!approvalRequired) {
      return {
        action: req.question.suggestedAction ?? 'approve',
        message: 'HITL disabled — auto-approved',
        modifiedPayload: null,
        respondedBy: 'system',
      };
    }

    const interaction = this.createInteraction(req);
    return this.handleApproval(interaction);
  }

  async respond(interactionId: string, response: InteractionResponse): Promise<void> {
    const deferred = this.pending.get(interactionId);
    if (!deferred) {
      throw new Error(`No pending interaction found: ${interactionId}`);
    }

    this.clearPendingTimeout(interactionId);

    deferred.resolve(response);
    this.pending.delete(interactionId);

    const interaction = await this.store.getById(interactionId);
    if (interaction) {
      interaction.status = 'responded';
      interaction.response = response;
      interaction.respondedAt = Date.now();
      await this.store.update(interaction);
    }

    await this.store.deletePendingSnapshot(interactionId);

    eventBus.emit({
      type: 'hitl:responded',
      interactionId,
      runId: interaction?.runId ?? '',
      taskId: interaction?.taskId ?? null,
      response,
      durationMs: interaction ? Date.now() - interaction.createdAt : 0,
    });
  }

  async cancelAllForRun(runId: string, reason: string): Promise<void> {
    for (const [id, deferred] of this.pending.entries()) {
      const interaction = await this.store.getById(id);
      if (interaction && interaction.runId === runId) {
        this.clearPendingTimeout(id);
        deferred.reject(new Error(`Run cancelled: ${reason}`));
        this.pending.delete(id);

        interaction.status = 'cancelled';
        interaction.respondedAt = Date.now();
        await this.store.update(interaction);
        await this.store.deletePendingSnapshot(id);

        eventBus.emit({
          type: 'hitl:cancelled',
          interactionId: id,
          runId,
          reason,
        });
      }
    }
  }

  restorePending(interactionId: string): Promise<InteractionResponse> {
    const deferred = this.createDeferred<InteractionResponse>();
    this.pending.set(interactionId, deferred);
    return deferred.promise;
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  getPendingIds(): string[] {
    return Array.from(this.pending.keys());
  }

  hasPending(interactionId: string): boolean {
    return this.pending.has(interactionId);
  }

  async getPendingForRun(runId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const id of this.pending.keys()) {
      const interaction = await this.store.getById(id);
      if (interaction && interaction.runId === runId) {
        ids.push(id);
      }
    }
    return ids;
  }

  getPendingPromise(interactionId: string): Promise<InteractionResponse> | null {
    const deferred = this.pending.get(interactionId);
    return deferred ? deferred.promise : null;
  }

  updateConfig(config: Partial<SimpleApprovalConfig>): void {
    this.config = { ...this.config, ...config };
  }

  dispose(): void {
    for (const timer of this.timeouts.values()) {
      clearTimeout(timer);
    }
    this.timeouts.clear();
    for (const deferred of this.pending.values()) {
      deferred.reject(new Error('InteractionGate disposed'));
    }
    this.pending.clear();
  }

  // ─── Approval Handler ───

  private async handleApproval(interaction: Interaction): Promise<InteractionResponse> {
    const deferred = this.createDeferred<InteractionResponse>();
    this.pending.set(interaction.id, deferred);

    interaction.status = 'pending';
    await this.store.save(interaction);
    await this.store.savePendingSnapshot({
      interaction,
      createdAt: Date.now(),
      schemaVersion: 1,
    });

    if (interaction.timeoutMs !== null) {
      const timer = setTimeout(() => {
        this.handleTimeout(interaction.id);
      }, interaction.timeoutMs);
      this.timeouts.set(interaction.id, timer);
    }

    eventBus.emit({
      type: 'hitl:created',
      interactionId: interaction.id,
      runId: interaction.runId,
      taskId: interaction.taskId,
      questionType: interaction.type,
      level: interaction.level,
      question: interaction.question,
      timeoutMs: interaction.timeoutMs,
      expiresAt: interaction.expiresAt,
      priority: interaction.metadata.priority,
    });

    return deferred.promise;
  }

  // ─── Timeout ───

  private async handleTimeout(interactionId: string): Promise<void> {
    if (!this.pending.has(interactionId)) {
      return;
    }

    const interaction = await this.store.getById(interactionId);
    if (!interaction) return;

    const fallbackResponse: InteractionResponse = {
      action: this.mapFallbackToAction(interaction.fallbackAction),
      message: `Timeout after ${interaction.timeoutMs}ms — fallback: ${interaction.fallbackAction}`,
      modifiedPayload: null,
      respondedBy: 'timeout',
    };

    const deferred = this.pending.get(interactionId);
    if (deferred) {
      deferred.resolve(fallbackResponse);
      this.pending.delete(interactionId);
    }

    interaction.status = 'timeout';
    interaction.response = fallbackResponse;
    interaction.respondedAt = Date.now();
    await this.store.update(interaction);
    await this.store.deletePendingSnapshot(interactionId);

    eventBus.emit({
      type: 'hitl:timeout',
      interactionId,
      runId: interaction.runId,
      taskId: interaction.taskId,
      fallbackAction: interaction.fallbackAction,
      timeoutMs: interaction.timeoutMs!,
    });
  }

  // ─── Factory ───

  private createInteraction(req: InteractionRequest): Interaction {
    const now = Date.now();
    const timeoutMs = req.timeoutMs !== undefined ? req.timeoutMs : (this.config.timeoutMs || null);
    const fallbackAction = req.fallbackAction ?? this.config.fallbackAction;
    return {
      id: crypto.randomUUID(),
      runId: req.runId,
      taskId: req.taskId ?? null,
      agentId: req.agentId ?? null,
      sessionId: req.sessionId ?? null,
      type: req.type,
      level: 3,
      status: 'pending',
      question: req.question,
      autoDecision: null,
      response: null,
      timeoutMs,
      fallbackAction,
      expiresAt: timeoutMs ? now + timeoutMs : null,
      metadata: {
        source: req.metadata?.source ?? 'orchestrator',
        batchIndex: req.metadata?.batchIndex ?? null,
        attempt: req.metadata?.attempt ?? null,
        priority: req.metadata?.priority ?? 'normal',
        tags: req.metadata?.tags ?? [],
      },
      createdAt: now,
      respondedAt: null,
    };
  }

  private createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject, createdAt: Date.now() };
  }

  private clearPendingTimeout(interactionId: string): void {
    const timer = this.timeouts.get(interactionId);
    if (timer) {
      clearTimeout(timer);
      this.timeouts.delete(interactionId);
    }
  }

  private mapFallbackToAction(fallback: FallbackAction): ResponseAction {
    switch (fallback) {
      case 'fail': return 'reject';
      case 'auto_approve': return 'approve';
      case 'auto_answer': return 'answer';
      case 'skip': return 'skip';
      default: return 'reject';
    }
  }
}
