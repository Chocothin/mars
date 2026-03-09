import { getSettings, updateSettings } from '../db/settings-repo';
import type { ApiResponse } from '../types/common';

function errorResponse(message: string, status: number): Response {
  return Response.json({ success: false, error: message } satisfies ApiResponse, { status });
}

export async function handleSettingsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== '/api/settings') return null;

  if (req.method === 'GET') {
    try {
      const data = getSettings();
      return Response.json({ success: true, data } satisfies ApiResponse<typeof data>);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return errorResponse(message, 500);
    }
  }

  if (req.method === 'PATCH') {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      const data = updateSettings(body);
      return Response.json({ success: true, data } satisfies ApiResponse<typeof data>);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return errorResponse(message, 500);
    }
  }

  return null;
}
