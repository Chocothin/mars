import type { Task } from '../types/task';
import type { AgentPool, AgentPoolEntry } from './agent-pool';
import type { ReactiveScheduler } from './reactive-scheduler';

// ─── TaskMatcher: ready task ↔ idle agent 타입 기반 매칭 ───

export interface MatchedPair {
  agent: AgentPoolEntry;
  task: Task;
}

export class TaskMatcher {
  private pool: AgentPool;
  private scheduler: ReactiveScheduler;

  constructor(pool: AgentPool, scheduler: ReactiveScheduler) {
    this.pool = pool;
    this.scheduler = scheduler;
  }

  match(scopeTaskIds: string[]): MatchedPair[] {
    const idleAgents = this.pool.getIdle();
    if (idleAgents.length === 0 || scopeTaskIds.length === 0) return [];

    const pairs: MatchedPair[] = [];
    const claimedTaskIds = new Set<string>();

    for (const agent of idleAgents) {
      const task = this.scheduler.findReadyForAgent(agent.agentType, agent.agentId, scopeTaskIds);
      if (!task) continue;
      if (claimedTaskIds.has(task.id)) continue;

      claimedTaskIds.add(task.id);
      pairs.push({ agent, task });
    }

    return pairs;
  }

  hasWork(agentType: string, agentId: string, scopeTaskIds: string[]): boolean {
    return this.scheduler.findReadyForAgent(agentType, agentId, scopeTaskIds) !== null;
  }
}
