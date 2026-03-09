import { getDb } from '../db/index';
import { eventBus } from '../events/bus';

export type HeartbeatStatus = 'idle' | 'working' | 'offline';

export interface IHeartbeatManager {
  ping(agentId: string, runId: string, status?: HeartbeatStatus, currentTaskId?: string | null): void;
  isAlive(agentId: string, runId: string, timeoutMs?: number): boolean;
  getIdleAgents(runId: string): string[];
  getTimedOutAgents(runId: string, timeoutMs: number): string[];
  startMonitoring(runId: string, intervalMs?: number): void;
  stopMonitoring(runId: string): void;
  dispose(): void;
}

export class HeartbeatManager implements IHeartbeatManager {
  private monitors: Map<string, Timer> = new Map();
  private defaultTimeoutMs = 30000;

  ping(agentId: string, runId: string, status: HeartbeatStatus = 'idle', currentTaskId: string | null = null): void {
    const db = getDb();
    const now = Date.now();

    db.prepare(`
      INSERT INTO agent_heartbeats (agent_id, run_id, status, current_task_id, last_seen, started_at)
      VALUES ($agentId, $runId, $status, $currentTaskId, $now, $now)
      ON CONFLICT (agent_id, run_id) DO UPDATE SET
        status = $status,
        current_task_id = $currentTaskId,
        last_seen = $now
    `).run({
      $agentId: agentId,
      $runId: runId,
      $status: status,
      $currentTaskId: currentTaskId,
      $now: now,
    });

    eventBus.emit({ type: 'agent:heartbeat', agentId, runId, timestamp: now });
  }

  isAlive(agentId: string, runId: string, timeoutMs: number = this.defaultTimeoutMs): boolean {
    const db = getDb();
    const threshold = Date.now() - timeoutMs;
    const row = db.prepare(
      'SELECT last_seen FROM agent_heartbeats WHERE agent_id = $agentId AND run_id = $runId'
    ).get({ $agentId: agentId, $runId: runId }) as { last_seen: number } | null;

    if (!row) return false;
    return row.last_seen >= threshold;
  }

  getIdleAgents(runId: string): string[] {
    const db = getDb();
    const rows = db.prepare(
      "SELECT agent_id FROM agent_heartbeats WHERE run_id = $runId AND status = 'idle'"
    ).all({ $runId: runId }) as Array<{ agent_id: string }>;
    return rows.map(r => r.agent_id);
  }

  getTimedOutAgents(runId: string, timeoutMs: number): string[] {
    const db = getDb();
    const threshold = Date.now() - timeoutMs;
    const rows = db.prepare(
      "SELECT agent_id FROM agent_heartbeats WHERE run_id = $runId AND last_seen < $threshold AND status IN ('working', 'offline')"
    ).all({ $runId: runId, $threshold: threshold }) as Array<{ agent_id: string }>;
    return rows.map(r => r.agent_id);
  }

  startMonitoring(runId: string, intervalMs: number = 5000): void {
    if (this.monitors.has(runId)) return;

    const timer = setInterval(() => {
      this.checkTimedOut(runId);
    }, intervalMs);

    this.monitors.set(runId, timer);
  }

  stopMonitoring(runId: string): void {
    const timer = this.monitors.get(runId);
    if (timer) {
      clearInterval(timer);
      this.monitors.delete(runId);
    }
  }

  dispose(): void {
    for (const [runId, timer] of this.monitors.entries()) {
      clearInterval(timer);
      this.monitors.delete(runId);
    }
  }

  private checkTimedOut(runId: string): void {
    const timedOut = this.getTimedOutAgents(runId, this.defaultTimeoutMs);

    for (const agentId of timedOut) {
      const db = getDb();

      const row = db.prepare(
        'SELECT last_seen FROM agent_heartbeats WHERE agent_id = $agentId AND run_id = $runId'
      ).get({ $agentId: agentId, $runId: runId }) as { last_seen: number } | null;

      db.prepare(
        "UPDATE agent_heartbeats SET status = 'offline' WHERE agent_id = $agentId AND run_id = $runId"
      ).run({ $agentId: agentId, $runId: runId });

      eventBus.emit({
        type: 'agent:timeout',
        agentId,
        runId,
        lastSeen: row?.last_seen ?? 0,
      });
    }
  }
}
