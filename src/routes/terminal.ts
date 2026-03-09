import { terminalService } from '../terminal/service';
import { sessionAccessTokenManager } from '../terminal/session-access-token-manager';
import { SkillResolver } from '../terminal/input/skill-resolver';
import { SkillService } from '../skills/service';
import { getDb } from '../db/index';
import { getRunById } from '../db/run-repo';
import { getTaskByIdGlobal } from '../db/task-repo';
import type { SessionQuery, MessageQuery, TerminalSessionAccess } from '../types/terminal';
import type { ApiResponse, PaginatedResponse } from '../types/common';
import type { TerminalSession } from '../types/terminal';
import type { TerminalSessionActivity } from '../types/terminal';
import type { TaskExecutionStatus } from '../orchestrator/types';
import type { HeartbeatStatus } from '../orchestrator/heartbeat';

const skillResolver = new SkillResolver(new SkillService());

function sanitizeSession(session: TerminalSession): TerminalSession {
  const { accessToken: _accessToken, runtimeFingerprint: _runtimeFingerprint, runtimeVersion: _runtimeVersion, ...publicSession } = session;
  return publicSession;
}

function buildSessionAccess(session: TerminalSession): TerminalSessionAccess {
  return {
    session: sanitizeSession(session),
    accessToken: sessionAccessTokenManager.getOrCreate(session.id),
  };
}

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { success: false, error: message } satisfies ApiResponse,
    { status },
  );
}

interface ActivityExecutionRow {
  run_id: string;
  task_id: string;
  execution_status: string;
  execution_timestamp: number | null;
}

interface ActivityHeartbeatRow {
  run_id: string;
  heartbeat_status: string;
  current_task_id: string | null;
  last_seen: number;
}

export async function handleTerminalRoutes(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (!path.startsWith('/api/terminal')) {
    return null;
  }

  try {
    const segments = path.split('/');

    if (path === '/api/terminal/sessions' && method === 'POST') {
      return await handleCreateSession(req);
    }

    if (path === '/api/terminal/sessions' && method === 'GET') {
      return await handleListSessions(url);
    }

    if (segments.length === 5 && segments[3] === 'sessions' && method === 'GET') {
      const id = segments[4];
      if (!id) return null;
      return await handleGetSession(id);
    }

    if (segments.length === 6 && segments[3] === 'sessions' && segments[5] === 'activity' && method === 'GET') {
      const id = segments[4];
      if (!id) return null;
      return await handleGetSessionActivity(id);
    }

    if (segments.length === 6 && segments[3] === 'sessions' && segments[5] === 'access' && method === 'POST') {
      const id = segments[4];
      if (!id) return null;
      return await handleGetSessionAccess(id);
    }

    if (segments.length === 5 && segments[3] === 'sessions' && method === 'DELETE') {
      const id = segments[4];
      if (!id) return null;
      return await handleDeleteSession(id);
    }

    if (segments.length === 6 && segments[3] === 'sessions' && segments[5] === 'restart' && method === 'POST') {
      const id = segments[4];
      if (!id) return null;
      return await handleRestartSession(id);
    }

    if (segments.length === 6 && segments[3] === 'sessions' && segments[5] === 'messages' && method === 'GET') {
      const sessionId = segments[4];
      if (!sessionId) return null;
      return await handleGetMessages(sessionId, url);
    }

    if (segments.length === 6 && segments[3] === 'sessions' && segments[5] === 'messages' && method === 'DELETE') {
      const sessionId = segments[4];
      if (!sessionId) return null;
      return await handleClearMessages(sessionId);
    }

    if (path === '/api/terminal/skills/autocomplete' && method === 'GET') {
      return await handleSkillAutocomplete(url);
    }

    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    const status = message.includes('not found') ? 404
      : message.includes('session limit reached') ? 409
      : 500;
    return errorResponse(message, status);
  }
}

async function handleCreateSession(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;

  if (!input.projectId || typeof input.projectId !== 'string') {
    return errorResponse('projectId is required and must be a string', 400);
  }
  if (!input.agentId || typeof input.agentId !== 'string') {
    return errorResponse('agentId is required and must be a string', 400);
  }
  if (input.mcpServerIds !== undefined) {
    if (!Array.isArray(input.mcpServerIds) || !input.mcpServerIds.every((id) => typeof id === 'string')) {
      return errorResponse('mcpServerIds must be an array of strings', 400);
    }
  }

  const session = await terminalService.getOrCreateSession(
    input.projectId,
    input.agentId,
    input.mcpServerIds as string[] | undefined,
  );
  const sessionAccess = buildSessionAccess(session);

  return Response.json(
    { success: true, data: sessionAccess } satisfies ApiResponse<TerminalSessionAccess>,
    { status: 201 },
  );
}

async function handleListSessions(url: URL): Promise<Response> {
  const params = url.searchParams;
  const query: SessionQuery = {};

  const projectId = params.get('projectId');
  if (projectId) query.projectId = projectId;

  const agentId = params.get('agentId');
  if (agentId) query.agentId = agentId;

  const status = params.get('status');
  if (status) query.status = status as SessionQuery['status'];

  const limit = params.get('limit');
  query.limit = limit ? Math.max(1, Math.min(100, Number(limit) || 50)) : 50;

  const offset = params.get('offset');
  query.offset = offset ? Math.max(0, Number(offset) || 0) : 0;

  const sessions = await terminalService.listSessions(query);

  const response: PaginatedResponse<(typeof sessions)[number]> = {
    success: true,
    data: sessions.map((session) => sanitizeSession(session)),
    total: sessions.length,
    limit: query.limit,
    offset: query.offset,
  };

  return Response.json(response);
}

async function handleGetSession(id: string): Promise<Response> {
  const session = await terminalService.getSession(id);
  if (!session) {
    return errorResponse('Session not found', 404);
  }
  return Response.json({ success: true, data: sanitizeSession(session) } satisfies ApiResponse<TerminalSession>);
}

async function handleGetSessionActivity(id: string): Promise<Response> {
  const session = await terminalService.getSession(id);
  if (!session) {
    return errorResponse('Session not found', 404);
  }

  const db = getDb();
  const execution = db.prepare(`
    SELECT
      te.run_id,
      te.task_id,
      te.status AS execution_status,
      COALESCE(te.completed_at, te.started_at) AS execution_timestamp
    FROM task_executions te
    WHERE te.session_id = $sessionId
    ORDER BY
      COALESCE(te.completed_at, te.started_at, 0) DESC,
      CASE te.status
        WHEN 'running' THEN 0
        WHEN 'retrying' THEN 1
        WHEN 'assigned' THEN 2
        ELSE 3
      END,
      te.attempt DESC
    LIMIT 1
  `).get({ $sessionId: id }) as ActivityExecutionRow | null;

  const heartbeat = execution
    ? db.prepare(`
      SELECT run_id, status AS heartbeat_status, current_task_id, last_seen
      FROM agent_heartbeats
      WHERE agent_id = $agentId AND run_id = $runId
      LIMIT 1
    `).get({
      $agentId: session.agentId,
      $runId: execution.run_id,
    }) as ActivityHeartbeatRow | null
    : null;

  const runId = execution?.run_id ?? heartbeat?.run_id ?? null;
  const run = runId ? getRunById(runId) : null;
  const currentTaskId = heartbeat?.current_task_id ?? execution?.task_id ?? null;
  const currentTaskTitle = currentTaskId ? (getTaskByIdGlobal(currentTaskId)?.title ?? null) : null;

  const activity: TerminalSessionActivity = {
    sessionId: session.id,
    runId,
    runStatus: run?.status ?? null,
    heartbeatStatus: (heartbeat?.heartbeat_status as HeartbeatStatus | undefined) ?? null,
    heartbeatLastSeenAt: heartbeat?.last_seen ?? null,
    currentTaskId,
    currentTaskTitle,
    latestExecutionStatus: (execution?.execution_status as TaskExecutionStatus | undefined) ?? null,
    latestExecutionTimestamp: execution?.execution_timestamp ?? null,
  };

  return Response.json({ success: true, data: activity } satisfies ApiResponse<TerminalSessionActivity>);
}

async function handleGetSessionAccess(id: string): Promise<Response> {
  const session = await terminalService.getSession(id);
  if (!session) {
    return errorResponse('Session not found', 404);
  }

  const sessionAccess = buildSessionAccess(session);
  return Response.json({ success: true, data: sessionAccess } satisfies ApiResponse<TerminalSessionAccess>);
}

async function handleDeleteSession(id: string): Promise<Response> {
  const deleted = await terminalService.deleteSession(id);
  if (!deleted) {
    return errorResponse('Session not found', 404);
  }

  return Response.json(
    { success: true, data: { deleted: true } } satisfies ApiResponse<{ deleted: boolean }>,
  );
}

async function handleRestartSession(id: string): Promise<Response> {
  const session = await terminalService.restartSession(id);
  if (!session) {
    return errorResponse('Session not found', 404);
  }

  const sessionAccess = buildSessionAccess(session);

  return Response.json({ success: true, data: sessionAccess } satisfies ApiResponse<TerminalSessionAccess>);
}

async function handleGetMessages(sessionId: string, url: URL): Promise<Response> {
  const params = url.searchParams;
  const query: MessageQuery = {
    sessionId,
  };

  const role = params.get('role');
  if (role) query.role = role as MessageQuery['role'];

  const type = params.get('type');
  if (type) query.type = type as MessageQuery['type'];

  const limit = params.get('limit');
  query.limit = limit ? Math.max(1, Math.min(100, Number(limit) || 50)) : 50;

  const offset = params.get('offset');
  query.offset = offset ? Math.max(0, Number(offset) || 0) : 0;

  const before = params.get('before');
  if (before) query.before = Number(before);

  const messages = await terminalService.getMessages(query);

  const response: PaginatedResponse<(typeof messages)[number]> = {
    success: true,
    data: messages,
    total: messages.length,
    limit: query.limit,
    offset: query.offset,
  };

  return Response.json(response);
}

async function handleClearMessages(sessionId: string): Promise<Response> {
  await terminalService.clearMessages(sessionId);

  return Response.json(
    { success: true, data: { cleared: true } } satisfies ApiResponse<{ cleared: boolean }>,
  );
}

async function handleSkillAutocomplete(url: URL): Promise<Response> {
  const params = url.searchParams;
  const q = params.get('q') || '';

  const allNames = await skillResolver.listNames();
  const filtered = allNames.filter((name) =>
    name.toLowerCase().startsWith(q.toLowerCase()),
  );

  return Response.json(
    { success: true, data: filtered } satisfies ApiResponse<string[]>,
  );
}
