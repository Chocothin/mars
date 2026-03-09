import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../../db/index';
import { insertAgent } from '../../db/agent-repo';
import { insertProvider } from '../../db/provider-repo';
import { getRunById, queryRuns, updateRun } from '../../db/run-repo';
import { getTaskByIdGlobal, queryTasksGlobal } from '../../db/task-repo';
import { insertTaskExecution } from '../../db/task-exec-repo';
import { insertMessage, querySessions } from '../../db/terminal-repo';
import { handleProjectRoutes } from '../../routes/projects';
import { terminalService } from '../../terminal/service';
import type { Agent } from '../../types/agent';
import type { Provider } from '../../types/provider';

const tempDirs: string[] = [];
const now = Date.now();

function createTempProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mars-project-route-'));
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

function makeAgent(): Agent {
  return {
    id: 'orch-agent',
    name: 'Orchestrator Agent',
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

async function callRoute(method: string, path: string, body?: unknown): Promise<Response | null> {
  const url = new URL(`http://localhost${path}`);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }

  return handleProjectRoutes(new Request(url.toString(), init), url);
}

describe('Project routes bootstrap', () => {
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
    insertAgent(makeAgent());
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('returns bootstrap state from the dedicated project bootstrap route', async () => {
    const createResponse = await callRoute('POST', '/api/projects', {
      name: 'Route Project',
      directoryPath: createTempProjectDir(),
      instructions: 'Prepare a gated orchestration proposal only.',
    });

    expect(createResponse).not.toBeNull();
    expect(createResponse?.status).toBe(201);

    const createdBody = await createResponse?.json() as { data: { id: string; agentIds: string[] } };
    expect(createdBody.data.agentIds).toEqual(['orch-agent']);

    const bootstrapResponse = await callRoute('GET', `/api/projects/${createdBody.data.id}/bootstrap`);
    expect(bootstrapResponse).not.toBeNull();
    expect(bootstrapResponse?.status).toBe(200);

    const bootstrapBody = await bootstrapResponse?.json() as {
      data: {
        manifest: { selectedAgentId: string };
        proposal: { selectedAgentId: string; suggestedRootTasks: unknown[] };
      };
    };

    expect(bootstrapBody.data.manifest.selectedAgentId).toBe('orch-agent');
    expect(bootstrapBody.data.proposal.selectedAgentId).toBe('orch-agent');
    expect(bootstrapBody.data.proposal.suggestedRootTasks.length).toBeGreaterThan(0);
  });

  it('returns conflict when the saved bootstrap session is missing', async () => {
    const createResponse = await callRoute('POST', '/api/projects', {
      name: 'Missing Session Project',
      directoryPath: createTempProjectDir(),
      instructions: 'Prepare bootstrap only.',
    });

    const createdBody = await createResponse?.json() as { data: { id: string; directoryPath: string } };
    const sessions = querySessions({ projectId: createdBody.data.id, limit: 10, offset: 0 });
    expect(sessions).toHaveLength(1);
    getDb().exec(`DELETE FROM terminal_sessions WHERE id = '${sessions[0]!.id}'`);

    const bootstrapResponse = await callRoute('GET', `/api/projects/${createdBody.data.id}/bootstrap`);
    expect(bootstrapResponse?.status).toBe(409);

    const body = await bootstrapResponse?.json() as { error: string };
    expect(body.error).toContain('Re-bootstrap is required');
  });

  it('returns conflict when bootstrap artifacts are corrupt', async () => {
    const directoryPath = createTempProjectDir();
    const createResponse = await callRoute('POST', '/api/projects', {
      name: 'Corrupt Bootstrap Project',
      directoryPath,
      instructions: 'Prepare bootstrap only.',
    });

    const createdBody = await createResponse?.json() as { data: { id: string } };
    const manifestPath = join(directoryPath, '.mars', 'orchestration', 'bootstrap.json');
    const proposalPath = join(directoryPath, '.mars', 'orchestration', 'proposal.json');
    unlinkSync(manifestPath);
    writeFileSync(proposalPath, '{bad-json', 'utf8');

    const bootstrapResponse = await callRoute('GET', `/api/projects/${createdBody.data.id}/bootstrap`);
    expect(bootstrapResponse?.status).toBe(404);

    const missingBody = await bootstrapResponse?.json() as { error: string };
    expect(missingBody.error).toContain('Re-bootstrap is required');

    writeFileSync(manifestPath, '{}', 'utf8');
    const corruptResponse = await callRoute('GET', `/api/projects/${createdBody.data.id}/bootstrap`);
    expect(corruptResponse?.status).toBe(409);

    const corruptBody = await corruptResponse?.json() as { error: string };
    expect(corruptBody.error).toContain('corrupt');
  });

  it('rebuilds bootstrap state through the dedicated recovery route', async () => {
    const directoryPath = createTempProjectDir();
    const createResponse = await callRoute('POST', '/api/projects', {
      name: 'Rebuild Bootstrap Project',
      directoryPath,
      instructions: 'Prepare bootstrap only.',
    });

    const createdBody = await createResponse?.json() as { data: { id: string } };
    const manifestPath = join(directoryPath, '.mars', 'orchestration', 'bootstrap.json');
    const proposalPath = join(directoryPath, '.mars', 'orchestration', 'proposal.json');
    unlinkSync(manifestPath);
    writeFileSync(proposalPath, '{bad-json', 'utf8');

    const rebuildResponse = await callRoute('POST', `/api/projects/${createdBody.data.id}/bootstrap/rebuild`);
    expect(rebuildResponse).not.toBeNull();
    expect(rebuildResponse?.status).toBe(201);

    const rebuildBody = await rebuildResponse?.json() as {
      data: {
        manifest: { selectedAgentId: string; sessionId: string; materialization?: unknown };
        proposal: { selectedAgentId: string; suggestedRootTasks: unknown[] };
        session: { id: string };
      };
    };

    expect(rebuildBody.data.manifest.selectedAgentId).toBe('orch-agent');
    expect(rebuildBody.data.proposal.selectedAgentId).toBe('orch-agent');
    expect(rebuildBody.data.proposal.suggestedRootTasks.length).toBeGreaterThan(0);
    expect(rebuildBody.data.manifest.sessionId).toBe(rebuildBody.data.session.id);
    expect(rebuildBody.data.manifest.materialization).toBeUndefined();

    const refreshedBootstrapResponse = await callRoute('GET', `/api/projects/${createdBody.data.id}/bootstrap`);
    expect(refreshedBootstrapResponse?.status).toBe(200);

    const runs = queryRuns({ projectId: createdBody.data.id, limit: 20, offset: 0 });
    expect(runs).toHaveLength(0);
  });

  it('materializes the current bootstrap proposal through the dedicated route and returns the pending run without starting it', async () => {
    const createResponse = await callRoute('POST', '/api/projects', {
      name: 'Materialize Route Project',
      directoryPath: createTempProjectDir(),
      instructions: 'Prepare a gated orchestration proposal only.',
    });

    const createdBody = await createResponse?.json() as { data: { id: string } };
    const materializeResponse = await callRoute('POST', `/api/projects/${createdBody.data.id}/bootstrap/materialize`);
    expect(materializeResponse).not.toBeNull();
    expect(materializeResponse?.status).toBe(201);

    const body = await materializeResponse?.json() as {
      data: {
        createdTaskIds: string[];
        dependencyCount: number;
        alreadyMaterialized: boolean;
        runId: string;
        runStatus: string;
        noRunStarted: boolean;
      };
    };

    expect(body.data.alreadyMaterialized).toBe(false);
    expect(body.data.noRunStarted).toBe(true);
    expect(body.data.runStatus).toBe('pending');
    expect(typeof body.data.runId).toBe('string');
    expect(body.data.createdTaskIds.length).toBeGreaterThan(0);
    expect(body.data.dependencyCount).toBeGreaterThan(0);
    expect(queryTasksGlobal({ projectId: createdBody.data.id, limit: 20, offset: 0 })).toHaveLength(body.data.createdTaskIds.length);

    const runs = queryRuns({ projectId: createdBody.data.id, limit: 20, offset: 0 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: body.data.runId,
      status: 'pending',
      startedAt: null,
      completedAt: null,
      executionPlan: null,
      result: null,
    });
    expect(getDb().prepare('SELECT COUNT(*) as count FROM task_executions').get() as { count: number }).toEqual({ count: 0 });
  });

  it('returns conflict with machine-readable state when bootstrap materialization already exists', async () => {
    const createResponse = await callRoute('POST', '/api/projects', {
      name: 'Duplicate Materialize Route Project',
      directoryPath: createTempProjectDir(),
      instructions: 'Prepare a gated orchestration proposal only.',
    });

    const createdBody = await createResponse?.json() as { data: { id: string } };
    const firstResponse = await callRoute('POST', `/api/projects/${createdBody.data.id}/bootstrap/materialize`);
    const firstBody = await firstResponse?.json() as {
      data: {
        createdTaskIds: string[];
        dependencyCount: number;
        runId: string;
        runStatus: string;
      };
    };

    updateRun(firstBody.data.runId, { status: 'running' });

    const duplicateResponse = await callRoute('POST', `/api/projects/${createdBody.data.id}/bootstrap/materialize`);
    expect(duplicateResponse?.status).toBe(409);

    const duplicateBody = await duplicateResponse?.json() as {
      error: string;
      data: {
        createdTaskIds: string[];
        dependencyCount: number;
        alreadyMaterialized: boolean;
        runId: string;
        runStatus: string;
        noRunStarted: boolean;
      };
    };
    expect(duplicateBody.error).toContain('already materialized');
    expect(duplicateBody.data.alreadyMaterialized).toBe(true);
    expect(duplicateBody.data.noRunStarted).toBe(true);
    expect(duplicateBody.data.createdTaskIds).toEqual(firstBody.data.createdTaskIds);
    expect(duplicateBody.data.dependencyCount).toBe(firstBody.data.dependencyCount);
    expect(duplicateBody.data.runId).toBe(firstBody.data.runId);
    expect(duplicateBody.data.runStatus).toBe('running');
  });

  it('deletes project-scoped persistence and bootstrap artifacts without leaving stale references', async () => {
    const directoryPath = createTempProjectDir();
    const createResponse = await callRoute('POST', '/api/projects', {
      name: 'Delete Cleanup Project',
      directoryPath,
      instructions: 'Prepare a gated orchestration proposal only.',
    });

    expect(createResponse?.status).toBe(201);

    const createdBody = await createResponse?.json() as { data: { id: string } };
    const projectId = createdBody.data.id;
    const materializeResponse = await callRoute('POST', `/api/projects/${projectId}/bootstrap/materialize`);
    expect(materializeResponse?.status).toBe(201);

    const materializeBody = await materializeResponse?.json() as {
      data: {
        createdTaskIds: string[];
        runId: string;
      };
    };

    const bootstrapDir = join(directoryPath, '.mars', 'orchestration');
    const sessions = querySessions({ projectId, limit: 20, offset: 0 });
    expect(sessions).toHaveLength(1);

    const sessionId = sessions[0]!.id;
    const runId = materializeBody.data.runId;
    const taskId = materializeBody.data.createdTaskIds[0]!;

    insertMessage({
      id: randomUUID(),
      sessionId,
      role: 'assistant',
      type: 'text',
      content: 'bootstrap ready',
      metadata: null,
      createdAt: Date.now(),
    });

    insertTaskExecution({
      id: randomUUID(),
      runId,
      taskId,
      agentId: 'orch-agent',
      sessionId,
      status: 'completed',
      attempt: 1,
      input: {
        prompt: 'Execute task',
        systemPrompt: 'System prompt',
        tools: [],
        context: 'context',
        workingDirectory: directoryPath,
        orchestrationBrief: null,
      },
      output: {
        result: 'done',
        filesModified: [],
        tokensUsed: 1,
        costUsd: 0,
      },
      startedAt: Date.now(),
      completedAt: Date.now(),
      durationMs: 1,
      error: null,
    });

    expect(queryTasksGlobal({ projectId, limit: 20, offset: 0 }).length).toBeGreaterThan(0);
    expect(queryRuns({ projectId, limit: 20, offset: 0 })).toHaveLength(1);
    expect(querySessions({ projectId, limit: 20, offset: 0 })).toHaveLength(1);

    const deleteResponse = await callRoute('DELETE', `/api/projects/${projectId}`);
    expect(deleteResponse?.status).toBe(200);

    expect(queryTasksGlobal({ projectId, limit: 20, offset: 0 })).toHaveLength(0);
    expect(queryRuns({ projectId, limit: 20, offset: 0 })).toHaveLength(0);
    expect(querySessions({ projectId, limit: 20, offset: 0 })).toHaveLength(0);
    expect(getRunById(runId)).toBeNull();
    expect(getTaskByIdGlobal(taskId)).toBeNull();
    expect(await terminalService.getSession(sessionId)).toBeNull();
    expect(getDb().prepare('SELECT COUNT(*) as count FROM task_executions').get() as { count: number }).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) as count FROM terminal_messages').get() as { count: number }).toEqual({ count: 0 });

    const bootstrapResponse = await callRoute('GET', `/api/projects/${projectId}/bootstrap`);
    expect(bootstrapResponse?.status).toBe(404);
    expect(existsSync(bootstrapDir)).toBe(false);
  });
});
