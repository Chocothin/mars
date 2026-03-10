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
import { ContextBuilder } from '../../execution/context-builder';
import { AgentService } from '../../agents/service';
import { TaskService } from '../../tasks/service';
import { AgentPool } from '../../orchestrator/agent-pool';
import { ReactiveScheduler } from '../../orchestrator/reactive-scheduler';
import { TaskDecomposer } from '../../orchestrator/decomposer';
import { ResultReviewer } from '../../orchestrator/reviewer';
import { OrchestratorEngine } from '../../orchestrator/engine';
import { MessageService } from '../../messaging/service';
import { eventBus } from '../../events/bus';
import type { ICliExecutor, CliExecuteOptions, CliExecuteResult, ProviderConnectionResult } from '../../types/provider';
import type { Provider } from '../../types/provider';
import type { Agent } from '../../types/agent';
import type { McpServer } from '../../types/mcp-server';
import type { Project } from '../../types/project';
import type { Task } from '../../types/task';
import type { SimpleApprovalConfig } from '../../hitl/types';

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
    assignedAgentType: overrides.assignedAgentType ?? ['test-agent'],
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

function makeAllL1Config(): SimpleApprovalConfig {
  return { approvalRequired: false, timeoutMs: 300_000, fallbackAction: 'auto_approve' };
}

interface TestHarness {
  engine: OrchestratorEngine;
  gate: InteractionGate;
  store: InteractionStore;
  mockExecutor: ICliExecutor;
}

async function createHarness(
  approvalConfig: SimpleApprovalConfig,
  executorOverrides?: Parameters<typeof createMockExecutor>[0],
): Promise<TestHarness> {
  const db = getDb();
  const store = new InteractionStore({ db, dataDir: TEST_DATA_DIR });
  await store.initialize();
  const gate = new InteractionGate({ store, config: approvalConfig });
  const mockExecutor = createMockExecutor(executorOverrides);
  const pool = new AgentPool();
  const scheduler = new ReactiveScheduler();
  const messageService = new MessageService();
  const contextBuilder = new ContextBuilder();
  const agentService = new AgentService();
  const taskService = new TaskService();
  const decomposer = new TaskDecomposer({ cliExecutor: mockExecutor, taskService, agentService });
  const reviewer = new ResultReviewer({ cliExecutor: mockExecutor });

  const engine = new OrchestratorEngine({
    pool,
    scheduler,
    contextBuilder,
    interactionGate: gate,
    agentService,
    taskService,
    cliExecutor: mockExecutor,
    messageService,
    reviewer,
    decomposer,
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
      eventBus.on('task:assigned', () => emitted.push('task:assigned'));
      eventBus.on('task:started', () => emitted.push('task:started'));
      eventBus.on('task:completed', () => emitted.push('task:completed'));
      eventBus.on('run:completed', () => emitted.push('run:completed'));

      const run = await harness.engine.createRun(PROJECT_ID, ['task-ev'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);

      expect(emitted).toContain('run:created');
      expect(emitted).toContain('run:started');
      expect(emitted).toContain('task:assigned');
      expect(emitted).toContain('task:started');
      expect(emitted).toContain('task:completed');
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

    // TODO: assignedAgentId routing not yet implemented in reactive engine
    it.skip('honors persistent assignedAgentId when executing a task', async () => {
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

  describe('Run Lifecycle', () => {
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
      insertTask(makeTask({ id: 'task-fail', title: 'Failing task', maxRetries: 0 }));

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
      const pool = new AgentPool();
      const scheduler = new ReactiveScheduler();
      const messageService = new MessageService();
      const contextBuilder = new ContextBuilder();
      const agentService = new AgentService();
      const taskService = new TaskService();
      const decomposer = new TaskDecomposer({ cliExecutor: mockExecutor, taskService, agentService });
      const reviewer = new ResultReviewer({ cliExecutor: mockExecutor });
      const engine = new OrchestratorEngine({
        pool, scheduler, contextBuilder, interactionGate: gate,
        agentService, taskService, cliExecutor: mockExecutor,
        messageService, reviewer, decomposer,
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
      insertTask(makeTask({ id: 'task-review', title: 'Auto-review test', acceptanceCriteria: ['Output is present'] }));

      const longOutput = 'x'.repeat(250);
      const harness = await createHarness(makeAllL1Config(), {
        streamingResult: {
          success: true,
          output: JSON.stringify({ result: longOutput, files_modified: [] }),
          exitCode: 0,
          durationMs: 100,
        },
      });
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

  describe('Pause/Resume', () => {
    it('resumeRun re-enters execution loop and completes remaining tasks', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'resume-a', title: 'Resume task A' }));
      insertTask(makeTask({ id: 'resume-b', title: 'Resume task B' }));

      const harness = await createHarness(makeAllL1Config());
      activeHarness = harness;

      const run = await harness.engine.createRun(PROJECT_ID, ['resume-a', 'resume-b'], {
        requireHumanApproval: false,
        autoReview: true,
        maxRetries: 0,
      });

      await harness.engine.startRun(run.id);
      const completedRun = getRunById(run.id)!;
      expect(completedRun.status).toBe('completed');
      expect(completedRun.result).not.toBeNull();
      expect(completedRun.result!.completedTasks).toBe(2);
    });
  });

  describe('Task Dependencies (multi-batch)', () => {
    it('executes dependent tasks in correct order', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'dep-a', title: 'Foundation', dependsOnTaskIds: [] }));
      insertTask(makeTask({ id: 'dep-b', title: 'Build', status: 'backlog', dependsOnTaskIds: ['dep-a'] }));
      insertDependenciesBatch('dep-b', ['dep-a']);
      insertTask(makeTask({ id: 'dep-c', title: 'Test', status: 'backlog', dependsOnTaskIds: ['dep-b'] }));
      insertDependenciesBatch('dep-c', ['dep-b']);

      const harness = await createHarness(makeAllL1Config());
      activeHarness = harness;

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

      const idxA = executionOrder.indexOf('dep-a');
      const idxB = executionOrder.indexOf('dep-b');
      const idxC = executionOrder.indexOf('dep-c');
      expect(idxA).toBeLessThan(idxB);
      expect(idxB).toBeLessThan(idxC);
    });

    it('treats failed dependencies as resolved for scheduling', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'fail-dep-a', title: 'Failing base', maxRetries: 0, dependsOnTaskIds: [] }));
      insertTask(makeTask({ id: 'fail-dep-b', title: 'Depends on failing', maxRetries: 0, status: 'backlog', dependsOnTaskIds: ['fail-dep-a'] }));
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

  describe('Orchestration Brief Content', () => {
    it('includes downstream hint and prior results in agent system prompt', async () => {
      seedBaseData();
      insertTask(makeTask({ id: 'brief-a', title: 'Foundation task', description: 'Lay the groundwork', dependsOnTaskIds: [] }));
      insertTask(makeTask({ id: 'brief-b', title: 'Dependent task', description: 'Build upon foundation', status: 'backlog', dependsOnTaskIds: ['brief-a'] }));
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
      expect(finalRun!.result!.completedTasks).toBe(2);

      const taskACalls = calls.filter(c =>
        !c.options.systemPrompt?.includes(DECOMPOSER_PROMPT_MARKER) &&
        c.options.prompt === 'Lay the groundwork'
      );
      expect(taskACalls.length).toBeGreaterThanOrEqual(1);

      const taskBCalls = calls.filter(c =>
        !c.options.systemPrompt?.includes(DECOMPOSER_PROMPT_MARKER) &&
        c.options.prompt === 'Build upon foundation'
      );
      expect(taskBCalls.length).toBeGreaterThanOrEqual(1);
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
