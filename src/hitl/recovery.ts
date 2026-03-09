import { InteractionGate } from './interaction-gate';
import { InteractionStore } from './interaction-store';
import type { IEventBus } from '../events/bus';
import type {
  Interaction,
  InteractionResponse,
  FallbackAction,
  ResponseAction,
  PendingInteractionSnapshot,
} from './types';

export interface RecoveryDetail {
  interactionId: string;
  status: 'recovered' | 'expired' | 'failed';
  originalCreatedAt: number;
}

export interface RecoveryResult {
  recovered: number;
  expired: number;
  failed: number;
  details: RecoveryDetail[];
}

export class RecoveryManager {
  private gate: InteractionGate;
  private store: InteractionStore;
  private eventBus: IEventBus;

  constructor({
    gate,
    store,
    eventBus,
  }: {
    gate: InteractionGate;
    store: InteractionStore;
    eventBus: IEventBus;
  }) {
    this.gate = gate;
    this.store = store;
    this.eventBus = eventBus;
  }

  async recover(): Promise<RecoveryResult> {
    const snapshots = await this.store.loadAllPendingSnapshots();
    const now = Date.now();

    const result: RecoveryResult = {
      recovered: 0,
      expired: 0,
      failed: 0,
      details: [],
    };

    for (const snapshot of snapshots) {
      try {
        const { interaction } = snapshot;

        if (interaction.expiresAt && interaction.expiresAt <= now) {
          const action = this.mapFallbackToAction(interaction.fallbackAction);
          const response: InteractionResponse = {
            action,
            message: 'Expired during app downtime',
            modifiedPayload: null,
            respondedBy: 'timeout',
          };

          const updated: Interaction = {
            ...interaction,
            status: 'timeout',
            response,
            respondedAt: now,
          };

          await this.store.update(updated);
          await this.store.deletePendingSnapshot(interaction.id);

          result.expired++;
          result.details.push({
            interactionId: interaction.id,
            status: 'expired',
            originalCreatedAt: interaction.createdAt,
          });
        } else {
          this.gate.restorePending(interaction.id).catch(() => {});

          const timeoutMs = interaction.expiresAt
            ? interaction.expiresAt - now
            : null;

          this.eventBus.emit({
            type: 'hitl:created',
            interactionId: interaction.id,
            runId: interaction.runId,
            taskId: interaction.taskId,
            questionType: interaction.type,
            level: interaction.level,
            question: interaction.question,
            timeoutMs,
            expiresAt: interaction.expiresAt,
            priority: interaction.metadata.priority,
          });

          result.recovered++;
          result.details.push({
            interactionId: interaction.id,
            status: 'recovered',
            originalCreatedAt: interaction.createdAt,
          });
        }
      } catch {
        result.failed++;
        result.details.push({
          interactionId: snapshot.interaction.id,
          status: 'failed',
          originalCreatedAt: snapshot.interaction.createdAt,
        });
      }
    }

    return result;
  }

  private mapFallbackToAction(fallback: FallbackAction): ResponseAction {
    switch (fallback) {
      case 'fail':
        return 'reject';
      case 'auto_approve':
        return 'approve';
      case 'auto_answer':
        return 'answer';
      case 'skip':
        return 'skip';
      default:
        return 'reject';
    }
  }
}
