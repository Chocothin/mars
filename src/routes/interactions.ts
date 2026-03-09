import { InteractionAPI } from '../hitl/interaction-api';
import { interactionSSE } from '../hitl/interaction-sse';
import { getInteractionStore, getInteractionGate } from '../orchestrator/factory';

let apiInstance: InteractionAPI | null = null;

function getApi(): InteractionAPI {
  if (!apiInstance) {
    apiInstance = new InteractionAPI({ store: getInteractionStore(), gate: getInteractionGate() });
    interactionSSE.start();
  }
  return apiInstance;
}

function extractInteractionId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/interactions\/([^/]+)$/);
  return match?.[1] ?? null;
}

function extractInteractionIdWithAction(pathname: string, action: string): string | null {
  const pattern = new RegExp(`^/api/interactions/([^/]+)/${action}$`);
  const match = pathname.match(pattern);
  return match?.[1] ?? null;
}

export async function handleInteractionRoutes(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (!path.startsWith('/api/interactions')) {
    return null;
  }

  try {
    if (path === '/api/interactions/stream' && method === 'GET') {
      const runId = url.searchParams.get('runId');
      return interactionSSE.createStream(req, runId);
    }

    if (path === '/api/interactions' && method === 'GET') {
      return await getApi().handleList(url);
    }

    const respondId = extractInteractionIdWithAction(path, 'respond');
    if (respondId && method === 'POST') {
      return await getApi().handleRespond(respondId, req);
    }

    const id = extractInteractionId(path);
    if (id && method === 'GET') {
      return await getApi().handleGet(id);
    }

    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return Response.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
