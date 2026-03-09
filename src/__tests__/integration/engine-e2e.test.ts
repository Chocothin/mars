import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import { initDatabase, getDb } from '../../db/index';
import { insertProvider } from '../../db/provider-repo';
import { insertAgent } from '../../db/agent-repo';
import { insertMcpServer } from '../../db/mcp-server-repo';
import { insertProject } from '../../db/project-repo';
import { insertTask, insertDependenciesBatch } from '../../db/task-repo';
import { getRunById, updateRun } from '../../db/run-repo';
import { getTaskExecutionsByRunId } from '../../db/task-exec-repo';
import { InteractionStore } from '../../hitl/interaction-store';
import { InteractionGate } from '../../hitl/interaction-gate';
import { getAutonomousConfig, getStrictConfig } from '../../hitl/default-config';
import { SessionManager } from '../../execution/session-manager';
import { ContextBuilder } from '../../execution/context-builder';
import { AgentRunner } from '../../execution/agent-runner';
import { AgentService } from '../../agents/service';
import { TaskService } from '../../tasks/service';
import { TaskScheduler } from '../../orchestrator/scheduler';
import { AgentRouter } from '../../orchestrator/router';
import { TaskDecomposer } from '../../orchestrator/decomposer';
import { ResultReviewer } from '../../orchestrator/reviewer';
import { OrchestratorEngine } from '../../orchestrator/engine';
import { eventBus } from '../../events/bus';
import type { ICliExecutor, CliExecuteOptions, CliExecuteResult, ProviderConnectionResult } from '../../types/provider';
import type { Provider } from '../../types/provider';
import type { Agent } from '../../types/agent';
import type { McpServer } from '../../types/mcp-server';
import type { Project } from '../../types/project';
import type { Task } from '../../types/task';
import type { AutonomyConfig, AutonomyRule, QuestionType } from '../../hitl/types';

const TEST_DATA_DIR = `/tmp/mars-test-engine-e2e-${process.pid}`;
const PROVIDER_ID = 'test-provider';
const AGENT_ID = 'test-agent';
const PROJECT_ID = 'test-project';

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: overrides.id ?? PROVIDER_ID,
    name: overrides.name ?? 'Test Provider',
    description: overrides.description ?? 'E2E test provider',
    providerType: overrides.providerType ?? 'anthropic',
    authMethod: overrides.authMethod ?? 'api_key',
    apiKey: overrides.apiKey ?? 'test-key',
    baseUrl: overrides.baseUrl ?? null,
    enabled: overrides.enabled ?? true,
    isDefault: overrides.isDefault ?? true,
    config: overrides.config ?? {},
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: overrides.id ?? AGENT_ID,
    name: overrides.name ?? 'Test Agent',
    description: overrides.description ?? 'E2E test agent for coding tasks',
    providerId: overrides.providerId ?? PROVIDER_ID,
    modelId: overrides.modelId ?? 'claude-sonnet-4-20250514',
    systemPrompt: overrides.systemPrompt ?? 'You are a test agent.',
    reasoningLevel: overrides.reasoningLevel ?? 'none',
    workerCount: overrides.workerCount ?? 1,
    mcpServerIds: overrides.mcpServerIds ?? [],
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? PROJECT_ID,
    name: overrides.name ?? 'Test Project',
    description: overrides.description ?? 'E2E test project',
    instructions: overrides.instructions ?? '',
    directoryPath: overrides.directoryPath ?? '/tmp/mars-test-project',
    status: overrides.status ?? 'active',
    agentIds: overrides.agentIds ?? [AGENT_ID],
    mcpServerIds: overrides.mcpServerIds ?? [],
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

function makeMcpServer(overrides: Partial<McpServer> & { id: string; name: string }): McpServer {
  return {
    id: overrides.id,
    name: overrides.name,
    description: overrides.description ?? '',
    transportType: overrides.transportType ?? 'stdio',
    command: overrides.command ?? 'node',
    args: overrides.args ?? ['server.js'],
    url: overrides.url ?? null,
    headers: overrides.headers ?? {},
    env: overrides.env ?? {},
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    projectId: overrides.projectId ?? PROJECT_ID,
    parentTaskId: overrides.parentTaskId ?? null,
    title: overrides.title ?? 'Test Task',
    description: overrides.description ?? 'A test task',
    status: overrides.status ?? 'ready',
    priority: overrides.priority ?? 'medium',
    order: overrides.order ?? 0,
    assignedAgentType: overrides.assignedAgentType ?? null,
    assignedAgentId: overrides.assignedAgentId ?? null,
    dependsOnTaskIds: overrides.dependsOnTaskIds ?? [],
    acceptanceCriteria: overrides.acceptanceCriteria ?? [],
    expectedOutputs: overrides.expectedOutputs ?? [],
    maxRetries: overrides.maxRetries ?? 2,
    retryCount: overrides.retryCount ?? 0,
    reviewFeedback: overrides.reviewFeedback ?? null,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
    ...overrides,
  };
}

const DECOMPOSER_PROMPT_MARKER = 'task decomposition specialist';

function createMockExecutor(overrides?: {
  streamingResult?: Partial<CliExecuteResult>;
  decomposerResult?: Partial<CliExecuteResult>;
  executeResult?: Partial<CliExecuteResult>;
  onStreamingCall?: (providerId: string, options: CliExecuteOptions) => void;
}): ICliExecutor {
  const defaultResult: CliExecuteResult = {
    success: true,
    output: JSON.stringify({ result: 'done', files_modified: [] }),
    exitCode: 0,
    durationMs: 100,
  };

  const defaultDecomposerResult: CliExecuteResult = {
    success: true,
    output: JSON.stringify({ result: '[]', files_modified: [] }),
    exitCode: 0,
    durationMs: 50,
  };

  return {
    execute: async (_providerId: string, _options: CliExecuteOptions): Promise<CliExecuteResult> => {
      return { ...defaultResult, ...overrides?.executeResult };
    },
    executeStreaming: async (
      providerId: string,
      options: CliExecuteOptions,
      onChunk: (chunk: string) => void,
    ): Promise<CliExecuteResult> => {
      overrides?.onStreamingCall?.(providerId, options);
      onChunk('processing...');
      const isDecomposerCall = options.systemPrompt?.includes(DECOMPOSER_PROMPT_MARKER) ?? false;
      if (isDecomposerCall) {
        return { ...defaultDecomposerResult, ...overrides?.decomposerResult };
      }
      return { ...defaultResult, ...overrides?.streamingResult };
    },
    checkHealth: async (_providerId: string): Promise<ProviderConnectionResult> => {
      return { success: true, latencyMs: 10, authStatus: { loggedIn: true, authMethod: 'api_key' } };
    },
    getAuthStatus: async (): Promise<ProviderConnectionResult['authStatus']> => {
      return { loggedIn: true, authMethod: 'api_key' };
    },
  };
}

function makeAllL1Config(): AutonomyConfig {
  const config = getAutonomousConfig();
  const allL1Rules = Object.fromEntries(
    Object.keys(config.byQuestionType).map((key) => [
      key,
      { level: 1 as const, timeoutMs: null, fallbackAction: 'auto_approve' as const },
    ]),
  ) as Record<QuestionType, AutonomyRule>;
  return { global: 1, byQuestionType: allL1Rules, byRun: null, byTask: null };
}

interface TestHarness {
  engine: OrchestratorEngine;
  gate: InteractionGate;
  store: InteractionStore;
  mockExecutor: ICliExecutor;
}

async function createHarness(
  autonomyConfig: AutonomyConfig,
  executorOverrides?: Parameters<typeof createMockExecutor>[0],
): Promise<TestHarness> {
  const db = getDb();
  const store = new InteractionStore({ db, dataDir: TEST_DATA_DIR });
  await store.initialize();
  const gate = new InteractionGate({ store, config: autonomyConfig });
  const mockExecutor = createMockExecutor(executorOverrides);
  const sessionManager = new SessionManager();
  const contextBuilder = new ContextBuilder();
  const agentRunner = new AgentRunner(sessionManager, mockExecutor);
  const agentService = new AgentService();
  const taskService = new TaskService();
  const scheduler = new TaskScheduler();
  const router = new AgentRouter({ agentService });
  const decomposer = new TaskDecomposer({ agentRunner, taskService });
  const reviewer = new ResultReviewer({ interactionGate: gate });

  const engine = new OrchestratorEngine({
    decomposer,
    scheduler,
    router,
    runner: agentRunner,
    reviewer,
    contextBuilder,
    interactionGate: gate,
    agentService,
    taskService,
  });

  return { engine, gate, store, mockExecutor };
}

function seedBaseData(): void {
  insertProvider(makeProvider());
  insertAgent(makeAgent());
  insertProject(makeProject());
}

function seedBaseDataWithMcp(): void {
  insertProvider(makeProvider());
  insertMcpServer(makeMcpServer({ id: 'shared-mcp', name: 'shared-mcp' }));
  insertAgent(makeAgent({ mcpServerIds: ['shared-mcp'] }));
  insertProject(makeProject({ mcpServerIds: ['shared-mcp'] }));
}

const ALL_TABLES = [
  'interactions',
  'task_executions',
  'runs',
  'task_dependencies',
  'tasks',
  'mcp_servers',
  'agents',
  'projects',
  'providers',
];

beforeAll(() => {
  process.env.MARS_DB_PATH = ':memory:';
  initDatabase();
});

let activeHarness: TestHarness | null = null;

beforeEach(async () => {
  const db = getDb();
  for (const table of ALL_TABLES) {
    db.exec(`DELETE FROM ${table}`);
  }
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
  if (activeHarness) {
    activeHarness.engine.dispose();
    activeHarness.gate.dispose();
    activeHarness = null;
  }
  eventBus.removeAllListeners();
});

describe('OrchestratorEngine E2E Integration', () => {
  describe('Happy Path (Full Autonomous L1)', () => {
    it('runs single task to completion with no HITL blocking', async () => {
      seedBaseData();
      const task = makeTask({ id: 'task-1', title: 'Implement feature A' });
      insertTask(task);

      const harness = await createHarness(makeAllL1Config());
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-1'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      expect(run.status).toBe('pending');

      await harness.engine.startRun(run.id);

      const finalRun = getRunById(run.id);
      expect(finalRun).not.toBeNull();
      expect(finalRun!.status).toBe('completed');
      expect(finalRun!.result).not.toBeNull();
      expect(finalRun!.result!.totalTasks).toBeGreaterThanOrEqual(1);
      expect(finalRun!.result!.completedTasks).toBeGreaterThanOrEqual(1);
      expect(finalRun!.result!.failedTasks).toBe(0);
      expect(finalRun!.completedAt).not.toBeNull();
    });

    it('emits lifecycle events throughout the run', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-ev', title: 'Event test task' }));

      const harness = await createHarness(makeAllL1Config());
      activeHarness = harness;

      const emitted: string[] = [];
      eventBus.on('run:created', () => emitted.push('run:created'));
      eventBus.on('run:started', () => emitted.push('run:started'));
      eventBus.on('batch:started', () => emitted.push('batch:started'));
      eventBus.on('task:assigned', () => emitted.push('task:assigned'));
      eventBus.on('task:started', () => emitted.push('task:started'));
      eventBus.on('task:completed', () => emitted.push('task:completed'));
      eventBus.on('batch:completed', () => emitted.push('batch:completed'));
      eventBus.on('run:completed', () => emitted.push('run:completed'));

      const run = await harness.engine.createRun(PROJECT_ID, ['task-ev'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      expect(emitted).toContain('run:created');
      expect(emitted).toContain('run:started');
      expect(emitted).toContain('batch:started');
      expect(emitted).toContain('task:assigned');
      expect(emitted).toContain('task:started');
      expect(emitted).toContain('task:completed');
      expect(emitted).toContain('batch:completed');
      expect(emitted).toContain('run:completed');
    });

    it('runs multiple independent tasks in a single batch', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-a', title: 'Task A' }));
      insertTask(makeTask({ id: 'task-b', title: 'Task B' }));
      insertTask(makeTask({ id: 'task-c', title: 'Task C' }));

      const harness = await createHarness(makeAllL1Config());
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-a', 'task-b', 'task-c'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('completed');
      expect(finalRun!.result!.completedTasks).toBe(3);
      expect(finalRun!.result!.failedTasks).toBe(0);
    });

    it('creates task execution records in the database', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-exec', title: 'Execution record test' }));

      const harness = await createHarness(makeAllL1Config());
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-exec'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      const executions = getTaskExecutionsByRunId(run.id);
      expect(executions.length).toBeGreaterThanOrEqual(1);

      const exec = executions.find((e) => e.taskId === 'task-exec');
      expect(exec).toBeDefined();
      expect(exec!.status).toBe('completed');
      expect(exec!.agentId).toBe(AGENT_ID);
      expect(exec!.output).not.toBeNull();
      expect(exec!.durationMs).not.toBeNull();
    });

    it('honors persistent assignedAgentId when executing a task', async () => {
      insertProvider(makeProvider());
      insertAgent(makeAgent({ id: AGENT_ID, name: 'Primary Agent' }));
      insertAgent(makeAgent({ id: 'test-agent-2', name: 'Secondary Agent' }));
      insertProject(makeProject({ agentIds: [AGENT_ID, 'test-agent-2'] }));
      insertTask(makeTask({ id: 'task-assigned-agent', assignedAgentId: 'test-agent-2' }));

      const harness = await createHarness(makeAllL1Config());
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-assigned-agent'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      const execution = getTaskExecutionsByRunId(run.id).find((item) => item.taskId === 'task-assigned-agent');
      expect(execution).toBeDefined();
      expect(execution?.agentId).toBe('test-agent-2');
    });
  });

  describe('HITL Blocking (L3)', () => {
    it('blocks on plan_approval and resumes after approve', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-plan', title: 'Plan approval test' }));

      const strictConfig = getStrictConfig();
      const harness = await createHarness(strictConfig);
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-plan'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      let planInteractionId: string | null = null;
      eventBus.on('hitl:created', (event) => {
        if (event.questionType === 'plan_approval') {
          planInteractionId = event.interactionId;
        }
      });

      const runPromise = harness.engine.startRun(run.id).catch(() => {});

      await waitFor(() => planInteractionId !== null, 3000);
      expect(planInteractionId).not.toBeNull();

      const midRun = getRunById(run.id);
      expect(midRun!.status).toBe('scheduling');

      await harness.gate.respond(planInteractionId!, {
        action: 'approve',
        message: 'Looks good',
        modifiedPayload: null,
        respondedBy: 'human',
      });

      await runPromise;

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('completed');
    });

    it('rejects run when plan_approval is rejected', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-reject', title: 'Plan rejection test' }));

      const strictConfig = getStrictConfig();
      const harness = await createHarness(strictConfig);
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-reject'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      let planInteractionId: string | null = null;
      eventBus.on('hitl:created', (event) => {
        if (event.questionType === 'plan_approval') {
          planInteractionId = event.interactionId;
        }
      });

      const runPromise = harness.engine.startRun(run.id).catch(() => {});

      await waitFor(() => planInteractionId !== null, 3000);

      await harness.gate.respond(planInteractionId!, {
        action: 'reject',
        message: 'Not acceptable',
        modifiedPayload: null,
        respondedBy: 'human',
      });

      await runPromise;

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('failed');
    });

    it('blocks on decomposition_approval when subtasks are proposed', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-decomp', title: 'Complex task to decompose' }));

      const subtasks = [
        { title: 'Sub 1', description: 'First subtask', requiredCapabilities: ['coding'], dependsOn: [], estimatedDurationMin: 10 },
        { title: 'Sub 2', description: 'Second subtask', requiredCapabilities: ['testing'], dependsOn: [], estimatedDurationMin: 5 },
      ];

      const strictConfig = getStrictConfig();
      const harness = await createHarness(strictConfig, {
        decomposerResult: {
          success: true,
          output: JSON.stringify(subtasks),
          exitCode: 0,
          durationMs: 50,
        },
      });
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-decomp'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      const interactionIds: Array<{ type: string; id: string }> = [];
      eventBus.on('hitl:created', (event) => {
        interactionIds.push({ type: event.questionType, id: event.interactionId });
      });

      const runPromise = harness.engine.startRun(run.id).catch(() => {});

      await waitFor(() => interactionIds.some((i) => i.type === 'decomposition_approval'), 3000);

      const decompInteraction = interactionIds.find((i) => i.type === 'decomposition_approval');
      expect(decompInteraction).toBeDefined();

      const midRun = getRunById(run.id);
      expect(midRun!.status).toBe('decomposing');

      await harness.gate.respond(decompInteraction!.id, {
        action: 'approve',
        message: 'Approved subtasks',
        modifiedPayload: null,
        respondedBy: 'human',
      });

      await waitFor(() => interactionIds.some((i) => i.type === 'plan_approval'), 3000);

      const planInteraction = interactionIds.find((i) => i.type === 'plan_approval');
      expect(planInteraction).toBeDefined();

      await harness.gate.respond(planInteraction!.id, {
        action: 'approve',
        message: 'Plan approved',
        modifiedPayload: null,
        respondedBy: 'human',
      });

      await runPromise;

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('completed');
    });

    it('blocks on assignment_approval when requireHumanApproval is true and L3', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-assign', title: 'Assignment approval test' }));

      const allL3Config = getStrictConfig();
      const harness = await createHarness(allL3Config);
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-assign'], {
        requireHumanApproval: true,
        autoReview: true,
        maxRetries: 0,
      });

      const interactionIds: Array<{ type: string; id: string }> = [];
      eventBus.on('hitl:created', (event) => {
        interactionIds.push({ type: event.questionType, id: event.interactionId });
      });

      const runPromise = harness.engine.startRun(run.id).catch(() => {});

      await waitFor(() => interactionIds.some((i) => i.type === 'plan_approval'), 3000);
      const planInteraction = interactionIds.find((i) => i.type === 'plan_approval')!;
      await harness.gate.respond(planInteraction.id, {
        action: 'approve',
        message: null,
        modifiedPayload: null,
        respondedBy: 'human',
      });

      await waitFor(() => interactionIds.some((i) => i.type === 'assignment_approval'), 3000);
      const assignInteraction = interactionIds.find((i) => i.type === 'assignment_approval');
      expect(assignInteraction).toBeDefined();

      await harness.gate.respond(assignInteraction!.id, {
        action: 'approve',
        message: null,
        modifiedPayload: null,
        respondedBy: 'human',
      });

      await runPromise;

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('completed');
    });
  });

  describe('Run Lifecycle', () => {
    it('cancels a run while waiting for HITL approval', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-cancel', title: 'Cancel test' }));

      const strictConfig = getStrictConfig();
      const harness = await createHarness(strictConfig);
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-cancel'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      let planBlocked = false;
      eventBus.on('hitl:created', (event) => {
        if (event.questionType === 'plan_approval') {
          planBlocked = true;
        }
      });

      const runPromise = harness.engine.startRun(run.id).catch(() => {});

      await waitFor(() => planBlocked, 3000);

      await harness.engine.cancelRun(run.id);

      await runPromise;

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('cancelled');
      expect(finalRun!.completedAt).not.toBeNull();
    });

    it('tracks run status transitions correctly', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-status', title: 'Status tracking test' }));

      const harness = await createHarness(makeAllL1Config());
      activeHarness = harness;

      const statusHistory: string[] = [];
      const originalGetRunById = getRunById;

      eventBus.on('run:created', () => statusHistory.push('pending'));
      eventBus.on('run:started', () => statusHistory.push('started'));
      eventBus.on('run:completed', () => statusHistory.push('completed'));

      const run = await harness.engine.createRun(PROJECT_ID, ['task-status'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      expect(statusHistory).toContain('pending');
      expect(statusHistory).toContain('started');
      expect(statusHistory).toContain('completed');
    });
  });

  describe('Failure & Retry', () => {
    it('marks run as failed when task execution fails and maxRetries exhausted', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-fail', title: 'Failing task' }));

      const harness = await createHarness(makeAllL1Config(), {
        streamingResult: {
          success: false,
          output: '',
          exitCode: 1,
          durationMs: 50,
          error: 'Command failed',
        },
      });
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-fail'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('failed');
      expect(finalRun!.result).not.toBeNull();
    });

    it('retries a failed task up to maxRetries before failing', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-retry', title: 'Retry task' }));

      let taskCallCount = 0;
      const harness = await createHarness(makeAllL1Config(), {
        streamingResult: {
          success: false,
          output: '',
          exitCode: 1,
          durationMs: 50,
          error: 'Transient error',
        },
        onStreamingCall: (_providerId: string, options: CliExecuteOptions) => {
          if (!options.systemPrompt?.includes(DECOMPOSER_PROMPT_MARKER)) taskCallCount++;
        },
      });
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-retry'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 2,
      });

      await harness.engine.startRun(run.id);

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('failed');
      expect(taskCallCount).toBeGreaterThanOrEqual(2);
    });

    it('succeeds on retry when second attempt works', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-retry-ok', title: 'Retry success task' }));

      let taskCallCount = 0;
      const mockExecutor = createMockExecutor();
      const originalStreaming = mockExecutor.executeStreaming;

      mockExecutor.executeStreaming = async (
        providerId: string,
        options: CliExecuteOptions,
        onChunk: (chunk: string) => void,
      ): Promise<CliExecuteResult> => {
        if (options.systemPrompt?.includes(DECOMPOSER_PROMPT_MARKER)) {
          return originalStreaming(providerId, options, onChunk);
        }
        taskCallCount++;
        if (taskCallCount === 1) {
          onChunk('failing...');
          return { success: false, output: '', exitCode: 1, durationMs: 50, error: 'First attempt fail' };
        }
        return originalStreaming(providerId, options, onChunk);
      };

      const db = getDb();
      const store = new InteractionStore({ db, dataDir: TEST_DATA_DIR });
      await store.initialize();
      const gate = new InteractionGate({ store, config: makeAllL1Config() });
      const sessionManager = new SessionManager();
      const contextBuilder = new ContextBuilder();
      const agentRunner = new AgentRunner(sessionManager, mockExecutor);
      const agentService = new AgentService();
      const taskService = new TaskService();
      const scheduler = new TaskScheduler();
      const router = new AgentRouter({ agentService });
      const decomposer = new TaskDecomposer({ agentRunner, taskService });
      const reviewer = new ResultReviewer({ interactionGate: gate });
      const engine = new OrchestratorEngine({
        decomposer, scheduler, router, runner: agentRunner,
        reviewer, contextBuilder, interactionGate: gate,
        agentService, taskService,
      });
      activeHarness = { engine, gate, store, mockExecutor };

      const run = await engine.createRun(PROJECT_ID, ['task-retry-ok'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 2,
      });

      await engine.startRun(run.id);

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('completed');
      expect(taskCallCount).toBe(2);
    });
  });

  describe('Review', () => {
    it('auto-reviews completed tasks (passes when output present)', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-review', title: 'Auto-review test' }));

      const harness = await createHarness(makeAllL1Config());
      activeHarness = harness;

      const reviewEvents: string[] = [];
      eventBus.on('review:started', () => reviewEvents.push('review:started'));
      eventBus.on('review:passed', () => reviewEvents.push('review:passed'));

      const run = await harness.engine.createRun(PROJECT_ID, ['task-review'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      expect(reviewEvents).toContain('review:started');
      expect(reviewEvents).toContain('review:passed');

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('completed');
    });
  });

  describe('Mock Executor Interaction', () => {
    it('passes correct providerId and prompt to executor', async () => {
      seedBaseData();
      insertTask(makeTask({
        id: 'task-verify-cli',
        title: 'CLI verification',
        description: 'Verify executor receives correct params',
      }));

      const calls: Array<{ providerId: string; options: CliExecuteOptions }> = [];
      const harness = await createHarness(makeAllL1Config(), {
        onStreamingCall: (providerId, options) => {
          calls.push({ providerId, options });
        },
      });
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-verify-cli'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      const taskCall = calls.find((c) => !c.options.systemPrompt?.includes(DECOMPOSER_PROMPT_MARKER) && c.options.prompt?.includes('Verify executor'));
      expect(taskCall).toBeDefined();
      expect(taskCall!.providerId).toBe(PROVIDER_ID);
    });

    it('passes mcpConfig for orchestrator execution when resolved MCP servers exist', async () => {
      seedBaseDataWithMcp();
      insertTask(makeTask({
        id: 'task-with-mcp',
        title: 'Task with MCP',
        description: 'Verify mcpConfig is provided',
      }));

      const calls: Array<{ providerId: string; options: CliExecuteOptions }> = [];
      const harness = await createHarness(makeAllL1Config(), {
        onStreamingCall: (providerId, options) => {
          calls.push({ providerId, options });
        },
      });
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-with-mcp'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      const taskCall = calls.find((c) => !c.options.systemPrompt?.includes(DECOMPOSER_PROMPT_MARKER));
      expect(taskCall).toBeDefined();
      expect(taskCall!.options.allowedTools).toEqual(['mars-orchestrator', 'shared-mcp']);
      expect(taskCall!.options.mcpConfig).toBeDefined();
      expect(taskCall!.options.workingDirectory).toBe('/tmp/mars-test-project');
    });
  });

  describe('L2 Inform + Override', () => {
    it('auto-resolves L2 plan approval and allows later override', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-l2', title: 'L2 inform test' }));

      const l2Config = makeAllL1Config();
      l2Config.byQuestionType.plan_approval = {
        level: 2,
        timeoutMs: null,
        fallbackAction: 'auto_approve',
      };

      const harness = await createHarness(l2Config);
      activeHarness = harness;

      const informedEvents: Array<{ questionType: string; interactionId: string; autoDecision: { action: string } }> = [];
      eventBus.on('hitl:informed', (event) => {
        informedEvents.push(event as any);
      });

      const run = await harness.engine.createRun(PROJECT_ID, ['task-l2'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('completed');

      const planInformed = informedEvents.find(e => e.questionType === 'plan_approval');
      expect(planInformed).toBeDefined();
      expect(planInformed!.autoDecision.action).toBe('approve');

      const overriddenEvents: Array<{ override: { action: string } }> = [];
      eventBus.on('hitl:overridden', (event) => {
        overriddenEvents.push(event as any);
      });

      await harness.gate.override(planInformed!.interactionId, {
        action: 'reject',
        message: 'Changed my mind',
        modifiedPayload: null,
        respondedBy: 'human',
      });

      expect(overriddenEvents.length).toBe(1);
      expect(overriddenEvents[0]!.override.action).toBe('reject');
    });
  });

  describe('Pause/Resume', () => {
    it('pauseRun sets status to paused and emits run:paused event', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'pause-evt', title: 'Pause event test' }));

      const strictConfig = getStrictConfig();
      const harness = await createHarness(strictConfig);
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['pause-evt'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      let planInteractionId: string | null = null;
      eventBus.on('hitl:created', (event) => {
        if (event.questionType === 'plan_approval') {
          planInteractionId = event.interactionId;
        }
      });

      let pauseEmitted = false;
      eventBus.on('run:paused', () => { pauseEmitted = true; });

      const runPromise = harness.engine.startRun(run.id).catch(() => {});

      await waitFor(() => planInteractionId !== null, 3000);

      await harness.engine.pauseRun(run.id);

      const pausedRun = getRunById(run.id)!;
      expect(pausedRun.status).toBe('paused');
      expect(pauseEmitted).toBe(true);

      await harness.engine.cancelRun(run.id);
      await runPromise;
    });

    it('resumeRun re-enters execution loop from saved execution plan', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'resume-a', title: 'Resume task A' }));
      insertTask(makeTask({ id: 'resume-b', title: 'Resume task B' }));

      const harness = await createHarness(makeAllL1Config());
      activeHarness = harness;

      const refRun = await harness.engine.createRun(PROJECT_ID, ['resume-a', 'resume-b'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });
      await harness.engine.startRun(refRun.id);
      const completedRef = getRunById(refRun.id)!;
      expect(completedRef.executionPlan).not.toBeNull();

      const pausedRun = await harness.engine.createRun(PROJECT_ID, ['resume-a', 'resume-b'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });
      updateRun(pausedRun.id, {
        status: 'paused',
        executionPlan: completedRef.executionPlan,
        startedAt: Date.now(),
      });

      await harness.engine.resumeRun(pausedRun.id);

      const finalRun = getRunById(pausedRun.id)!;
      expect(finalRun.status).toBe('completed');
      expect(finalRun.result).not.toBeNull();
      expect(finalRun.result!.completedTasks).toBe(2);
    });
  });

  describe('Task Dependencies (multi-batch)', () => {
    it('executes dependent tasks in correct batch order', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'dep-a', title: 'Foundation', dependsOnTaskIds: [] }));
      insertTask(makeTask({ id: 'dep-b', title: 'Build', dependsOnTaskIds: ['dep-a'] }));
      insertDependenciesBatch('dep-b', ['dep-a']);
      insertTask(makeTask({ id: 'dep-c', title: 'Test', dependsOnTaskIds: ['dep-b'] }));
      insertDependenciesBatch('dep-c', ['dep-b']);

      const harness = await createHarness(makeAllL1Config());
      activeHarness = harness;

      const batchStarts: Array<{ batchIndex: number; taskIds: string[] }> = [];
      eventBus.on('batch:started', (event) => {
        batchStarts.push({ batchIndex: event.batchIndex, taskIds: event.taskIds });
      });

      const executionOrder: string[] = [];
      eventBus.on('task:completed', (event) => {
        executionOrder.push(event.taskId);
      });

      const run = await harness.engine.createRun(PROJECT_ID, ['dep-a', 'dep-b', 'dep-c'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('completed');
      expect(finalRun!.result!.completedTasks).toBe(3);

      expect(batchStarts.length).toBe(3);
      expect(batchStarts[0]!.taskIds).toContain('dep-a');
      expect(batchStarts[1]!.taskIds).toContain('dep-b');
      expect(batchStarts[2]!.taskIds).toContain('dep-c');

      const idxA = executionOrder.indexOf('dep-a');
      const idxB = executionOrder.indexOf('dep-b');
      const idxC = executionOrder.indexOf('dep-c');
      expect(idxA).toBeLessThan(idxB);
      expect(idxB).toBeLessThan(idxC);
    });

    it('treats failed dependencies as resolved for scheduling', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'fail-dep-a', title: 'Failing base', dependsOnTaskIds: [] }));
      insertTask(makeTask({ id: 'fail-dep-b', title: 'Depends on failing', dependsOnTaskIds: ['fail-dep-a'] }));
      insertDependenciesBatch('fail-dep-b', ['fail-dep-a']);

      let taskCallCount = 0;
      const harness = await createHarness(makeAllL1Config(), {
        streamingResult: {
          success: false,
          output: '',
          exitCode: 1,
          durationMs: 50,
          error: 'Fail',
        },
        onStreamingCall: (_pid: string, opts: CliExecuteOptions) => {
          if (!opts.systemPrompt?.includes(DECOMPOSER_PROMPT_MARKER)) taskCallCount++;
        },
      });
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['fail-dep-a', 'fail-dep-b'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('failed');
      expect(taskCallCount).toBe(2);
    });
  });

  describe('HITL Timeout + Fallback', () => {
    it('applies auto_approve fallback after timeout expires', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-timeout', title: 'Timeout approve test' }));

      const timeoutConfig = getStrictConfig();
      timeoutConfig.byQuestionType.plan_approval = {
        level: 3,
        timeoutMs: 200,
        fallbackAction: 'auto_approve',
      };

      const harness = await createHarness(timeoutConfig);
      activeHarness = harness;

      const timeoutEvents: Array<{ fallbackAction: string }> = [];
      eventBus.on('hitl:timeout', (event) => {
        timeoutEvents.push(event as any);
      });

      const run = await harness.engine.createRun(PROJECT_ID, ['task-timeout'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);
      await waitFor(() => timeoutEvents.length > 0, 1000);

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('completed');

      const planTimeout = timeoutEvents.find(e => e.fallbackAction === 'auto_approve');
      expect(planTimeout).toBeDefined();
    });

    it('fails run when timeout fallback is fail', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-timeout-fail', title: 'Timeout fail test' }));

      const timeoutConfig = getStrictConfig();
      timeoutConfig.byQuestionType.plan_approval = {
        level: 3,
        timeoutMs: 200,
        fallbackAction: 'fail',
      };

      const harness = await createHarness(timeoutConfig);
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-timeout-fail'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('failed');
    });
  });

  describe('Decomposition Modify', () => {
    it('uses modified subtasks when human responds with modify action', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-mod', title: 'Task to modify decomposition' }));

      const originalSubtasks = [
        { title: 'Original Sub 1', description: 'First', requiredCapabilities: ['coding'], dependsOn: [] as string[], estimatedDurationMin: 10 },
        { title: 'Original Sub 2', description: 'Second', requiredCapabilities: ['testing'], dependsOn: [] as string[], estimatedDurationMin: 5 },
      ];

      const modifiedSubtasks = [
        { title: 'Modified A', description: 'Better first', requiredCapabilities: ['coding'], dependsOn: [] as string[], estimatedDurationMin: 15 },
        { title: 'Modified B', description: 'Depends on A', requiredCapabilities: ['coding'], dependsOn: ['Modified A'], estimatedDurationMin: 10 },
        { title: 'Modified C', description: 'Independent third', requiredCapabilities: ['testing'], dependsOn: [] as string[], estimatedDurationMin: 5 },
      ];

      const strictConfig = getStrictConfig();
      const harness = await createHarness(strictConfig, {
        decomposerResult: {
          success: true,
          output: JSON.stringify(originalSubtasks),
          exitCode: 0,
          durationMs: 50,
        },
      });
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-mod'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      const interactionIds: Array<{ type: string; id: string }> = [];
      eventBus.on('hitl:created', (event) => {
        interactionIds.push({ type: event.questionType, id: event.interactionId });
      });

      const runPromise = harness.engine.startRun(run.id).catch(() => {});

      await waitFor(() => interactionIds.some(i => i.type === 'decomposition_approval'), 3000);
      const decompInteraction = interactionIds.find(i => i.type === 'decomposition_approval')!;

      await harness.gate.respond(decompInteraction.id, {
        action: 'modify',
        message: 'Using modified subtasks',
        modifiedPayload: { subtasks: modifiedSubtasks },
        respondedBy: 'human',
      });

      await waitFor(() => interactionIds.some(i => i.type === 'plan_approval'), 3000);
      const planInteraction = interactionIds.find(i => i.type === 'plan_approval')!;

      await harness.gate.respond(planInteraction.id, {
        action: 'approve',
        message: null,
        modifiedPayload: null,
        respondedBy: 'human',
      });

      await runPromise;

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('completed');
      expect(finalRun!.result!.totalTasks).toBe(4);
      expect(finalRun!.result!.completedTasks).toBe(4);
      expect(finalRun!.executionPlan!.batches.length).toBe(2);
    });
  });

  describe('Review Rejection Flows', () => {
    it('escalates and fails run when human review responds with cancel', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-escalate', title: 'Escalation test' }));

      const config = makeAllL1Config();
      config.byQuestionType.result_approval = {
        level: 3,
        timeoutMs: null,
        fallbackAction: 'fail',
      };

      const harness = await createHarness(config, {
        streamingResult: {
          success: false,
          output: '',
          exitCode: 1,
          durationMs: 50,
          error: 'Task failed',
        },
      });
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-escalate'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      const interactionIds: Array<{ type: string; id: string }> = [];
      eventBus.on('hitl:created', (event) => {
        interactionIds.push({ type: event.questionType, id: event.interactionId });
      });

      const failedEvents: Array<{ error: string }> = [];
      eventBus.on('run:failed', (event) => {
        failedEvents.push(event as any);
      });

      const runPromise = harness.engine.startRun(run.id).catch(() => {});

      await waitFor(() => interactionIds.some(i => i.type === 'result_approval'), 3000);
      const reviewInteraction = interactionIds.find(i => i.type === 'result_approval')!;

      await harness.gate.respond(reviewInteraction.id, {
        action: 'cancel',
        message: 'Escalate to human',
        modifiedPayload: null,
        respondedBy: 'human',
      });

      await runPromise;

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('failed');
      expect(failedEvents.length).toBeGreaterThanOrEqual(1);
      expect(failedEvents[0]!.error).toContain('escalated');
    });
  });

  describe('Per-run Autonomy Overrides', () => {
    it('overrides base strict config with per-run L1 autonomy', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'task-run-ovr', title: 'Run override test' }));

      const strictConfig = getStrictConfig();
      const harness = await createHarness(strictConfig);
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['task-run-ovr'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
        hitl: {
          autonomyOverrides: {
            plan_approval: { level: 1, timeoutMs: null, fallbackAction: 'auto_approve' },
          },
          taskAutonomyOverrides: null,
        },
      });

      await harness.engine.startRun(run.id);

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('completed');
    });
  });

  describe('Orchestration Brief Content', () => {
    it('includes downstream hint and prior results in agent system prompt', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'brief-a', title: 'Foundation task', description: 'Lay the groundwork', dependsOnTaskIds: [] }));
      insertTask(makeTask({ id: 'brief-b', title: 'Dependent task', description: 'Build upon foundation', dependsOnTaskIds: ['brief-a'] }));
      insertDependenciesBatch('brief-b', ['brief-a']);

      const calls: Array<{ options: CliExecuteOptions }> = [];
      const harness = await createHarness(makeAllL1Config(), {
        onStreamingCall: (_pid: string, options: CliExecuteOptions) => {
          calls.push({ options });
        },
        streamingResult: {
          success: true,
          output: JSON.stringify({ result: 'foundation output data', files_modified: ['base.ts'] }),
          exitCode: 0,
          durationMs: 100,
        },
      });
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['brief-a', 'brief-b'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      const finalRun = getRunById(run.id);
      expect(finalRun!.status).toBe('completed');
      expect(finalRun!.executionPlan!.batches.length).toBe(2);

      const taskACalls = calls.filter(c =>
        !c.options.systemPrompt?.includes(DECOMPOSER_PROMPT_MARKER) &&
        c.options.prompt === 'Lay the groundwork'
      );
      expect(taskACalls.length).toBeGreaterThanOrEqual(1);
      const taskAPrompt = taskACalls[0]!.options.systemPrompt ?? '';
      expect(taskAPrompt).toContain('Downstream');
      expect(taskAPrompt).toContain('Dependent task');
      expect(taskAPrompt).toContain('Batch 1 of 2');

      const taskBCalls = calls.filter(c =>
        !c.options.systemPrompt?.includes(DECOMPOSER_PROMPT_MARKER) &&
        c.options.prompt === 'Build upon foundation'
      );
      expect(taskBCalls.length).toBeGreaterThanOrEqual(1);
      const taskBPrompt = taskBCalls[0]!.options.systemPrompt ?? '';
      expect(taskBPrompt).toContain('Prior Task Results');
      expect(taskBPrompt).toContain('Foundation task');
      expect(taskBPrompt).toContain('foundation output data');
      expect(taskBPrompt).toContain('Batch 2 of 2');
    });
  });
});

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  pollMs = 50,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
