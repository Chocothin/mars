import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { initDatabase, getDb } from '../../db/index';
import { insertProvider } from '../../db/provider-repo';
import { insertAgent } from '../../db/agent-repo';
import { insertProject } from '../../db/project-repo';
import { insertTask } from '../../db/task-repo';
import { insertRun } from '../../db/run-repo';
import { handleRunRoutes } from '../../routes/runs';
import type { Provider } from '../../types/provider';
import type { Agent } from '../../types/agent';
import type { Project } from '../../types/project';
import type { Task } from '../../types/task';
import type { Run } from '../../orchestrator/types';

const now = Date.now();

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

function makeAgent(): Agent {
  return {
    id: 'agent-1',
    name: 'Agent',
    description: '',
    providerId: 'prov-1',
    modelId: 'model-1',
    systemPrompt: '',
    reasoningLevel: 'none',
    workerCount: 1,
    mcpServerIds: [],
    skillIds: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function makeProject(id: string): Project {
  return {
    id,
    name: `Project ${id}`,
    description: '',
    instructions: '',
    directoryPath: `/tmp/${id}`,
    providerId: 'prov-1',
    status: 'active',
    agentIds: ['agent-1'],
    mcpServerIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

function makeTask(id: string, projectId: string): Task {
  return {
    id,
    projectId,
    parentTaskId: null,
    title: `Task ${id}`,
    description: '',
    status: 'ready',
    priority: 'medium',
    order: 0,
    assignedAgentType: null,
    assignedAgentId: null,
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    expectedOutputs: [],
    maxRetries: 2,
    retryCount: 0,
    reviewFeedback: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRun(id: string, projectId: string, status: Run['status']): Run {
  return {
    id,
    projectId,
    rootTaskIds: ['task-1'],
    status,
    config: {
      maxConcurrency: 1,
      maxRetries: 0,
      timeoutMs: 1000,
      taskTimeoutMs: 1000,
      autoReview: false,
      requireHumanApproval: false,
      hitl: null,
    },
    executionPlan: null,
    result: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
  };
}

async function callRoute(method: string, path: string, body?: unknown): Promise<Response | null> {
  const url = new URL(`http://localhost${path}`);
  const req = new Request(url.toString(), {
    method,
    ...(body !== undefined
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  return handleRunRoutes(req, url);
}

describe('run routes', () => {
  beforeAll(() => {
    process.env.MARS_DB_PATH = ':memory:';
    initDatabase();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM task_executions');
    db.exec('DELETE FROM runs');
    db.exec('DELETE FROM task_dependencies');
    db.exec('DELETE FROM tasks');
    db.exec('DELETE FROM projects');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM providers');

    insertProvider(makeProvider());
    insertAgent(makeAgent());
    insertProject(makeProject('project-1'));
    insertProject(makeProject('project-2'));
    insertTask(makeTask('task-1', 'project-1'));
    insertTask(makeTask('task-2', 'project-2'));
  });

  it('rejects run creation when a task is not owned by the project', async () => {
    const response = await callRoute('POST', '/api/projects/project-1/runs', { taskIds: ['task-2'] });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);

    const body = await response!.json() as { error: string };
    expect(body.error).toContain('Task not found in project project-1: task-2');
  });

  it('lists project runs beyond active ones and supports status filtering', async () => {
    insertRun(makeRun('run-running', 'project-1', 'running'));
    insertRun(makeRun('run-completed', 'project-1', 'completed'));
    insertRun(makeRun('run-other-project', 'project-2', 'completed'));

    const allResponse = await callRoute('GET', '/api/projects/project-1/runs');
    expect(allResponse).not.toBeNull();
    expect(allResponse!.status).toBe(200);
    const allBody = await allResponse!.json() as { data: Run[] };
    expect(allBody.data.map((run) => run.id).sort()).toEqual(['run-completed', 'run-running']);

    const completedResponse = await callRoute('GET', '/api/projects/project-1/runs?status=completed');
    expect(completedResponse).not.toBeNull();
    expect(completedResponse!.status).toBe(200);
    const completedBody = await completedResponse!.json() as { data: Run[] };
    expect(completedBody.data.map((run) => run.id)).toEqual(['run-completed']);
  });

  it('supports global run listing with project and paging filters', async () => {
    insertRun(makeRun('run-a', 'project-1', 'running'));
    insertRun(makeRun('run-b', 'project-1', 'completed'));
    insertRun(makeRun('run-c', 'project-2', 'completed'));

    const filteredResponse = await callRoute('GET', '/api/runs?projectId=project-1&status=completed&limit=1&offset=0');
    expect(filteredResponse).not.toBeNull();
    expect(filteredResponse!.status).toBe(200);

    const filteredBody = await filteredResponse!.json() as { data: Run[] };
    expect(filteredBody.data).toHaveLength(1);
    expect(filteredBody.data[0]?.id).toBe('run-b');
  });
});
