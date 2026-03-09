import { MessageService } from '../messaging/service';
import type { MessageType } from '../messaging/types';
import type { ApiResponse } from '../types/common';

const VALID_MESSAGE_TYPES: MessageType[] = [
  'dm',
  'broadcast',
  'task_assignment',
  'shutdown',
  'plan_approval',
  'idle_notification',
  'review_feedback',
];

const service = new MessageService();

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { success: false, error: message } satisfies ApiResponse,
    { status },
  );
}

export async function handleMessageRoutes(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (!path.startsWith('/api/messages')) {
    return null;
  }

  try {
    if (path === '/api/messages' && method === 'POST') {
      return await handleSend(req);
    }

    if (path === '/api/messages' && method === 'GET') {
      return await handleList(url);
    }

    if (path === '/api/messages/unread' && method === 'GET') {
      return await handleGetUnread(url);
    }

    if (path === '/api/messages/read-all' && method === 'POST') {
      return await handleMarkAllRead(req);
    }

    if (path === '/api/messages/cleanup' && method === 'DELETE') {
      return await handleCleanup(req);
    }

    const readMatch = path.match(/^\/api\/messages\/([^/]+)\/read$/);
    if (readMatch && method === 'POST') {
      return await handleMarkRead(readMatch[1]!, req);
    }

    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return errorResponse(message, 500);
  }
}

async function handleSend(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;

  if (!input.runId || typeof input.runId !== 'string') {
    return errorResponse('runId is required and must be a string', 400);
  }
  if (!input.from || typeof input.from !== 'string') {
    return errorResponse('from is required and must be a string', 400);
  }
  if (!input.to || typeof input.to !== 'string') {
    return errorResponse('to is required and must be a string', 400);
  }
  if (!input.type || typeof input.type !== 'string' || !VALID_MESSAGE_TYPES.includes(input.type as MessageType)) {
    return errorResponse(`type is required and must be one of: ${VALID_MESSAGE_TYPES.join(', ')}`, 400);
  }
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    return errorResponse('payload is required and must be an object', 400);
  }

  const message = service.send({
    runId: input.runId,
    from: input.from,
    to: input.to,
    type: input.type as MessageType,
    payload: input.payload as Record<string, unknown>,
  });

  return Response.json(
    { success: true, data: message } satisfies ApiResponse<typeof message>,
    { status: 201 },
  );
}

async function handleList(url: URL): Promise<Response> {
  const params = url.searchParams;
  const agentId = params.get('agentId');
  const runId = params.get('runId');
  const typeParam = params.get('type');

  if (typeParam && !VALID_MESSAGE_TYPES.includes(typeParam as MessageType)) {
    return errorResponse(`type must be one of: ${VALID_MESSAGE_TYPES.join(', ')}`, 400);
  }

  const messages = service.getAll({
    to: agentId ?? undefined,
    runId: runId ?? undefined,
    type: (typeParam ?? undefined) as MessageType | undefined,
  });

  return Response.json(
    { success: true, data: messages } satisfies ApiResponse<typeof messages>,
  );
}

async function handleGetUnread(url: URL): Promise<Response> {
  const params = url.searchParams;

  const agentId = params.get('agentId');
  if (!agentId) {
    return errorResponse('agentId is required', 400);
  }

  const runId = params.get('runId');
  const messages = service.getUnread(agentId, runId ?? undefined);

  return Response.json(
    { success: true, data: messages } satisfies ApiResponse<typeof messages>,
  );
}

async function handleMarkRead(messageId: string, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;

  if (!input.agentId || typeof input.agentId !== 'string') {
    return errorResponse('agentId is required and must be a string', 400);
  }

  const success = service.markRead(messageId, input.agentId);

  if (!success) {
    return errorResponse('Message not found', 404);
  }

  return Response.json(
    { success: true, data: { success: true } } satisfies ApiResponse<{ success: boolean }>,
  );
}

async function handleMarkAllRead(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;

  if (!input.agentId || typeof input.agentId !== 'string') {
    return errorResponse('agentId is required and must be a string', 400);
  }

  const runId = typeof input.runId === 'string' ? input.runId : undefined;
  const count = service.markAllRead(input.agentId, runId);

  return Response.json(
    { success: true, data: { count } } satisfies ApiResponse<{ count: number }>,
  );
}

async function handleCleanup(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;

  if (typeof input.ageMs !== 'number' || input.ageMs < 0) {
    return errorResponse('ageMs is required and must be a non-negative number', 400);
  }

  const deleted = service.deleteOlderThan(input.ageMs);

  return Response.json(
    { success: true, data: { deleted } } satisfies ApiResponse<{ deleted: number }>,
  );
}
