import { eventBus } from '../events/bus';
import type { AllEvents, HitlEventType } from '../events/types';

const HITL_EVENT_TYPES: HitlEventType[] = [
  'hitl:created',
  'hitl:responded',
  'hitl:timeout',
  'hitl:cancelled',
];

function isHitlEvent(type: string): boolean {
  return (HITL_EVENT_TYPES as string[]).includes(type);
}

interface SseClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  runId: string | null;
}

export class InteractionSSE {
  private clients: Map<string, SseClient>;
  private unsubscribe: (() => void) | null;
  private encoder: TextEncoder;

  constructor() {
    this.clients = new Map();
    this.unsubscribe = null;
    this.encoder = new TextEncoder();
  }

  start(): void {
    if (this.unsubscribe) return;

    this.unsubscribe = eventBus.onAny((event: AllEvents) => {
      if (!isHitlEvent(event.type)) return;
      const hitlEvent = event as AllEvents & { runId?: string };
      this.broadcast(event.type, event, hitlEvent.runId ?? null);
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    for (const [clientId, client] of this.clients.entries()) {
      try {
        client.controller.close();
      } catch {}
      this.clients.delete(clientId);
    }
  }

  createStream(req: Request, runId: string | null): Response {
    const clientId = crypto.randomUUID();

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.clients.set(clientId, { controller, runId });

        this.send(controller, 'connected', {
          clientId,
          timestamp: Date.now(),
          runId,
        });

        req.signal.addEventListener('abort', () => {
          this.clients.delete(clientId);
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
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  getClientCount(): number {
    return this.clients.size;
  }

  private broadcast(eventType: string, data: unknown, eventRunId: string | null): void {
    const stale: string[] = [];

    for (const [clientId, client] of this.clients.entries()) {
      if (client.runId && eventRunId && client.runId !== eventRunId) {
        continue;
      }

      try {
        this.send(client.controller, eventType, data);
      } catch {
        stale.push(clientId);
      }
    }

    for (const clientId of stale) {
      this.clients.delete(clientId);
    }
  }

  private send(
    controller: ReadableStreamDefaultController<Uint8Array>,
    eventType: string,
    data: unknown,
  ): void {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    controller.enqueue(this.encoder.encode(payload));
  }
}

export const interactionSSE = new InteractionSSE();
