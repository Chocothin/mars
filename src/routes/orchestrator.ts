import { getAgentPool, getDecomposer, getOrchestratorRegistry } from '../orchestrator/factory';
import type { ProposedSubtask } from '../events/types';
import type { ApiResponse } from '../types/common';
import type { AgentPoolEntry } from '../orchestrator/agent-pool';

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { success: false, error: message } satisfies ApiResponse,
    { status },
  );
}

export async function handleOrchestratorRoutes(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (path.match(/^\/api\/tasks\/[^/]+\/decompose$/) && method === 'POST') {
    const taskId = path.split('/')[3]!;
    return await handlePropose(taskId, req);
  }

  if (path.match(/^\/api\/tasks\/[^/]+\/decompose\/confirm$/) && method === 'POST') {
    const taskId = path.split('/')[3]!;
    return await handleConfirm(taskId, req);
  }

  // ─── Chat API ───

  if (path.match(/^\/api\/projects\/[^/]+\/chat$/) && method === 'POST') {
    const projectId = path.split('/')[3]!;
    return await handleChatSend(projectId, req);
  }

  if (path.match(/^\/api\/projects\/[^/]+\/chat\/history$/) && method === 'GET') {
    const projectId = path.split('/')[3]!;
    return handleChatHistory(projectId);
  }

  if (path.match(/^\/api\/projects\/[^/]+\/chat\/abort$/) && method === 'POST') {
    const projectId = path.split('/')[3]!;
    return handleChatAbort(projectId);
  }

  if (path.match(/^\/api\/projects\/[^/]+\/chat\/status$/) && method === 'GET') {
    const projectId = path.split('/')[3]!;
    return handleChatStatus(projectId);
  }

  if (path.match(/^\/api\/projects\/[^/]+\/chat\/reset$/) && method === 'POST') {
    const projectId = path.split('/')[3]!;
    return handleChatReset(projectId);
  }

  if (path === '/api/orchestrator/sessions' && method === 'GET') {
    return handleListSessions();
  }

  // ─── AgentPool Status ───

  if (path.match(/^\/api\/projects\/[^/]+\/agents\/status$/) && method === 'GET') {
    const projectId = path.split('/')[3]!;
    return handleAgentPoolStatus(projectId);
  }

  // ─── Chat SSE Stream ───

  if (path.match(/^\/api\/projects\/[^/]+\/chat\/stream$/) && method === 'GET') {
    const projectId = path.split('/')[3]!;
    return handleChatStream(projectId, req);
  }

  return null;
}

// ─── Decompose ───

async function handlePropose(taskId: string, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;
  const projectContext = typeof input.projectContext === 'string' ? input.projectContext : '';

  try {
    const decomposer = getDecomposer();
    const subtasks = await decomposer.propose(taskId, projectContext);

    return Response.json(
      { success: true, data: { subtasks } } satisfies ApiResponse,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    const status = message.includes('not found') ? 404 : 500;
    return errorResponse(message, status);
  }
}

async function handleConfirm(taskId: string, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;

  if (!input.approved || !Array.isArray(input.approved)) {
    return errorResponse('approved is required and must be an array', 400);
  }

  try {
    const decomposer = getDecomposer();
    const tasks = await decomposer.confirm(taskId, input.approved as ProposedSubtask[]);

    return Response.json(
      { success: true, data: { tasks } } satisfies ApiResponse,
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    const status = message.includes('not found') ? 404 : 500;
    return errorResponse(message, status);
  }
}

// ─── Chat ───

async function handleChatSend(projectId: string, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;
  if (typeof input.message !== 'string' || input.message.trim().length === 0) {
    return errorResponse('message is required and must be a non-empty string', 400);
  }

  try {
    const registry = getOrchestratorRegistry();
    const session = await registry.getOrCreate(projectId);
    const response = await session.send(input.message as string);

    return Response.json({
      success: true,
      data: {
        response,
        sessionId: session.getSessionId(),
        state: session.getState(),
      },
    } satisfies ApiResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    const status = message.includes('not found') ? 404
      : message.includes('already processing') ? 409
      : 500;
    return errorResponse(message, status);
  }
}

function handleChatHistory(projectId: string): Response {
  try {
    const registry = getOrchestratorRegistry();
    const session = registry.get(projectId);

    if (!session) {
      return Response.json({
        success: true,
        data: { messages: [], state: 'none' },
      } satisfies ApiResponse);
    }

    return Response.json({
      success: true,
      data: {
        messages: session.getHistory(),
        state: session.getState(),
        sessionId: session.getSessionId(),
      },
    } satisfies ApiResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return errorResponse(message, 500);
  }
}

function handleChatAbort(projectId: string): Response {
  try {
    const registry = getOrchestratorRegistry();
    const session = registry.get(projectId);

    if (!session) {
      return errorResponse('No active session for this project', 404);
    }

    session.abort();
    return Response.json({
      success: true,
      data: { projectId, action: 'aborted' },
    } satisfies ApiResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return errorResponse(message, 500);
  }
}

function handleChatReset(projectId: string): Response {
  try {
    const registry = getOrchestratorRegistry();
    registry.terminate(projectId);
    return Response.json({
      success: true,
      data: { projectId, action: 'reset' },
    } satisfies ApiResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return errorResponse(message, 500);
  }
}

function handleChatStatus(projectId: string): Response {
  try {
    const registry = getOrchestratorRegistry();
    const session = registry.get(projectId);

    return Response.json({
      success: true,
      data: {
        active: session !== null,
        state: session?.getState() ?? 'none',
        sessionId: session?.getSessionId() ?? null,
        historyLength: session?.getHistory().length ?? 0,
      },
    } satisfies ApiResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return errorResponse(message, 500);
  }
}

// ─── AgentPool Status ───

function handleAgentPoolStatus(projectId: string): Response {
  try {
    const pool = getAgentPool();
    const all = pool.getAll();

    const entries = all
      .filter((e: AgentPoolEntry) => e.runId !== null)
      .map((e: AgentPoolEntry) => ({
        agentId: e.agentId,
        agentName: e.agentName,
        status: e.status === 'working' ? 'busy' : e.status === 'idle' ? 'idle' : 'offline',
        currentTaskId: e.currentTaskId,
        lastActiveAt: new Date(e.lastActivityAt).toISOString(),
      }));

    return Response.json({
      success: true,
      data: entries,
    } satisfies ApiResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return errorResponse(message, 500);
  }
}

// ─── Chat SSE Stream ───

function handleChatStream(projectId: string, req: Request): Response {
  const registry = getOrchestratorRegistry();
  let activeSession: import('../orchestrator/orchestrator-session').OrchestratorSession | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        const session = await registry.getOrCreate(projectId);
        activeSession = session;

        send('status', { state: session.getState(), sessionId: session.getSessionId() });

        const url = new URL(req.url);
        const message = url.searchParams.get('message');

        if (!message || message.trim().length === 0) {
          send('history', { messages: session.getHistory() });
          send('done', { reason: 'no_message' });
          return;
        }

        send('ack', { message });

        const response = await session.send(message, (chunk: string) => {
          send('chunk', { text: chunk });
        });

        send('response', { content: response, timestamp: Date.now() });
        send('done', { reason: 'complete' });
      } catch (err) {
        if (closed) return;
        const errorMsg = err instanceof Error ? err.message : 'Internal server error';
        send('error', { message: errorMsg });
      } finally {
        if (!closed) {
          try { controller.close(); } catch {}
        }
      }
    },

    cancel() {
      if (activeSession) {
        activeSession.abort();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

function handleListSessions(): Response {
  try {
    const registry = getOrchestratorRegistry();
    const sessions = registry.listActive();

    return Response.json({
      success: true,
      data: sessions,
    } satisfies ApiResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return errorResponse(message, 500);
  }
}
