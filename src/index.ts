import { initDatabase } from './db/index';
import { handleMemoryRoutes } from './routes/memory';
import { handleProjectRoutes } from './routes/projects';
import { handleTaskRoutes } from './routes/tasks';
import { handleMcpServerRoutes } from './routes/mcp-servers';
import { handleProviderRoutes } from './routes/providers';
import { handleAgentRoutes } from './routes/agents';
import { handleSkillRoutes } from './routes/skills';
import { handleTerminalRoutes } from './routes/terminal';
import { handleRunRoutes } from './routes/runs';
import { handleOrchestratorRoutes } from './routes/orchestrator';
import { handleEventRoutes } from './routes/events';
import { handleInteractionRoutes } from './routes/interactions';
import { handleMessageRoutes } from './routes/messages';
import { handleDashboardRoutes } from './routes/dashboard';
import { handleOptionsRoutes } from './routes/options';
import { handleSettingsRoutes } from './routes/settings';
import { handleFilesystemRoutes } from './routes/filesystem';
import { terminalWsHandler } from './terminal/ws-handler';
import type { WsData } from './terminal/ws-handler';
import { randomUUID } from 'node:crypto';
import { RecoveryManager } from './hitl/recovery';
import { getInteractionStore, getInteractionGate } from './orchestrator/factory';
import { eventBus } from './events/bus';

initDatabase();

const recoveryManager = new RecoveryManager({
  gate: getInteractionGate(),
  store: getInteractionStore(),
  eventBus,
});

recoveryManager.recover().then((result) => {
  if (result.recovered > 0 || result.expired > 0 || result.failed > 0) {
    console.log(
      `[HITL Recovery] ${result.recovered} recovered, ${result.expired} expired, ${result.failed} failed`
    );
  }
}).catch((err: unknown) => {
  console.error('[HITL Recovery] Failed:', err);
});

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
] as const;

const allowedOrigins = new Set(
  (process.env.MARS_ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? [])
    .concat([...DEFAULT_ALLOWED_ORIGINS]),
);

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins.has(origin);
}

function getRequestOrigin(req: Request): string | null {
  return req.headers.get('origin');
}

function ensureAllowedOrigin(req: Request): { allowed: true; origin: string | null } | { allowed: false; origin: string } {
  const origin = getRequestOrigin(req);
  if (!origin) {
    return { allowed: true, origin: null };
  }

  if (isAllowedOrigin(origin)) {
    return { allowed: true, origin };
  }

  return { allowed: false, origin };
}

function withCors(req: Request, response: Response): Response {
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    newResponse.headers.set(key, value);
  }

  const origin = getRequestOrigin(req);
  if (origin && isAllowedOrigin(origin)) {
    newResponse.headers.set('Access-Control-Allow-Origin', origin);
    newResponse.headers.set('Vary', 'Origin');
  }

  return newResponse;
}

const server: Bun.Server<WsData> = Bun.serve({
  port: Number(process.env.MARS_PORT) || 3001,
  idleTimeout: 255, // seconds — bootstrap analysis via LLM can take several minutes
  websocket: {
    open(ws: import('bun').ServerWebSocket<WsData>) {
      terminalWsHandler.handleOpen(ws);
    },
    close(ws: import('bun').ServerWebSocket<WsData>) {
      terminalWsHandler.handleClose(ws);
    },
    message(ws: import('bun').ServerWebSocket<WsData>, message: string | Buffer) {
      terminalWsHandler.handleMessage(ws, message);
    },
  },
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const originCheck = ensureAllowedOrigin(req);

    if (!originCheck.allowed) {
      return Response.json({ success: false, error: `Origin not allowed: ${originCheck.origin}` }, { status: 403 });
    }

    if (req.method === 'OPTIONS') {
      return withCors(req, new Response(null, { status: 204 }));
    }

    if (url.pathname === '/ws/terminal') {
      const upgraded = server.upgrade(req, { data: { connectionId: randomUUID() } as WsData });
      if (upgraded) return undefined as unknown as Response;
      return withCors(req, Response.json({ success: false, error: 'WebSocket upgrade failed' }, { status: 400 }));
    }

    if (url.pathname === '/health') {
      return withCors(req, Response.json({ status: 'ok', timestamp: Date.now() }));
    }

    const eventResponse = await handleEventRoutes(req, url);
    if (eventResponse) return withCors(req, eventResponse);

    const interactionResponse = await handleInteractionRoutes(req, url);
    if (interactionResponse) {
      if (interactionResponse.headers.get('Content-Type') === 'text/event-stream') {
        return withCors(req, interactionResponse);
      }
      return withCors(req, interactionResponse);
    }

    const memoryResponse = await handleMemoryRoutes(req, url);
    if (memoryResponse) return withCors(req, memoryResponse);

    const messageResponse = await handleMessageRoutes(req, url);
    if (messageResponse) return withCors(req, messageResponse);

    const runResponse = await handleRunRoutes(req, url);
    if (runResponse) return withCors(req, runResponse);

    const orchestratorResponse = await handleOrchestratorRoutes(req, url);
    if (orchestratorResponse) return withCors(req, orchestratorResponse);

    const dashboardResponse = await handleDashboardRoutes(req, url);
    if (dashboardResponse) return withCors(req, dashboardResponse);

    const settingsResponse = await handleSettingsRoutes(req, url);
    if (settingsResponse) return withCors(req, settingsResponse);

    const optionsResponse = await handleOptionsRoutes(req, url);
    if (optionsResponse) return withCors(req, optionsResponse);

    const filesystemResponse = await handleFilesystemRoutes(req, url);
    if (filesystemResponse) return withCors(req, filesystemResponse);

    const projectResponse = await handleProjectRoutes(req, url);
    if (projectResponse) return withCors(req, projectResponse);

    const taskResponse = await handleTaskRoutes(req, url);
    if (taskResponse) return withCors(req, taskResponse);

    const mcpResponse = await handleMcpServerRoutes(req, url);
    if (mcpResponse) return withCors(req, mcpResponse);

    const providerResponse = await handleProviderRoutes(req, url);
    if (providerResponse) return withCors(req, providerResponse);

    const agentResponse = await handleAgentRoutes(req, url);
    if (agentResponse) return withCors(req, agentResponse);

    const skillResponse = await handleSkillRoutes(req, url);
    if (skillResponse) return withCors(req, skillResponse);

    const terminalResponse = await handleTerminalRoutes(req, url);
    if (terminalResponse) return withCors(req, terminalResponse);

    return withCors(req, Response.json({ success: false, error: 'Not found' }, { status: 404 }));
  },
});

console.log(`🔴 MARS server running on http://localhost:${server.port}`);

const shutdownHandler = () => {
  const { getEngine } = require('./orchestrator/factory') as typeof import('./orchestrator/factory');
  try { getEngine().dispose(); } catch { /* ignore if not initialized */ }
  process.exit(0);
};
process.on('SIGTERM', shutdownHandler);
process.on('SIGINT', shutdownHandler);

// bun --watch does NOT send SIGTERM (bun#25721). Use 'exit' as fallback
// since writeGracefulMarker uses writeFileSync (synchronous).
process.on('exit', () => {
  const { getEngine } = require('./orchestrator/factory') as typeof import('./orchestrator/factory');
  try { getEngine().writeGracefulMarkerSync(); } catch { /* ignore */ }
});
