import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { initDatabase, getDb } from '../../db/index';
import { insertProvider } from '../../db/provider-repo';
import { insertAgent } from '../../db/agent-repo';
import { insertProject } from '../../db/project-repo';
import { getTaskById, insertTask } from '../../db/task-repo';
import { ClaimManager } from '../../orchestrator/claim';
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

function makeAgent(): Agent {
  return {
    id: 'agent-1',
    name: 'Agent agent-1',
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

describe('ClaimManager', () => {
  beforeAll(() => {
    process.env.MARS_DB_PATH = ':memory:';
    initDatabase();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM task_dependencies');
    db.exec('DELETE FROM task_executions');
    db.exec('DELETE FROM runs');
    db.exec('DELETE FROM tasks');
    db.exec('DELETE FROM projects');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM providers');

    insertProvider(makeProvider());
    insertAgent(makeAgent());
    insertProject(makeProject());
    insertTask(makeTask());
    db.prepare(`
      INSERT INTO runs (id, project_id, root_task_ids, status, config, execution_plan, result, created_at, started_at, completed_at)
      VALUES ($id, $projectId, '[]', 'running', '{}', NULL, NULL, $createdAt, NULL, NULL)
    `).run({ $id: 'run-1', $projectId: 'project-1', $createdAt: now });
  });

  it('stores only the assigned agent id when claiming the next ready task', () => {
    const claimManager = new ClaimManager();

    const result = claimManager.claimNextReady('agent-1', 'run-1');

    expect(result).not.toBeNull();
    expect(result?.taskId).toBe('task-1');
    expect(result?.agentId).toBe('agent-1');
    expect(typeof result?.claimedAt).toBe('number');
    const stored = getTaskById('project-1', 'task-1');
    expect(stored?.status).toBe('in_progress');
    expect(stored?.assignedAgentId).toBe('agent-1');
    expect(stored?.assignedAgentType).toBeNull();
  });
});
