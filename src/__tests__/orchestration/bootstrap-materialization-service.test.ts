import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, initDatabase } from '../../db/index';
import { insertAgent } from '../../db/agent-repo';
import { insertProvider } from '../../db/provider-repo';
import { queryRuns } from '../../db/run-repo';
import { getTaskByIdGlobal, queryTasksGlobal } from '../../db/task-repo';
import { OrchestrationBootstrapService } from '../../orchestration/bootstrap-service';
import { BootstrapMaterializationService } from '../../orchestration/bootstrap-materialization-service';
import type { IInstructionAnalyzer, InstructionAnalysisInput, InstructionAnalysisResult } from '../../orchestration/types';
import { ProjectService } from '../../projects/service';
import type { Agent } from '../../types/agent';
import type { Provider } from '../../types/provider';

const now = Date.now();
const tempDirs: string[] = [];

function createTempProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mars-bootstrap-materialize-'));
  tempDirs.push(dir);
  return dir;
}

function makeProvider(): Provider {
  return {
    id: 'prov-1',
    name: 'Provider',
    description: '',
    providerType: 'anthropic',
    authMethod: 'api_key',
    apiKey: 'test-key',
    baseUrl: null,
    enabled: true,
    isDefault: true,
    config: {},
    createdAt: now,
    updatedAt: now,
  };
}

function makeAgent(id: string, name: string): Agent {
  return {
    id,
    name,
    description: '',
    providerId: 'prov-1',
    modelId: 'claude-sonnet-4.6',
    systemPrompt: '',
    reasoningLevel: 'none',
    workerCount: 2,
    mcpServerIds: [],
    skillIds: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

class MaterializationAnalyzer implements IInstructionAnalyzer {
  async analyze(input: InstructionAnalysisInput): Promise<InstructionAnalysisResult> {
    return {
      analysisMode: 'fallback',
      summary: `Prepared bootstrap proposal for ${input.project.name}`,
      risks: [],
      questions: [],
      notes: [],
      recommendedAgentAssignments: [
        { taskId: 'root-1', agentId: input.selectedAgent.id, reason: 'owner' },
        { taskId: 'root-2', agentId: 'worker-agent', reason: 'worker' },
        { taskId: 'final-test', agentId: input.selectedAgent.id, reason: 'owner' },
      ],
      suggestedRootTasks: [
        {
          id: 'root-1',
          title: 'Plan implementation',
          description: 'Break down the approved work.',
          priority: 'high',
          acceptanceCriteria: [],
          dependsOnIds: [],
          assignedAgentId: input.selectedAgent.id,
          assignedAgentReason: 'owner',
        },
        {
          id: 'root-2',
          title: 'Implement approved tasks',
          description: 'Create the main execution tasks.',
          priority: 'medium',
          acceptanceCriteria: [],
          dependsOnIds: ['root-1'],
          assignedAgentId: 'worker-agent',
          assignedAgentReason: 'worker',
        },
      ],
      dependencyEdges: [
        { fromTaskId: 'root-1', toTaskId: 'root-2', type: 'blocks', reason: 'plan first' },
        { fromTaskId: 'root-2', toTaskId: 'final-test', type: 'blocks', reason: 'verify last' },
        { fromTaskId: 'root-1', toTaskId: 'final-test', type: 'informs', reason: 'context only' },
      ],
      suggestedFinalTestTask: {
        id: 'final-test',
        title: 'Verify approved plan',
        description: 'Confirm the materialized plan without starting execution.',
        priority: 'high',
        acceptanceCriteria: [],
        dependsOnIds: ['root-2'],
        assignedAgentId: input.selectedAgent.id,
        assignedAgentReason: 'owner',
      },
    };
  }
}

describe('BootstrapMaterializationService', () => {
  beforeAll(() => {
    process.env.MARS_DB_PATH = ':memory:';
    initDatabase();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM terminal_messages');
    db.exec('DELETE FROM terminal_sessions');
    db.exec('DELETE FROM task_dependencies');
    db.exec('DELETE FROM task_executions');
    db.exec('DELETE FROM tasks');
    db.exec('DELETE FROM runs');
    db.exec('DELETE FROM projects');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM providers');

    insertProvider(makeProvider());
    insertAgent(makeAgent('orch-agent', 'Orchestrator Agent'));
    insertAgent(makeAgent('worker-agent', 'Worker Agent'));
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('materializes bootstrap proposal tasks, dependencies, and one pending run without starting it', async () => {
    const bootstrapService = new OrchestrationBootstrapService({ instructionAnalyzer: new MaterializationAnalyzer() });
    const projectService = new ProjectService({ bootstrapService });
    const materializationService = new BootstrapMaterializationService({ bootstrapService });
    const directoryPath = createTempProjectDir();

    const project = await projectService.create({
      name: 'Materialize Project',
      directoryPath,
      instructions: 'Stage tasks only.',
      agentIds: ['orch-agent', 'worker-agent'],
    });

    const result = await materializationService.materialize(project.id);

    expect(result.alreadyMaterialized).toBe(false);
    expect(result.noRunStarted).toBe(true);
    expect(result.createdTaskIds).toHaveLength(3);
    expect(result.dependencyCount).toBe(2);
    expect(result.runStatus).toBe('pending');
    expect(typeof result.runId).toBe('string');

    const createdTitles = result.createdTaskIds.map((taskId) => getTaskByIdGlobal(taskId)?.title);
    expect(createdTitles).toEqual([
      'Plan implementation',
      'Implement approved tasks',
      'Verify approved plan',
    ]);

    const createdTasks = result.createdTaskIds.map((taskId) => getTaskByIdGlobal(taskId));
    expect(createdTasks).toHaveLength(3);
    expect(createdTasks.map((task) => task?.assignedAgentId)).toEqual(['orch-agent', 'worker-agent', 'orch-agent']);
    expect(createdTasks.map((task) => task?.priority)).toEqual(['high', 'medium', 'high']);
    expect(createdTasks.map((task) => task?.status)).toEqual(['backlog', 'blocked', 'blocked']);
    expect(queryTasksGlobal({ projectId: project.id, limit: 10, offset: 0 })).toHaveLength(3);

    const dependencyRows = getDb().prepare(
      'SELECT task_id as taskId, depends_on_task_id as dependsOnTaskId FROM task_dependencies ORDER BY task_id, depends_on_task_id',
    ).all() as Array<{ taskId: string; dependsOnTaskId: string }>;
    expect(dependencyRows).toHaveLength(2);

    const manifest = JSON.parse(readFileSync(join(directoryPath, '.mars', 'orchestration', 'bootstrap.json'), 'utf8')) as {
      materialization?: {
        createdTaskIds: string[];
        dependencyCount: number;
        noRunStarted: boolean;
      };
    };
    expect(manifest.materialization).toMatchObject({
      createdTaskIds: result.createdTaskIds,
      dependencyCount: 2,
      runId: result.runId,
      runStatus: 'pending',
      noRunStarted: true,
    });

    const runs = queryRuns({ projectId: project.id, limit: 10, offset: 0 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: result.runId,
      status: 'pending',
      rootTaskIds: result.createdTaskIds,
      startedAt: null,
      completedAt: null,
      executionPlan: null,
      result: null,
    });
    expect(getDb().prepare('SELECT COUNT(*) as count FROM task_executions').get() as { count: number }).toEqual({ count: 0 });
  });

  it('fails clearly when the current bootstrap proposal was already materialized', async () => {
    const bootstrapService = new OrchestrationBootstrapService({ instructionAnalyzer: new MaterializationAnalyzer() });
    const projectService = new ProjectService({ bootstrapService });
    const materializationService = new BootstrapMaterializationService({ bootstrapService });
    const project = await projectService.create({
      name: 'Duplicate Materialization Project',
      directoryPath: createTempProjectDir(),
      instructions: 'Stage tasks only.',
      agentIds: ['orch-agent', 'worker-agent'],
    });

    await materializationService.materialize(project.id);

    await expect(materializationService.materialize(project.id)).rejects.toMatchObject({
      message: 'Bootstrap proposal already materialized for this project.',
      statusCode: 409,
    });

    expect(queryTasksGlobal({ projectId: project.id, limit: 10, offset: 0 })).toHaveLength(3);
    const runs = queryRuns({ projectId: project.id, limit: 10, offset: 0 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('pending');
  });

  it('rolls back created tasks and run if manifest persistence fails', async () => {
    const bootstrapService = new OrchestrationBootstrapService({ instructionAnalyzer: new MaterializationAnalyzer() });
    const projectService = new ProjectService({ bootstrapService });
    const materializationService = new BootstrapMaterializationService({ bootstrapService });
    const directoryPath = createTempProjectDir();

    const project = await projectService.create({
      name: 'Rollback Materialization Project',
      directoryPath,
      instructions: 'Stage tasks only.',
      agentIds: ['orch-agent', 'worker-agent'],
    });

    const manifestPath = join(directoryPath, '.mars', 'orchestration', 'bootstrap.json');
    chmodSync(manifestPath, 0o400);

    try {
      await expect(materializationService.materialize(project.id)).rejects.toBeInstanceOf(Error);
    } finally {
      chmodSync(manifestPath, 0o600);
    }

    expect(queryTasksGlobal({ projectId: project.id, limit: 10, offset: 0 })).toHaveLength(0);
    expect(queryRuns({ projectId: project.id, limit: 10, offset: 0 })).toHaveLength(0);
    expect(getDb().prepare('SELECT COUNT(*) as count FROM task_dependencies').get() as { count: number }).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) as count FROM task_executions').get() as { count: number }).toEqual({ count: 0 });
  });
});
