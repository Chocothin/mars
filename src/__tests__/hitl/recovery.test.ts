import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import { initDatabase, getDb } from '../../db/index';
import { InteractionStore } from '../../hitl/interaction-store';
import { InteractionGate } from '../../hitl/interaction-gate';
import { RecoveryManager } from '../../hitl/recovery';
import { DEFAULT_AUTONOMY_CONFIG } from '../../hitl/default-config';
import { eventBus } from '../../events/bus';
import type { Interaction, PendingInteractionSnapshot } from '../../hitl/types';

const TEST_DATA_DIR = `/tmp/mars-test-recovery-${process.pid}`;

let store: InteractionStore;
let gate: InteractionGate;

beforeAll(() => {
  process.env.MARS_DB_PATH = ':memory:';
  initDatabase();
});

beforeEach(async () => {
  const db = getDb();
  db.exec('DELETE FROM interactions');
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
  store = new InteractionStore({ db, dataDir: TEST_DATA_DIR });
  await store.initialize();
  gate = new InteractionGate({ store, config: DEFAULT_AUTONOMY_CONFIG });
});

afterEach(() => {
  gate.dispose();
  eventBus.removeAllListeners();
});

function makeInteraction(overrides: Partial<Interaction> = {}): Interaction {
  return {
    id: overrides.id ?? `int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    runId: overrides.runId ?? 'run-recovery-test',
    taskId: overrides.taskId ?? null,
    agentId: overrides.agentId ?? null,
    sessionId: overrides.sessionId ?? null,
    type: overrides.type ?? 'destructive_action',
    level: overrides.level ?? 3,
    status: overrides.status ?? 'pending',
    question: overrides.question ?? {
      title: 'Test question',
      description: 'Test description',
      payload: {},
      suggestedAction: 'approve',
      suggestedMessage: null,
      options: null,
    },
    autoDecision: overrides.autoDecision ?? null,
    response: overrides.response ?? null,
    timeoutMs: overrides.timeoutMs ?? 60000,
    fallbackAction: overrides.fallbackAction ?? 'fail',
    expiresAt: overrides.expiresAt ?? (Date.now() + 60000),
    metadata: overrides.metadata ?? {
      source: 'orchestrator',
      batchIndex: null,
      attempt: null,
      priority: 'normal',
      tags: [],
    },
    createdAt: overrides.createdAt ?? Date.now(),
    respondedAt: overrides.respondedAt ?? null,
  };
}

function makeSnapshot(interaction: Interaction): PendingInteractionSnapshot {
  return {
    interaction,
    createdAt: interaction.createdAt,
    schemaVersion: 1,
  };
}

describe('RecoveryManager', () => {
  it('returns zero counts when no pending snapshots exist', async () => {
    const manager = new RecoveryManager({ gate, store, eventBus });
    const result = await manager.recover();

    expect(result.recovered).toBe(0);
    expect(result.expired).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.details).toEqual([]);
  });

  it('recovers valid (non-expired) pending interaction', async () => {
    const interaction = makeInteraction({
      expiresAt: Date.now() + 60000,
    });

    await store.save(interaction);
    await store.savePendingSnapshot(makeSnapshot(interaction));

    const manager = new RecoveryManager({ gate, store, eventBus });
    const result = await manager.recover();

    expect(result.recovered).toBe(1);
    expect(result.expired).toBe(0);
    expect(result.details[0]?.status).toBe('recovered');
    expect(gate.hasPending(interaction.id)).toBe(true);
  });

  it('marks expired interaction as timeout', async () => {
    const interaction = makeInteraction({
      expiresAt: Date.now() - 1000,
    });

    await store.save(interaction);
    await store.savePendingSnapshot(makeSnapshot(interaction));

    const manager = new RecoveryManager({ gate, store, eventBus });
    const result = await manager.recover();

    expect(result.expired).toBe(1);
    expect(result.recovered).toBe(0);

    const fetched = await store.getById(interaction.id);
    expect(fetched?.status).toBe('timeout');
    expect(fetched?.response?.action).toBe('reject');
    expect(fetched?.response?.message).toBe('Expired during app downtime');
    expect(fetched?.response?.respondedBy).toBe('timeout');
  });

  it('maps fallback actions correctly for expired interactions', async () => {
    const interactions = [
      makeInteraction({
        id: `int-auto-approve-${Date.now()}`,
        expiresAt: Date.now() - 1000,
        fallbackAction: 'auto_approve',
      }),
      makeInteraction({
        id: `int-auto-answer-${Date.now()}`,
        expiresAt: Date.now() - 1000,
        fallbackAction: 'auto_answer',
      }),
      makeInteraction({
        id: `int-skip-${Date.now()}`,
        expiresAt: Date.now() - 1000,
        fallbackAction: 'skip',
      }),
    ];

    for (const interaction of interactions) {
      await store.save(interaction);
      await store.savePendingSnapshot(makeSnapshot(interaction));
    }

    const manager = new RecoveryManager({ gate, store, eventBus });
    await manager.recover();

    const autoApprove = await store.getById(interactions[0]!.id);
    expect(autoApprove?.response?.action).toBe('approve');

    const autoAnswer = await store.getById(interactions[1]!.id);
    expect(autoAnswer?.response?.action).toBe('answer');

    const skip = await store.getById(interactions[2]!.id);
    expect(skip?.response?.action).toBe('skip');
  });

  it('emits hitl:recovered and hitl:created events for recovered interactions', async () => {
    const events: Array<{ type: string }> = [];
    eventBus.on('hitl:recovered', (e) => events.push(e));
    eventBus.on('hitl:created', (e) => events.push(e));

    const interaction = makeInteraction({
      expiresAt: Date.now() + 60000,
    });

    await store.save(interaction);
    await store.savePendingSnapshot(makeSnapshot(interaction));

    const manager = new RecoveryManager({ gate, store, eventBus });
    await manager.recover();

    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe('hitl:recovered');
    expect(events[1]?.type).toBe('hitl:created');
  });

  it('does not emit events for expired interactions', async () => {
    const events: Array<{ type: string }> = [];
    eventBus.on('hitl:recovered', (e) => events.push(e));
    eventBus.on('hitl:created', (e) => events.push(e));

    const interaction = makeInteraction({
      expiresAt: Date.now() - 1000,
    });

    await store.save(interaction);
    await store.savePendingSnapshot(makeSnapshot(interaction));

    const manager = new RecoveryManager({ gate, store, eventBus });
    await manager.recover();

    expect(events.length).toBe(0);
  });

  it('handles mix of valid and expired interactions', async () => {
    const validInteraction1 = makeInteraction({
      id: `int-valid-1-${Date.now()}`,
      expiresAt: Date.now() + 60000,
    });
    const validInteraction2 = makeInteraction({
      id: `int-valid-2-${Date.now()}`,
      expiresAt: Date.now() + 60000,
    });
    const expiredInteraction = makeInteraction({
      id: `int-expired-${Date.now()}`,
      expiresAt: Date.now() - 1000,
    });

    for (const interaction of [validInteraction1, validInteraction2, expiredInteraction]) {
      await store.save(interaction);
      await store.savePendingSnapshot(makeSnapshot(interaction));
    }

    const manager = new RecoveryManager({ gate, store, eventBus });
    const result = await manager.recover();

    expect(result.recovered).toBe(2);
    expect(result.expired).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.details.length).toBe(3);
  });

  it('recovers snapshot without corresponding DB row', async () => {
    const interaction = makeInteraction({
      expiresAt: Date.now() + 60000,
    });

    await store.savePendingSnapshot(makeSnapshot(interaction));

    const manager = new RecoveryManager({ gate, store, eventBus });
    const result = await manager.recover();

    expect(result.recovered).toBe(1);
    expect(gate.hasPending(interaction.id)).toBe(true);
  });

  it('recover with null expiresAt treats as non-expired (infinite wait)', async () => {
    const interaction = makeInteraction({
      expiresAt: null,
      timeoutMs: null,
    });

    await store.save(interaction);
    await store.savePendingSnapshot(makeSnapshot(interaction));

    const manager = new RecoveryManager({ gate, store, eventBus });
    const result = await manager.recover();

    expect(result.recovered).toBe(1);
    expect(result.expired).toBe(0);
  });
});
