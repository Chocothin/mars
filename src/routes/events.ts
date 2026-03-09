import { eventBus } from '../events/bus';

export async function handleEventRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== '/api/events/stream' || req.method !== 'GET') {
    return null;
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (eventType: string, data: unknown): void => {
        const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          unsubscribe();
        }
      };

      send('connected', { timestamp: Date.now() });

      const unsubscribe = eventBus.onAny((event) => {
        send(event.type, event);
      });

      req.signal.addEventListener('abort', () => {
        unsubscribe();
        try {
          controller.close();
        } catch {}
      });
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
