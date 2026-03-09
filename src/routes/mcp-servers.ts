import { McpServerService } from '../mcp-servers/service';
import type {
  CreateMcpServerInput,
  UpdateMcpServerInput,
  McpServerQuery,
  TransportType,
} from '../types/mcp-server';
import { TRANSPORT_TYPES } from '../types/mcp-server';
import type { ApiResponse, PaginatedResponse } from '../types/common';
import { mcpConnectionPool } from '../mcp/pool';
import type { McpServer } from '../types/mcp-server';
import { terminalService } from '../terminal/service';

const service = new McpServerService();

const VALID_SORT_BY = ['name', 'createdAt', 'updatedAt'] as const;
const VALID_SORT_ORDER = ['asc', 'desc'] as const;

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { success: false, error: message } satisfies ApiResponse,
    { status },
  );
}

function extractIdFromPath(pathname: string): string | null {
  const segments = pathname.split('/');
  if (segments.length === 4 && segments[1] === 'api' && segments[2] === 'mcp-servers') {
    return segments[3] || null;
  }
  return null;
}

function redactSecrets(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(values).map((key) => [key, '[REDACTED]']));
}

function sanitizeMcpServer(server: McpServer): McpServer {
  return {
    ...server,
    headers: redactSecrets(server.headers),
    env: redactSecrets(server.env),
  };
}

export async function handleMcpServerRoutes(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (!path.startsWith('/api/mcp-servers')) {
    return null;
  }

  try {
    if (path === '/api/mcp-servers' && method === 'POST') {
      return await handleCreate(req);
    }

    if (path === '/api/mcp-servers' && method === 'GET') {
      return await handleList(url);
    }

    const id = extractIdFromPath(path);
    if (id) {
      if (method === 'GET') return await handleGetById(id);
      if (method === 'PATCH') return await handleUpdate(id, req);
      if (method === 'DELETE') return await handleDelete(id);
    }

    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    const status = message.includes('already exists') ? 409 : 500;
    return errorResponse(message, status);
  }
}

async function handleCreate(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;

  if (!input.name || typeof input.name !== 'string') {
    return errorResponse('name is required and must be a string', 400);
  }
  if (!input.transportType || typeof input.transportType !== 'string' ||
    !(TRANSPORT_TYPES as readonly string[]).includes(input.transportType)) {
    return errorResponse(`transportType is required and must be one of: ${TRANSPORT_TYPES.join(', ')}`, 400);
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    return errorResponse('description must be a string', 400);
  }
  if (input.command !== undefined && typeof input.command !== 'string') {
    return errorResponse('command must be a string', 400);
  }
  if (input.args !== undefined && !Array.isArray(input.args)) {
    return errorResponse('args must be an array of strings', 400);
  }
  if (input.url !== undefined && typeof input.url !== 'string') {
    return errorResponse('url must be a string', 400);
  }
  if (input.headers !== undefined && (typeof input.headers !== 'object' || input.headers === null || Array.isArray(input.headers))) {
    return errorResponse('headers must be an object', 400);
  }
  if (input.env !== undefined && (typeof input.env !== 'object' || input.env === null || Array.isArray(input.env))) {
    return errorResponse('env must be an object', 400);
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return errorResponse('enabled must be a boolean', 400);
  }

  const createInput: CreateMcpServerInput = {
    name: input.name as string,
    transportType: input.transportType as TransportType,
    description: input.description as string | undefined,
    command: input.command as string | undefined,
    args: input.args as string[] | undefined,
    url: input.url as string | undefined,
    headers: input.headers as Record<string, string> | undefined,
    env: input.env as Record<string, string> | undefined,
    enabled: input.enabled as boolean | undefined,
  };

  const server = await service.create(createInput);

  return Response.json(
    { success: true, data: sanitizeMcpServer(server) } satisfies ApiResponse<typeof server>,
    { status: 201 },
  );
}

async function handleList(url: URL): Promise<Response> {
  const params = url.searchParams;
  const query: McpServerQuery = {};

  const transportType = params.get('transportType');
  if (transportType) {
    if (!(TRANSPORT_TYPES as readonly string[]).includes(transportType)) {
      return errorResponse(`transportType must be one of: ${TRANSPORT_TYPES.join(', ')}`, 400);
    }
    query.transportType = transportType as TransportType;
  }

  const enabled = params.get('enabled');
  if (enabled === 'true') query.enabled = true;
  if (enabled === 'false') query.enabled = false;

  const search = params.get('search');
  if (search) query.search = search;

  const sortBy = params.get('sortBy');
  if (sortBy && (VALID_SORT_BY as readonly string[]).includes(sortBy)) {
    query.sortBy = sortBy as McpServerQuery['sortBy'];
  }

  const sortOrder = params.get('sortOrder');
  if (sortOrder && (VALID_SORT_ORDER as readonly string[]).includes(sortOrder)) {
    query.sortOrder = sortOrder as McpServerQuery['sortOrder'];
  }

  const limit = params.get('limit');
  query.limit = limit ? Math.max(1, Math.min(100, Number(limit) || 50)) : 50;

  const offset = params.get('offset');
  query.offset = offset ? Math.max(0, Number(offset) || 0) : 0;

  const servers = (await service.list(query)).map(sanitizeMcpServer);

  const response: PaginatedResponse<typeof servers[number]> = {
    success: true,
    data: servers,
    total: servers.length,
    limit: query.limit,
    offset: query.offset,
  };

  return Response.json(response);
}

async function handleGetById(id: string): Promise<Response> {
  const server = await service.getById(id);
  if (!server) {
    return errorResponse('MCP server not found', 404);
  }
  return Response.json({ success: true, data: sanitizeMcpServer(server) } satisfies ApiResponse<typeof server>);
}

async function handleUpdate(id: string, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;

  if (input.name !== undefined && typeof input.name !== 'string') {
    return errorResponse('name must be a string', 400);
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    return errorResponse('description must be a string', 400);
  }
  if (input.transportType !== undefined) {
    if (typeof input.transportType !== 'string' ||
      !(TRANSPORT_TYPES as readonly string[]).includes(input.transportType)) {
      return errorResponse(`transportType must be one of: ${TRANSPORT_TYPES.join(', ')}`, 400);
    }
  }
  if (input.command !== undefined && input.command !== null && typeof input.command !== 'string') {
    return errorResponse('command must be a string or null', 400);
  }
  if (input.args !== undefined && !Array.isArray(input.args)) {
    return errorResponse('args must be an array of strings', 400);
  }
  if (input.url !== undefined && input.url !== null && typeof input.url !== 'string') {
    return errorResponse('url must be a string or null', 400);
  }
  if (input.headers !== undefined && (typeof input.headers !== 'object' || input.headers === null || Array.isArray(input.headers))) {
    return errorResponse('headers must be an object', 400);
  }
  if (input.env !== undefined && (typeof input.env !== 'object' || input.env === null || Array.isArray(input.env))) {
    return errorResponse('env must be an object', 400);
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return errorResponse('enabled must be a boolean', 400);
  }

  const updateInput: UpdateMcpServerInput = {};
  if (input.name !== undefined) updateInput.name = input.name as string;
  if (input.description !== undefined) updateInput.description = input.description as string;
  if (input.transportType !== undefined) updateInput.transportType = input.transportType as TransportType;
  if (input.command !== undefined) updateInput.command = input.command as string | null;
  if (input.args !== undefined) updateInput.args = input.args as string[];
  if (input.url !== undefined) updateInput.url = input.url as string | null;
  if (input.headers !== undefined) updateInput.headers = input.headers as Record<string, string>;
  if (input.env !== undefined) updateInput.env = input.env as Record<string, string>;
  if (input.enabled !== undefined) updateInput.enabled = input.enabled as boolean;

  const server = await service.update(id, updateInput);
  if (!server) {
    return errorResponse('MCP server not found', 404);
  }

  await mcpConnectionPool.invalidate(id);
  await terminalService.markSessionsForMcpServerChange(
    id,
    `MCP server \"${server.name}\" changed. Restart the terminal session to apply the latest MCP configuration.`,
  );

  return Response.json({ success: true, data: sanitizeMcpServer(server) } satisfies ApiResponse<typeof server>);
}

async function handleDelete(id: string): Promise<Response> {
  const existing = await service.getById(id);
  if (!existing) {
    return errorResponse('MCP server not found', 404);
  }

  const deleted = await service.delete(id);
  if (!deleted) {
    return errorResponse('MCP server not found', 404);
  }

  await mcpConnectionPool.invalidate(id);
  await terminalService.markSessionsForMcpServerChange(
    id,
    `MCP server \"${existing.name}\" was removed. Restart the terminal session before continuing.`,
  );

  return Response.json(
    { success: true, data: { deleted: true } } satisfies ApiResponse<{ deleted: boolean }>,
  );
}
