import { getEngine } from '../orchestrator/factory';
import { ClaimManager } from '../orchestrator/claim';
import { getDb } from '../db/index';
import type { RunConfig, RunStatus } from '../orchestrator/types';
import type { HeartbeatStatus } from '../orchestrator/heartbeat';
import type { ApiResponse } from '../types/common';

const claimManager = new ClaimManager();

const VALID_RUN_STATUSES: RunStatus[] = [
  'pending',
  'decomposing',
  'scheduling',
  'running',
  'reviewing',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { success: false, error: message } satisfies ApiResponse,
    { status },
  );
}

export async function handleRunRoutes(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (!path.startsWith('/api/runs')) {
    if (!path.match(/^\/api\/projects\/[^/]+\/runs$/)) {
      return null;
    }
  }

  try {
    if (path.match(/^\/api\/projects\/[^/]+\/runs$/) && method === 'POST') {
      const projectId = path.split('/')[3]!;
      return await handleCreate(projectId, req);
    }

    if (path.match(/^\/api\/projects\/[^/]+\/runs$/) && method === 'GET') {
      const projectId = path.split('/')[3]!;
      return await handleListByProject(projectId, url);
    }

    if (path === '/api/runs' && method === 'GET') {
      return await handleList(url);
    }

    const segments = path.split('/');
    const runId = segments[3];

    if (!runId) return null;

    const action = segments[4];

    if (!action && method === 'GET') {
      return await handleGetStatus(runId);
    }

    if (action === 'start' && method === 'POST') {
      return await handleStart(runId);
    }

    if (action === 'pause' && method === 'POST') {
      return await handlePause(runId);
    }

    if (action === 'resume' && method === 'POST') {
      return await handleResume(runId);
    }

    if (action === 'cancel' && method === 'POST') {
      return await handleCancel(runId);
    }

    if (action === 'ready-tasks' && method === 'GET') {
      return await handleReadyTasks(runId);
    }

    if (action === 'agent-status' && method === 'GET') {
      return await handleAgentStatus(runId);
    }

    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    const status = message.includes('not found') ? 404
      : message.includes('Invalid') || message.includes('Cannot') ? 400
      : 500;
    return errorResponse(message, status);
  }
}

async function handleCreate(projectId: string, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;

  if (!input.taskIds || !Array.isArray(input.taskIds) || input.taskIds.length === 0) {
    return errorResponse('taskIds is required and must be a non-empty array', 400);
  }

  for (const id of input.taskIds) {
    if (typeof id !== 'string') {
      return errorResponse('Each taskId must be a string', 400);
    }
  }

  const config = input.config as Partial<RunConfig> | undefined;
  const engine = getEngine();
  const run = await engine.createRun(projectId, input.taskIds as string[], config);

  return Response.json(
    { success: true, data: run } satisfies ApiResponse,
    { status: 201 },
  );
}

async function handleListByProject(projectId: string, url: URL): Promise<Response> {
  return handleList(url, projectId);
}

function parseRunListQuery(url: URL): { status?: RunStatus; limit?: number; offset?: number; projectId?: string } | Response {
  const statusParam = url.searchParams.get('status');
  if (statusParam && !VALID_RUN_STATUSES.includes(statusParam as RunStatus)) {
    return errorResponse(`status must be one of: ${VALID_RUN_STATUSES.join(', ')}`, 400);
  }

  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');
  const projectId = url.searchParams.get('projectId') ?? undefined;

  return {
    projectId,
    status: statusParam as RunStatus | undefined,
    limit: limitParam ? Math.max(1, Math.min(200, Number(limitParam) || 50)) : 50,
    offset: offsetParam ? Math.max(0, Number(offsetParam) || 0) : 0,
  };
}

async function handleList(url: URL, projectIdOverride?: string): Promise<Response> {
  const engine = getEngine();
  const parsed = parseRunListQuery(url);
  if (parsed instanceof Response) {
    return parsed;
  }

  const runs = await engine.listRuns({
    projectId: projectIdOverride ?? parsed.projectId,
    status: parsed.status,
    limit: parsed.limit,
    offset: parsed.offset,
  });

  return Response.json(
    { success: true, data: runs } satisfies ApiResponse,
  );
}

async function handleGetStatus(runId: string): Promise<Response> {
  const engine = getEngine();
  const run = await engine.getRunStatus(runId);

  return Response.json(
    { success: true, data: run } satisfies ApiResponse,
  );
}

async function handleStart(runId: string): Promise<Response> {
  const engine = getEngine();

  const run = await engine.getRunStatus(runId);
  if (run.status !== 'pending') {
    return errorResponse(`Cannot start run in status '${run.status}'`, 400);
  }

  engine.startRun(runId).catch((err) => {
    console.error(`[Run ${runId}] Execution failed:`, err);
  });

  return Response.json(
    { success: true, data: { runId, action: 'started' } } satisfies ApiResponse,
    { status: 202 },
  );
}

async function handlePause(runId: string): Promise<Response> {
  const engine = getEngine();
  await engine.pauseRun(runId);

  return Response.json(
    { success: true, data: { runId, action: 'paused' } } satisfies ApiResponse,
  );
}

async function handleResume(runId: string): Promise<Response> {
  const engine = getEngine();
  engine.resumeRun(runId).catch(err => console.error(`Resume failed for run ${runId}:`, err));

  return Response.json(
    { success: true, data: { runId, action: 'resumed' } } satisfies ApiResponse,
  );
}

async function handleCancel(runId: string): Promise<Response> {
  const engine = getEngine();
  await engine.cancelRun(runId);

  return Response.json(
    { success: true, data: { runId, action: 'cancelled' } } satisfies ApiResponse,
  );
}

async function handleReadyTasks(runId: string): Promise<Response> {
  const tasks = claimManager.getReadyTasks(runId);
  return Response.json(
    { success: true, data: tasks } satisfies ApiResponse,
  );
}

interface AgentHeartbeatRow {
  agent_id: string;
  run_id: string;
  status: string;
  current_task_id: string | null;
  last_seen: number;
  started_at: number;
}

async function handleAgentStatus(runId: string): Promise<Response> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT agent_id, run_id, status, current_task_id, last_seen, started_at
    FROM agent_heartbeats
    WHERE run_id = $runId
  `).all({ $runId: runId }) as AgentHeartbeatRow[];

  const data = rows.map((row) => ({
    agentId: row.agent_id,
    runId: row.run_id,
    status: row.status as HeartbeatStatus,
    currentTaskId: row.current_task_id,
    lastSeen: row.last_seen,
    startedAt: row.started_at,
  }));

  return Response.json(
    { success: true, data } satisfies ApiResponse,
  );
}
