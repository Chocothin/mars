import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { initDatabase, getDb } from '../../db/index';
import { insertProvider } from '../../db/provider-repo';
import { insertAgent, getAgentById } from '../../db/agent-repo';
import { insertProject } from '../../db/project-repo';
import { getTaskById, insertTask } from '../../db/task-repo';
import { handleTaskRoutes } from '../../routes/tasks';
import type { Provider } from '../../types/provider';
import type { Agent } from '../../types/agent';
import type { Project } from '../../types/project';
import type { Task } from '../../types/task';

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

function makeAgent(id: string): Agent {
  return {
    id,
    name: `Agent ${id}`,
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

function makeProject(): Project {
  return {
    id: 'project-1',
    name: 'Project',
    description: '',
    instructions: '',
    directoryPath: '/tmp/project-1',
    providerId: 'prov-1',
    status: 'active',
    agentIds: ['agent-1'],
    mcpServerIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

function makeTask(): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    parentTaskId: null,
    title: 'Task',
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
  return handleTaskRoutes(req, url);
}

describe('task routes assignment', () => {
  beforeAll(() => {
    process.env.MARS_DB_PATH = ':memory:';
    initDatabase();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM task_dependencies');
    db.exec('DELETE FROM tasks');
    db.exec('DELETE FROM projects');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM providers');

    insertProvider(makeProvider());
    insertAgent(makeAgent('agent-1'));
    insertAgent(makeAgent('agent-2'));
    insertProject(makeProject());
    insertTask(makeTask());
  });

  it('persists task assignment through dedicated assignment endpoints', async () => {
    const setResponse = await callRoute('PUT', '/api/projects/project-1/tasks/task-1/assignment', { agentId: 'agent-1' });
    expect(setResponse).not.toBeNull();
    expect(setResponse!.status).toBe(200);

    const body = await setResponse!.json() as { data: { assignedAgentId: string | null; assignedAgentName: string | null; assignedAgentType: string | null } };
    expect(body.data.assignedAgentName).toBe('Agent agent-1');

    const stored = getTaskById('project-1', 'task-1');
    expect(stored?.assignedAgentId).toBe('agent-1');
    expect(stored?.assignedAgentType).toBeNull();

    const getResponse = await callRoute('GET', '/api/projects/project-1/tasks/task-1/assignment');
    const getBody = await getResponse!.json() as { data: { assignedAgentId: string | null; agent: Agent | null } };
    expect(getBody.data.assignedAgentId).toBe('agent-1');
    expect(getBody.data.agent?.id).toBe('agent-1');

    const clearResponse = await callRoute('DELETE', '/api/projects/project-1/tasks/task-1/assignment');
    expect(clearResponse).not.toBeNull();
    expect(clearResponse!.status).toBe(200);
    expect(getTaskById('project-1', 'task-1')?.assignedAgentId).toBeNull();
    expect(getTaskById('project-1', 'task-1')?.assignedAgentType).toBeNull();
  });

  it('rejects assigning an agent that is not part of the project', async () => {
    const response = await callRoute('PUT', '/api/projects/project-1/tasks/task-1/assignment', { agentId: 'agent-2' });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);

    const body = await response!.json() as { error: string };
    expect(body.error).toContain('is not assigned to project');
    expect(getTaskById('project-1', 'task-1')?.assignedAgentId).toBeNull();
    expect(getAgentById('agent-2')?.id).toBe('agent-2');
  });

  it('supports assignedAgentId updates through task patch semantics', async () => {
    const response = await callRoute('PATCH', '/api/projects/project-1/tasks/task-1', { assignedAgentId: 'agent-1' });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = await response!.json() as { data: { assignedAgentId: string | null; assignedAgentName: string | null; assignedAgentType: string | null } };
    expect(body.data.assignedAgentName).toBe('Agent agent-1');
    expect(getTaskById('project-1', 'task-1')?.assignedAgentId).toBe('agent-1');
    expect(getTaskById('project-1', 'task-1')?.assignedAgentType).toBeNull();
  });

  it('serializes assignedAgentName in task list and detail responses', async () => {
    await callRoute('PUT', '/api/projects/project-1/tasks/task-1/assignment', { agentId: 'agent-1' });

    const detailResponse = await callRoute('GET', '/api/tasks/task-1');
    expect(detailResponse).not.toBeNull();
    expect(detailResponse!.status).toBe(200);
    const detailBody = await detailResponse!.json() as { data: { assignedAgentId: string | null; assignedAgentName: string | null; assignedAgentType: string | null } };
    expect(detailBody.data.assignedAgentId).toBe('agent-1');
    expect(detailBody.data.assignedAgentName).toBe('Agent agent-1');
    expect(detailBody.data.assignedAgentType).toBeNull();

    const listResponse = await callRoute('GET', '/api/tasks?limit=10');
    expect(listResponse).not.toBeNull();
    expect(listResponse!.status).toBe(200);
    const listBody = await listResponse!.json() as { data: Array<{ id: string; assignedAgentName: string | null }> };
    expect(listBody.data[0]?.assignedAgentName).toBe('Agent agent-1');
  });
});
