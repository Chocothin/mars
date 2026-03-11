import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDatabase, getDb } from '../../db/index';
import { insertProvider } from '../../db/provider-repo';
import { insertAgent } from '../../db/agent-repo';
import { insertProject } from '../../db/project-repo';
import { insertTask, insertDependenciesBatch } from '../../db/task-repo';
import { insertRun } from '../../db/run-repo';
import { eventBus } from '../../events/bus';
import { OrchestratorListener } from '../../orchestrator/orchestrator-listener';
import { ReactiveScheduler } from '../../orchestrator/reactive-scheduler';
import type { OrchestratorRegistry } from '../../orchestrator/orchestrator-registry';
import type { Provider } from '../../types/provider';
import type { Agent } from '../../types/agent';
import type { Project } from '../../types/project';
import type { Task } from '../../types/task';
import type { Run } from '../../orchestrator/types';

const PROVIDER_ID = 'test-provider-listener';
const AGENT_ID = 'test-agent-listener';
const ORCHESTRATOR_AGENT_ID = 'test-orchestrator-listener';
const PROJECT_ID = 'test-project-listener';

const ALL_TABLES = [
  'messages',
  'task_executions',
  'runs',
  'task_dependencies',
  'tasks',
  'agents',
  'projects',
  'providers',
];

function makeProvider(): Provider {
  return {
    id: PROVIDER_ID, name: 'Test Provider', description: '',
    providerType: 'anthropic', authMethod: 'api_key', apiKey: 'test-key',
    baseUrl: null, enabled: true, isDefault: true, config: {},
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

function makeAgent(id: string, name: string): Agent {
  return {
    id, name, description: '',
    providerId: PROVIDER_ID, modelId: 'claude-sonnet-4-20250514',
    systemPrompt: 'You are a test agent.', reasoningLevel: 'none',
    workerCount: 1, mcpServerIds: [], enabled: true,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

function makeProject(): Project {
  return {
    id: PROJECT_ID, name: 'Listener Test Project', description: '',
    instructions: '', directoryPath: '/tmp/mars-test-listener',
    status: 'active', agentIds: [AGENT_ID, ORCHESTRATOR_AGENT_ID],
    mcpServerIds: [], providerId: PROVIDER_ID,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    projectId: PROJECT_ID, parentTaskId: null,
    description: '', status: 'ready', priority: 'medium', order: 0,
    assignedAgentType: ['test-agent-listener'], assignedAgentId: null,
    dependsOnTaskIds: [], acceptanceCriteria: [], expectedOutputs: [],
    maxRetries: 1, retryCount: 0, reviewFeedback: null,
    createdAt: Date.now(), updatedAt: Date.now(),
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> & { id: string; rootTaskIds: string[] }): Run {
  return {
    projectId: PROJECT_ID, status: 'running',
    config: { maxConcurrency: 3, maxRetries: 1, timeoutMs: 3600000, taskTimeoutMs: 900000, autoReview: false, requireHumanApproval: false, hitl: null },
    executionPlan: null, result: null,
    startedAt: Date.now(), completedAt: null, createdAt: Date.now(),
    ...overrides,
  };
}

interface MockSession {
  sendCalls: Array<{ prompt: string }>;
  resetCalls: number;
  send: (prompt: string) => Promise<string>;
  resetSession: () => void;
  getState: () => string;
}

function createMockRegistry(): OrchestratorRegistry & { mockSession: MockSession } {
  const mockSession: MockSession = {
    sendCalls: [],
    resetCalls: 0,
    send: async (prompt: string) => {
      mockSession.sendCalls.push({ prompt });
      return 'NO_ACTION — test response';
    },
    resetSession: () => { mockSession.resetCalls++; },
    getState: () => 'idle',
  };

  const registry = {
    getOrCreate: async (_projectId: string) => mockSession as any,
    get: (_projectId: string) => mockSession as any,
    terminate: (_projectId: string) => {},
    terminateAll: () => {},
    listActive: () => [],
    mockSession,
  };

  return registry as any;
}

function seedData() {
  insertProvider(makeProvider());
  insertAgent(makeAgent(AGENT_ID, 'Test Agent'));
  insertAgent(makeAgent(ORCHESTRATOR_AGENT_ID, 'Test Orchestrator'));
  insertProject(makeProject());
}

function cleanDb() {
  const db = getDb();
  for (const table of ALL_TABLES) {
    try { db.exec(`DELETE FROM ${table}`); } catch {}
  }
}

describe('OrchestratorListener', () => {
  let listener: OrchestratorListener;
  let mockRegistry: ReturnType<typeof createMockRegistry>;
  let scheduler: ReactiveScheduler;

  beforeEach(() => {
    process.env.MARS_DB_PATH = ':memory:';
    initDatabase();
    seedData();

    mockRegistry = createMockRegistry();
    scheduler = new ReactiveScheduler();
    listener = new OrchestratorListener(mockRegistry, scheduler);
  });

  afterEach(() => {
    listener.dispose();
    cleanDb();
    eventBus.removeAllListeners();
  });

  it('should wake orchestrator on run:stalled event', async () => {
    const taskA = makeTask({ id: 'task-a', title: 'Task A', status: 'failed', retryCount: 1 });
    const taskB = makeTask({ id: 'task-b', title: 'Task B', status: 'blocked' });
    insertTask(taskA);
    insertTask(taskB);
    insertDependenciesBatch('task-b', ['task-a']);

    const run = makeRun({ id: 'run-stall-1', rootTaskIds: ['task-a', 'task-b'] });
    insertRun(run);

    eventBus.emit({
      type: 'run:stalled',
      runId: 'run-stall-1',
      reason: '1 task(s) failed permanently, blocking 1 downstream task(s)',
      stalledTaskIds: ['task-b'],
    });

    await new Promise(r => setTimeout(r, 6000));

    expect(mockRegistry.mockSession.resetCalls).toBeGreaterThanOrEqual(1);
    expect(mockRegistry.mockSession.sendCalls.length).toBeGreaterThanOrEqual(1);

    const prompt = mockRegistry.mockSession.sendCalls[0]!.prompt;
    expect(prompt).toContain('Events');
    expect(prompt).toContain('Run Stalled');
    expect(prompt).toContain('Run State');
    expect(prompt).toContain('Failed Tasks');
    expect(prompt).toContain('Task A');
    expect(prompt).toContain('Blocked Tasks');
    expect(prompt).toContain('Task B');
    expect(prompt).toContain('Your Decision');
  }, 10000);

  it('should wake orchestrator on message:sent to orchestrator', async () => {
    const taskA = makeTask({ id: 'task-msg-a', title: 'Task Msg A', status: 'in_progress' });
    insertTask(taskA);

    const run = makeRun({ id: 'run-msg-1', rootTaskIds: ['task-msg-a'] });
    insertRun(run);

    const db = getDb();
    db.prepare(`
      INSERT INTO messages (id, run_id, from_agent_id, to_agent_id, type, payload, read, created_at)
      VALUES ($id, $runId, $from, $to, $type, $payload, 0, $now)
    `).run({
      $id: 'msg-escalation-1',
      $runId: 'run-msg-1',
      $from: AGENT_ID,
      $to: 'orchestrator',
      $type: 'escalation',
      $payload: JSON.stringify({ summary: 'Cannot access API endpoint', details: 'Connection refused on port 8080' }),
      $now: Date.now(),
    });

    eventBus.emit({
      type: 'message:sent',
      messageId: 'msg-escalation-1',
      from: AGENT_ID,
      to: 'orchestrator',
      msgType: 'escalation',
    });

    await new Promise(r => setTimeout(r, 6000));

    expect(mockRegistry.mockSession.sendCalls.length).toBeGreaterThanOrEqual(1);
    const prompt = mockRegistry.mockSession.sendCalls[0]!.prompt;
    expect(prompt).toContain('escalation');
    expect(prompt).toContain('Cannot access API endpoint');
  }, 10000);

  it('should NOT wake on message:sent to non-orchestrator', async () => {
    eventBus.emit({
      type: 'message:sent',
      messageId: 'msg-other-1',
      from: AGENT_ID,
      to: 'some-other-agent',
      msgType: 'dm',
    });

    await new Promise(r => setTimeout(r, 6000));

    expect(mockRegistry.mockSession.sendCalls.length).toBe(0);
  }, 8000);

  it('should debounce multiple events into single invocation', async () => {
    const taskA = makeTask({ id: 'task-debounce-a', title: 'Debounce A', status: 'failed', retryCount: 1 });
    const taskB = makeTask({ id: 'task-debounce-b', title: 'Debounce B', status: 'blocked' });
    insertTask(taskA);
    insertTask(taskB);
    insertDependenciesBatch('task-debounce-b', ['task-debounce-a']);

    const run = makeRun({ id: 'run-debounce-1', rootTaskIds: ['task-debounce-a', 'task-debounce-b'] });
    insertRun(run);

    eventBus.emit({
      type: 'run:stalled',
      runId: 'run-debounce-1',
      reason: 'First stall event',
      stalledTaskIds: ['task-debounce-b'],
    });

    await new Promise(r => setTimeout(r, 100));

    eventBus.emit({
      type: 'run:stalled',
      runId: 'run-debounce-1',
      reason: 'Second stall event',
      stalledTaskIds: ['task-debounce-b'],
    });

    await new Promise(r => setTimeout(r, 6000));

    expect(mockRegistry.mockSession.sendCalls.length).toBe(1);

    const prompt = mockRegistry.mockSession.sendCalls[0]!.prompt;
    expect(prompt).toContain('Events (2)');
  }, 10000);

  it('should wake on run:completed', async () => {
    const taskA = makeTask({ id: 'task-complete-a', title: 'Complete A', status: 'done' });
    insertTask(taskA);

    const run = makeRun({ id: 'run-complete-1', rootTaskIds: ['task-complete-a'], status: 'completed' });
    insertRun(run);

    eventBus.emit({
      type: 'run:completed',
      runId: 'run-complete-1',
      result: { totalTasks: 1, completedTasks: 1, failedTasks: 0, skippedTasks: 0, totalDurationMs: 1000, taskResults: [] },
    });

    await new Promise(r => setTimeout(r, 6000));

    expect(mockRegistry.mockSession.sendCalls.length).toBeGreaterThanOrEqual(1);
    const prompt = mockRegistry.mockSession.sendCalls[0]!.prompt;
    expect(prompt).toContain('Run completed');
  }, 10000);

  it('should wake on run:failed', async () => {
    const taskA = makeTask({ id: 'task-fail-a', title: 'Fail A', status: 'failed' });
    insertTask(taskA);

    const run = makeRun({ id: 'run-fail-1', rootTaskIds: ['task-fail-a'], status: 'failed' });
    insertRun(run);

    eventBus.emit({
      type: 'run:failed',
      runId: 'run-fail-1',
      error: 'All tasks failed',
    });

    await new Promise(r => setTimeout(r, 6000));

    expect(mockRegistry.mockSession.sendCalls.length).toBeGreaterThanOrEqual(1);
    const prompt = mockRegistry.mockSession.sendCalls[0]!.prompt;
    expect(prompt).toContain('Run failed');
  }, 10000);

  it('should respect cooldown between invocations', async () => {
    const taskA = makeTask({ id: 'task-cool-a', title: 'Cool A', status: 'failed', retryCount: 1 });
    insertTask(taskA);

    const run = makeRun({ id: 'run-cool-1', rootTaskIds: ['task-cool-a'] });
    insertRun(run);

    eventBus.emit({
      type: 'run:stalled',
      runId: 'run-cool-1',
      reason: 'First',
      stalledTaskIds: [],
    });

    await new Promise(r => setTimeout(r, 6000));
    expect(mockRegistry.mockSession.sendCalls.length).toBe(1);

    eventBus.emit({
      type: 'run:stalled',
      runId: 'run-cool-1',
      reason: 'Second within cooldown',
      stalledTaskIds: [],
    });

    await new Promise(r => setTimeout(r, 6000));
    expect(mockRegistry.mockSession.sendCalls.length).toBe(1);

    await new Promise(r => setTimeout(r, 10000));
    expect(mockRegistry.mockSession.sendCalls.length).toBe(2);
  }, 30000);
});
