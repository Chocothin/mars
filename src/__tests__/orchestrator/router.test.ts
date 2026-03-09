import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { initDatabase, getDb } from '../../db/index';
import { AgentRouter } from '../../orchestrator/router';
import { eventBus } from '../../events/bus';
import type { IAgentService } from '../../types/agent';
import type { Agent, AgentQuery, CreateAgentInput, UpdateAgentInput } from '../../types/agent';

beforeAll(() => {
  process.env.MARS_DB_PATH = ':memory:';
  initDatabase();
});

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM tasks');
  db.exec('DELETE FROM task_dependencies');
  db.exec('DELETE FROM projects');
});

afterEach(() => {
  eventBus.removeAllListeners();
});

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = Date.now();
  return {
    id: overrides.id ?? `agent-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name ?? 'Test Agent',
    description: overrides.description ?? 'A test agent',
    providerId: overrides.providerId ?? 'provider-1',
    modelId: overrides.modelId ?? 'model-1',
    systemPrompt: overrides.systemPrompt ?? '',
    reasoningLevel: overrides.reasoningLevel ?? 'medium',
    workerCount: overrides.workerCount ?? 1,
    mcpServerIds: overrides.mcpServerIds ?? [],
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function createMockAgentService(agents: Agent[]): IAgentService {
  const map = new Map(agents.map((a) => [a.id, a]));
  return {
    async create(_input: CreateAgentInput): Promise<Agent> { throw new Error('not implemented'); },
    async getById(id: string): Promise<Agent | null> { return map.get(id) ?? null; },
    async update(_id: string, _input: UpdateAgentInput): Promise<Agent | null> { return null; },
    async delete(_id: string): Promise<boolean> { return false; },
    async list(_query: AgentQuery): Promise<Agent[]> { return agents; },
  };
}

function insertTaskForRouter(taskId: string, projectId: string, assignedAgentType: string | null = null) {
  const db = getDb();
  db.exec(`INSERT OR IGNORE INTO projects (id, name, description, instructions, directory_path, provider_id, status, agent_ids, mcp_server_ids, created_at, updated_at)
           VALUES ('${projectId}', 'p', '', '', '/tmp/${projectId}', '', 'active', '[]', '[]', ${Date.now()}, ${Date.now()})`);

  db.exec(`INSERT INTO tasks (id, project_id, title, description, status, priority, "order", assigned_agent_type, assigned_agent_id, created_at, updated_at)
           VALUES ('${taskId}', '${projectId}', 'Task ${taskId}', 'desc', 'ready', 'medium', 0, ${assignedAgentType ? `'${assignedAgentType}'` : 'NULL'}, NULL, ${Date.now()}, ${Date.now()})`);
}

describe('AgentRouter', () => {
  describe('rankAgents', () => {
    it('returns scores for all agents sorted descending', async () => {
      const agents = [
        makeAgent({ id: 'a1', name: 'Frontend Dev', description: 'React specialist', enabled: true }),
        makeAgent({ id: 'a2', name: 'Backend Dev', description: 'API specialist', enabled: true }),
      ];
      const router = new AgentRouter({ agentService: createMockAgentService(agents) });

      insertTaskForRouter('t1', 'proj1', 'frontend');

      const scores = await router.rankAgents('t1', ['a1', 'a2']);

      expect(scores).toHaveLength(2);
      expect(scores[0]!.score).toBeGreaterThanOrEqual(scores[1]!.score);
    });

    it('returns empty array for non-existent task', async () => {
      const agents = [makeAgent({ id: 'a1' })];
      const router = new AgentRouter({ agentService: createMockAgentService(agents) });

      const scores = await router.rankAgents('nonexistent', ['a1']);
      expect(scores).toHaveLength(0);
    });

    it('returns empty array for non-existent agents', async () => {
      const router = new AgentRouter({ agentService: createMockAgentService([]) });
      insertTaskForRouter('t1', 'proj1');

      const scores = await router.rankAgents('t1', ['ghost']);
      expect(scores).toHaveLength(0);
    });
  });

  describe('scoring formula', () => {
    it('gives enabled agent with type match score = 1.0', async () => {
      const agents = [
        makeAgent({ id: 'a1', name: 'coding', description: 'coding agent', enabled: true }),
      ];
      const router = new AgentRouter({ agentService: createMockAgentService(agents) });
      insertTaskForRouter('t1', 'proj1', 'coding');

      const scores = await router.rankAgents('t1', ['a1']);

      expect(scores).toHaveLength(1);
      expect(scores[0]!.score).toBeCloseTo(1.0, 10);
    });

    it('gives disabled agent with type match score = 0.8', async () => {
      const agents = [
        makeAgent({ id: 'a1', name: 'coding', description: 'coding agent', enabled: false }),
      ];
      const router = new AgentRouter({ agentService: createMockAgentService(agents) });
      insertTaskForRouter('t1', 'proj1', 'coding');

      const scores = await router.rankAgents('t1', ['a1']);

      expect(scores).toHaveLength(1);
      expect(scores[0]!.score).toBeCloseTo(0.8, 10);
    });

    it('gives enabled agent with no type match score = 0.7 + 0.2 + 0.1 = 1.0 (null assignedAgentType)', async () => {
      const agents = [
        makeAgent({ id: 'a1', enabled: true }),
      ];
      const router = new AgentRouter({ agentService: createMockAgentService(agents) });
      insertTaskForRouter('t1', 'proj1', null);

      const scores = await router.rankAgents('t1', ['a1']);
      expect(scores[0]!.score).toBeCloseTo(1.0, 10);
    });
  });

  describe('selectBest', () => {
    it('returns the highest scoring agent id', async () => {
      const agents = [
        makeAgent({ id: 'a1', name: 'Frontend Dev', description: 'React specialist', enabled: true }),
        makeAgent({ id: 'a2', name: 'Backend Dev', description: 'API specialist', enabled: false }),
      ];
      const router = new AgentRouter({ agentService: createMockAgentService(agents) });
      insertTaskForRouter('t1', 'proj1', 'frontend');

      const best = await router.selectBest('t1', ['a1', 'a2']);
      expect(best).toBe('a1');
    });

    it('returns null when no agents available', async () => {
      const router = new AgentRouter({ agentService: createMockAgentService([]) });
      insertTaskForRouter('t1', 'proj1');

      const best = await router.selectBest('t1', ['ghost']);
      expect(best).toBeNull();
    });
  });

  describe('assignBatch', () => {
    it('assigns each task to the best available unique agent', async () => {
      const agents = [
        makeAgent({ id: 'a1', name: 'frontend', description: 'frontend dev', enabled: true }),
        makeAgent({ id: 'a2', name: 'backend', description: 'backend dev', enabled: true }),
      ];
      const router = new AgentRouter({ agentService: createMockAgentService(agents) });

      insertTaskForRouter('t1', 'proj1', 'frontend');
      insertTaskForRouter('t2', 'proj1', 'backend');

      const assignments = await router.assignBatch(['t1', 't2'], ['a1', 'a2']);

      expect(assignments.size).toBe(2);
      expect(assignments.get('t1')).toBe('a1');
      expect(assignments.get('t2')).toBe('a2');
    });

    it('assigns same agent to multiple tasks when not enough agents', async () => {
      const agents = [
        makeAgent({ id: 'a1', name: 'generalist', description: 'general agent', enabled: true }),
      ];
      const router = new AgentRouter({ agentService: createMockAgentService(agents) });

      insertTaskForRouter('t1', 'proj1');
      insertTaskForRouter('t2', 'proj1');

      const assignments = await router.assignBatch(['t1', 't2'], ['a1']);

      expect(assignments.size).toBe(2);
      expect(assignments.get('t1')).toBe('a1');
      expect(assignments.get('t2')).toBe('a1');
    });

    it('returns empty map for empty input', async () => {
      const router = new AgentRouter({ agentService: createMockAgentService([]) });
      const assignments = await router.assignBatch([], []);
      expect(assignments.size).toBe(0);
    });
  });
});
