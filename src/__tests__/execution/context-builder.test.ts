import { beforeAll, beforeEach, describe, it, expect } from 'bun:test';
import { ContextBuilder } from '../../execution/context-builder';
import { initDatabase, getDb } from '../../db/index';
import { insertAgent } from '../../db/agent-repo';
import { insertMcpServer } from '../../db/mcp-server-repo';
import { insertProject } from '../../db/project-repo';
import type { Agent } from '../../types/agent';
import type { McpServer } from '../../types/mcp-server';
import type { Project } from '../../types/project';
import type { Task } from '../../types/task';
import type { IMemoryStorage } from '../../types/memory';
import type { TaskExecutionOutput, OrchestrationBrief } from '../../orchestrator/types';
import type { MemoryFile, MemoryQuery, MemoryTier, CreateMemoryFileInput, UpdateMemoryFileInput } from '../../types/memory';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = Date.now();
  return {
    id: overrides.id ?? 'agent-1',
    name: overrides.name ?? 'Test Agent',
    description: overrides.description ?? 'desc',
    providerId: overrides.providerId ?? 'provider-1',
    modelId: overrides.modelId ?? 'model-1',
    systemPrompt: overrides.systemPrompt ?? 'You are a helpful assistant.',
    reasoningLevel: overrides.reasoningLevel ?? 'medium',
    workerCount: overrides.workerCount ?? 1,
    mcpServerIds: overrides.mcpServerIds ?? [],
    skillIds: overrides.skillIds ?? [],
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  const now = Date.now();
  return {
    id: overrides.id ?? 'proj-1',
    name: overrides.name ?? 'Test Project',
    description: overrides.description ?? '',
    instructions: overrides.instructions ?? '',
    directoryPath: overrides.directoryPath ?? '/proj',
    providerId: overrides.providerId,
    status: overrides.status ?? 'active',
    agentIds: overrides.agentIds ?? ['agent-1'],
    mcpServerIds: overrides.mcpServerIds ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function makeMcpServer(overrides: Partial<McpServer> & { id: string; name: string }): McpServer {
  const now = Date.now();
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
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: overrides.id ?? 'task-1',
    projectId: overrides.projectId ?? 'proj-1',
    parentTaskId: overrides.parentTaskId ?? null,
    title: overrides.title ?? 'Implement feature X',
    description: overrides.description ?? 'Detailed description',
    status: overrides.status ?? 'ready',
    priority: overrides.priority ?? 'medium',
    order: overrides.order ?? 0,
    assignedAgentType: overrides.assignedAgentType ?? [],
    assignedAgentId: overrides.assignedAgentId ?? null,
    dependsOnTaskIds: overrides.dependsOnTaskIds ?? [],
    acceptanceCriteria: overrides.acceptanceCriteria ?? [],
    expectedOutputs: overrides.expectedOutputs ?? [],
    maxRetries: overrides.maxRetries ?? 2,
    retryCount: overrides.retryCount ?? 0,
    reviewFeedback: overrides.reviewFeedback ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function makePriorResult(overrides: Partial<TaskExecutionOutput> = {}): TaskExecutionOutput {
  return {
    result: overrides.result ?? 'Prior result text',
    filesModified: overrides.filesModified ?? ['src/foo.ts'],
    tokensUsed: overrides.tokensUsed ?? 50,
    costUsd: overrides.costUsd ?? 0.005,
  };
}

function makeBrief(overrides: Partial<OrchestrationBrief> = {}): OrchestrationBrief {
  return {
    runGoal: overrides.runGoal ?? 'Build feature set',
    taskObjective: overrides.taskObjective ?? 'Implement X',
    priorResults: overrides.priorResults ?? [],
    positionInPlan: overrides.positionInPlan ?? 'Batch 1 of 3',
    downstreamHint: overrides.downstreamHint ?? null,
  };
}

function createMockMemoryStorage(files: MemoryFile[]): IMemoryStorage {
  return {
    async createFile(_input: CreateMemoryFileInput): Promise<MemoryFile> { throw new Error('not implemented'); },
    async readFile(_id: string): Promise<MemoryFile | null> { return null; },
    async updateFile(_id: string, _input: UpdateMemoryFileInput): Promise<MemoryFile | null> { return null; },
    async deleteFile(_id: string): Promise<boolean> { return false; },
    async listFiles(_query: MemoryQuery): Promise<MemoryFile[]> { return files; },
    getFilePath(_tier: MemoryTier, _scope: string, _filename: string): string { return ''; },
    async ensureDirectoryExists(_tier: MemoryTier, _scope: string): Promise<void> {},
  };
}

describe('ContextBuilder', () => {
  beforeAll(() => {
    process.env.MARS_DB_PATH = ':memory:';
    initDatabase();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM mcp_servers');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM projects');
  });

  describe('build', () => {
    it('returns AgentContext with assembled system prompt', async () => {
      const builder = new ContextBuilder();
      const agent = makeAgent();
      const task = makeTask();

      const ctx = await builder.build({
        agent,
        task,
        projectDirectory: '/proj',
      });

      expect(ctx.agent).toBe(agent);
      expect(ctx.task).toBe(task);
      expect(ctx.workingDirectory).toBe('/proj');
      expect(ctx.systemPrompt).toContain('You are a helpful assistant.');
      expect(ctx.systemPrompt).toContain('Implement feature X');
      expect(ctx.orchestrationBrief).toBeNull();
    });

    it('includes prior results in system prompt when no brief', async () => {
      const builder = new ContextBuilder();
      const priors = [makePriorResult({ result: 'Step 1 output' })];

      const ctx = await builder.build({
        agent: makeAgent(),
        task: makeTask(),
        priorResults: priors,
        projectDirectory: '/proj',
      });

      expect(ctx.systemPrompt).toContain('Prior Task Results');
      expect(ctx.systemPrompt).toContain('Step 1 output');
      expect(ctx.priorResults).toEqual(['Step 1 output']);
    });

    it('uses brief instead of priorResults when brief is provided', async () => {
      const builder = new ContextBuilder();
      const brief = makeBrief({ runGoal: 'Ship v2' });
      const priors = [makePriorResult({ result: 'Should not appear' })];

      const ctx = await builder.build({
        agent: makeAgent(),
        task: makeTask(),
        priorResults: priors,
        projectDirectory: '/proj',
        orchestrationBrief: brief,
      });

      expect(ctx.systemPrompt).toContain('Ship v2');
      expect(ctx.systemPrompt).not.toContain('Should not appear');
      expect(ctx.orchestrationBrief).toBe(brief);
    });

    it('loads memory from IMemoryStorage', async () => {
      const memFile: MemoryFile = {
        id: 'mem-1',
        tier: 'agent',
        scope: 'agent-1',
        filename: 'knowledge.md',
        relativePath: 'agent/agent-1/knowledge.md',
        isProtected: false,
        content: 'Important knowledge',
        fileType: 'markdown',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const storage = createMockMemoryStorage([memFile]);
      const builder = new ContextBuilder(storage);

      const ctx = await builder.build({
        agent: makeAgent({ id: 'agent-1' }),
        task: makeTask(),
        projectDirectory: '/proj',
      });

      expect(ctx.memory).toContain('Agent Memory');
      expect(ctx.memory).toContain('knowledge.md');
      expect(ctx.memory).toContain('Important knowledge');
    });

    it('returns empty memory when no storage provided', async () => {
      const builder = new ContextBuilder();

      const ctx = await builder.build({
        agent: makeAgent(),
        task: makeTask(),
        projectDirectory: '/proj',
      });

      expect(ctx.memory).toBe('');
    });

    it('returns empty memory when storage returns no files', async () => {
      const storage = createMockMemoryStorage([]);
      const builder = new ContextBuilder(storage);

      const ctx = await builder.build({
        agent: makeAgent(),
        task: makeTask(),
        projectDirectory: '/proj',
      });

      expect(ctx.memory).toBe('');
    });

    it('returns empty tools when agent has no mcpServerIds', async () => {
      insertProject(makeProject({ mcpServerIds: [] }));
      insertAgent(makeAgent({ mcpServerIds: [] }));

      const builder = new ContextBuilder();

      const ctx = await builder.build({
        agent: makeAgent({ mcpServerIds: [] }),
        task: makeTask(),
        projectId: 'proj-1',
        projectDirectory: '/proj',
      });

      expect(ctx.mcpServerIds).toEqual(['builtin:mars-orchestrator']);
      expect(ctx.mcpServers.map((server) => server.id)).toEqual(['builtin:mars-orchestrator']);
      expect(ctx.tools).toEqual([
        { name: 'mars-orchestrator', source: 'mcp', mcpServerId: 'builtin:mars-orchestrator', enabled: true },
      ]);
      expect(ctx.mcpServers[0]?.env.MARS_PROJECT_ID).toBe('proj-1');
    });

    it('resolves project-aware MCP tools and server records', async () => {
      insertMcpServer(makeMcpServer({ id: 'project-mcp', name: 'project-mcp' }));
      insertMcpServer(makeMcpServer({ id: 'agent-mcp', name: 'agent-mcp' }));
      insertMcpServer(makeMcpServer({ id: 'override-mcp', name: 'override-mcp' }));
      insertMcpServer(makeMcpServer({ id: 'disabled-mcp', name: 'disabled-mcp', enabled: false }));
      insertProject(makeProject({ mcpServerIds: ['project-mcp', 'disabled-mcp'] }));
      insertAgent(makeAgent({ id: 'agent-1', mcpServerIds: ['agent-mcp', 'project-mcp'] }));

      const builder = new ContextBuilder();
      const ctx = await builder.build({
        agent: makeAgent({ id: 'agent-1', mcpServerIds: ['agent-mcp', 'project-mcp'] }),
        task: makeTask(),
        projectId: 'proj-1',
        overrideMcpServerIds: ['override-mcp', 'missing-mcp'],
        projectDirectory: '/proj',
      });

      expect(ctx.mcpServerIds).toEqual(['builtin:mars-orchestrator', 'project-mcp', 'agent-mcp', 'override-mcp']);
      expect(ctx.mcpServers.map((server) => server.id)).toEqual(['builtin:mars-orchestrator', 'project-mcp', 'agent-mcp', 'override-mcp']);
      expect(ctx.tools).toEqual([
        { name: 'mars-orchestrator', source: 'mcp', mcpServerId: 'builtin:mars-orchestrator', enabled: true },
        { name: 'project-mcp', source: 'mcp', mcpServerId: 'project-mcp', enabled: true },
        { name: 'agent-mcp', source: 'mcp', mcpServerId: 'agent-mcp', enabled: true },
        { name: 'override-mcp', source: 'mcp', mcpServerId: 'override-mcp', enabled: true },
      ]);
      expect(ctx.mcpServers[0]?.env.MARS_PROJECT_ID).toBe('proj-1');
    });
  });

  describe('system prompt assembly order', () => {
    it('places agent systemPrompt before brief before task section', async () => {
      const builder = new ContextBuilder();
      const brief = makeBrief({ runGoal: 'BRIEF_MARKER' });

      const ctx = await builder.build({
        agent: makeAgent({ systemPrompt: 'AGENT_PROMPT_MARKER' }),
        task: makeTask({ title: 'TASK_TITLE_MARKER' }),
        projectDirectory: '/proj',
        orchestrationBrief: brief,
      });

      const promptIdx = ctx.systemPrompt.indexOf('AGENT_PROMPT_MARKER');
      const briefIdx = ctx.systemPrompt.indexOf('BRIEF_MARKER');
      const taskIdx = ctx.systemPrompt.indexOf('TASK_TITLE_MARKER');

      expect(promptIdx).toBeLessThan(briefIdx);
      expect(briefIdx).toBeLessThan(taskIdx);
    });

    it('places agent systemPrompt before priorResults before task section (no brief)', async () => {
      const builder = new ContextBuilder();
      const priors = [makePriorResult({ result: 'PRIOR_MARKER' })];

      const ctx = await builder.build({
        agent: makeAgent({ systemPrompt: 'AGENT_PROMPT_MARKER' }),
        task: makeTask({ title: 'TASK_TITLE_MARKER' }),
        priorResults: priors,
        projectDirectory: '/proj',
      });

      const promptIdx = ctx.systemPrompt.indexOf('AGENT_PROMPT_MARKER');
      const priorIdx = ctx.systemPrompt.indexOf('PRIOR_MARKER');
      const taskIdx = ctx.systemPrompt.indexOf('TASK_TITLE_MARKER');

      expect(promptIdx).toBeLessThan(priorIdx);
      expect(priorIdx).toBeLessThan(taskIdx);
    });
  });

  describe('formatOrchestrationBrief', () => {
    it('includes downstreamHint when present', async () => {
      const builder = new ContextBuilder();
      const brief = makeBrief({ downstreamHint: 'Testing depends on this' });

      const ctx = await builder.build({
        agent: makeAgent(),
        task: makeTask(),
        projectDirectory: '/proj',
        orchestrationBrief: brief,
      });

      expect(ctx.systemPrompt).toContain('Downstream:');
      expect(ctx.systemPrompt).toContain('Testing depends on this');
    });

    it('omits downstreamHint when null', async () => {
      const builder = new ContextBuilder();
      const brief = makeBrief({ downstreamHint: null });

      const ctx = await builder.build({
        agent: makeAgent(),
        task: makeTask(),
        projectDirectory: '/proj',
        orchestrationBrief: brief,
      });

      expect(ctx.systemPrompt).not.toContain('Downstream:');
    });

    it('includes prior results in brief format', async () => {
      const builder = new ContextBuilder();
      const brief = makeBrief({
        priorResults: [
          {
            taskId: 't0',
            taskTitle: 'Setup DB',
            result: 'DB schema created',
            filesModified: ['schema.sql', 'migrations/001.ts'],
          },
        ],
      });

      const ctx = await builder.build({
        agent: makeAgent(),
        task: makeTask(),
        projectDirectory: '/proj',
        orchestrationBrief: brief,
      });

      expect(ctx.systemPrompt).toContain('Prior Task Results');
      expect(ctx.systemPrompt).toContain('Setup DB');
      expect(ctx.systemPrompt).toContain('DB schema created');
      expect(ctx.systemPrompt).toContain('schema.sql');
    });
  });

  describe('formatTaskSection', () => {
    it('includes task title and priority', async () => {
      const builder = new ContextBuilder();

      const ctx = await builder.build({
        agent: makeAgent({ systemPrompt: '' }),
        task: makeTask({ title: 'My Task', priority: 'high' }),
        projectDirectory: '/proj',
      });

      expect(ctx.systemPrompt).toContain('## Task: My Task');
      expect(ctx.systemPrompt).toContain('Priority: high');
    });

    it('includes task description when present', async () => {
      const builder = new ContextBuilder();

      const ctx = await builder.build({
        agent: makeAgent({ systemPrompt: '' }),
        task: makeTask({ description: 'Do something special' }),
        projectDirectory: '/proj',
      });

      expect(ctx.systemPrompt).toContain('Do something special');
    });
  });
});
