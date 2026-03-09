import { getDecomposer } from '../orchestrator/factory';
import type { ProposedSubtask } from '../events/types';
import type { ApiResponse } from '../types/common';

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

  return null;
}

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


