import { eventBus } from '../events/bus';
import type { Agent } from '../types/agent';

// ─── Agent Type Enum ───

export const AGENT_TYPES = [
  'orchestrator', 'decomposer', 'reviewer',
  'backend', 'frontend', 'designer',
  'qa', 'devops', 'data', 'security',
] as const;

export type AgentType = typeof AGENT_TYPES[number];

const agentTypeSet: ReadonlySet<string> = new Set(AGENT_TYPES);

export function isValidAgentType(value: string): value is AgentType {
  return agentTypeSet.has(value);
}

/**
 * Normalize a free-text agent type string to a valid AgentType enum value.
 * Handles LLM output variations:
 *   "Backend Developer" → "backend"
 *   "agent-backend"     → "backend"
 *   "QA Engineer"       → "qa"
 *   "backend"           → "backend" (already valid)
 * Returns null if no match found.
 */
export function normalizeAgentType(raw: string): AgentType | null {
  const lower = raw.toLowerCase().trim();

  if (isValidAgentType(lower)) return lower;

  const stripped = lower.replace(/^agent-/, '');
  if (isValidAgentType(stripped)) return stripped;

  for (const t of AGENT_TYPES) {
    if (lower.includes(t)) return t;
  }

  return null;
}

export function getAgentType(agent: { id: string; name: string }): string {
  const fromId = normalizeAgentType(agent.id);
  if (fromId) return fromId;

  const fromName = normalizeAgentType(agent.name);
  if (fromName) return fromName;

  return agent.id.replace(/^agent-/, '').replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** @deprecated Use normalizeAgentType() instead. Kept for backward compatibility during migration. */
export function resolveAgentType(agentName: string): string {
  return normalizeAgentType(agentName) ?? agentName.replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ─── AgentPool: 스레드 풀 패턴의 에이전트 관리 ───

export type PoolAgentStatus = 'idle' | 'working' | 'spawning' | 'terminated';

export interface AgentPoolEntry {
  agentId: string;
  agentName: string;
  agentType: string;
  status: PoolAgentStatus;
  currentTaskId: string | null;
  sessionId: string | null;
  runId: string | null;
  lastActivityAt: number;
  spawnedAt: number | null;
}

export interface AssignResult {
  success: boolean;
  reason?: string;
}

export class AgentPool {
  private entries = new Map<string, AgentPoolEntry>();
  private runId: string | null = null;

  // ─── Registration ───

  register(agent: Agent, runId: string): AgentPoolEntry {
    this.runId = runId;

    const existing = this.entries.get(agent.id);
    if (existing) return existing;

    const entry: AgentPoolEntry = {
      agentId: agent.id,
      agentName: agent.name,
      agentType: this.resolveType(agent),
      status: 'idle',
      currentTaskId: null,
      sessionId: null,
      runId,
      lastActivityAt: Date.now(),
      spawnedAt: null,
    };

    this.entries.set(agent.id, entry);

    eventBus.emit({
      type: 'agent:status_changed',
      agentId: agent.id,
      from: 'none',
      to: 'idle',
    });

    return entry;
  }

  unregister(agentId: string): boolean {
    return this.entries.delete(agentId);
  }

  // ─── Status Queries ───

  getIdle(agentType?: string): AgentPoolEntry[] {
    const result: AgentPoolEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status !== 'idle') continue;
      if (agentType && entry.agentType !== agentType) continue;
      result.push(entry);
    }
    return result;
  }

  getWorking(): AgentPoolEntry[] {
    const result: AgentPoolEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status === 'working') result.push(entry);
    }
    return result;
  }

  get(agentId: string): AgentPoolEntry | undefined {
    return this.entries.get(agentId);
  }

  getAll(): AgentPoolEntry[] {
    return Array.from(this.entries.values());
  }

  getAvailableTypes(): string[] {
    const types = new Set<string>();
    for (const entry of this.entries.values()) {
      types.add(entry.agentType);
    }
    return Array.from(types);
  }

  get size(): number {
    return this.entries.size;
  }

  // ─── State Transitions ───

  assign(agentId: string, taskId: string): AssignResult {
    const entry = this.entries.get(agentId);
    if (!entry) return { success: false, reason: 'agent not found in pool' };
    if (entry.status !== 'idle') return { success: false, reason: `agent is ${entry.status}, not idle` };

    const prev = entry.status;
    entry.status = 'working';
    entry.currentTaskId = taskId;
    entry.lastActivityAt = Date.now();

    eventBus.emit({
      type: 'agent:status_changed',
      agentId,
      from: prev,
      to: 'working',
    });

    return { success: true };
  }

  release(agentId: string): AssignResult {
    const entry = this.entries.get(agentId);
    if (!entry) return { success: false, reason: 'agent not found in pool' };

    const prev = entry.status;
    entry.status = 'idle';
    entry.currentTaskId = null;
    entry.lastActivityAt = Date.now();

    if (this.runId) {
      eventBus.emit({
        type: 'agent:idle',
        agentId,
        runId: this.runId,
      });
    }

    eventBus.emit({
      type: 'agent:status_changed',
      agentId,
      from: prev,
      to: 'idle',
    });

    return { success: true };
  }

  markSpawning(agentId: string): AssignResult {
    const entry = this.entries.get(agentId);
    if (!entry) return { success: false, reason: 'agent not found in pool' };

    const prev = entry.status;
    entry.status = 'spawning';
    entry.lastActivityAt = Date.now();
    entry.spawnedAt = Date.now();

    eventBus.emit({
      type: 'agent:status_changed',
      agentId,
      from: prev,
      to: 'spawning',
    });

    return { success: true };
  }

  setSessionId(agentId: string, sessionId: string): void {
    const entry = this.entries.get(agentId);
    if (entry) {
      entry.sessionId = sessionId;
      entry.lastActivityAt = Date.now();
    }
  }

  touch(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (entry) {
      entry.lastActivityAt = Date.now();
    }
  }

  // ─── Cleanup ───

  async shutdown(): Promise<void> {
    for (const entry of this.entries.values()) {
      entry.status = 'terminated';
      entry.currentTaskId = null;
    }
    this.entries.clear();
    this.runId = null;
  }

  findStale(maxIdleMs: number): AgentPoolEntry[] {
    const cutoff = Date.now() - maxIdleMs;
    const stale: AgentPoolEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.lastActivityAt < cutoff && entry.status === 'working') {
        stale.push(entry);
      }
    }
    return stale;
  }

  // ─── Internal ───

  private resolveType(agent: Agent): string {
    return getAgentType(agent);
  }
}
