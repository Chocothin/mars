import { AgentService } from '../agents/service';
import { ProviderService } from '../providers/service';
import { terminalService } from '../terminal/service';
import { providerRegistry } from '../terminal/provider/registry';
import { getAgentPool } from '../orchestrator/factory';
import type {
  Agent,
  CreateAgentInput,
  UpdateAgentInput,
  AgentQuery,
  ReasoningLevel,
} from '../types/agent';
import { REASONING_LEVELS } from '../types/agent';
import type { ApiResponse, PaginatedResponse } from '../types/common';

const service = new AgentService();
const providerService = new ProviderService();

type AgentResponse = Agent & { modelName?: string };

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
  if (segments.length === 4 && segments[1] === 'api' && segments[2] === 'agents') {
    return segments[3] || null;
  }
  return null;
}

async function serializeAgent(agent: Agent): Promise<AgentResponse> {
  let modelName = agent.modelId;

  try {
    const model = await providerService.getModelById(agent.providerId, agent.modelId);
    modelName = model?.name ?? agent.modelId;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('Provider not found')) {
      throw error;
    }
  }

  return {
    ...agent,
    modelName,
  };
}

async function serializeAgents(agents: Agent[]): Promise<AgentResponse[]> {
  return Promise.all(agents.map((agent) => serializeAgent(agent)));
}

export async function handleAgentRoutes(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (!path.startsWith('/api/agents')) {
    return null;
  }

  try {
    if (path === '/api/agents' && method === 'POST') {
      return await handleCreate(req);
    }

    if (path === '/api/agents' && method === 'GET') {
      return await handleList(url);
    }

    if (path === '/api/agents/pool-status' && method === 'GET') {
      return handlePoolStatus();
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
    const status = message.includes('already exists') ? 409
      : message.includes('not found') ? 404
      : message.includes('Invalid') ? 400
      : 500;
    return errorResponse(message, status);
  }
}

function handlePoolStatus(): Response {
  try {
    const pool = getAgentPool();
    const entries = pool.getAll().map((e) => ({
      agentId: e.agentId,
      agentName: e.agentName,
      status: e.status === 'working' ? 'busy' as const : e.status === 'idle' ? 'idle' as const : 'offline' as const,
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
  if (!input.providerId || typeof input.providerId !== 'string') {
    return errorResponse('providerId is required and must be a string', 400);
  }
  if (!input.modelId || typeof input.modelId !== 'string') {
    return errorResponse('modelId is required and must be a string', 400);
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    return errorResponse('description must be a string', 400);
  }
  if (input.systemPrompt !== undefined && typeof input.systemPrompt !== 'string') {
    return errorResponse('systemPrompt must be a string', 400);
  }
  if (input.reasoningLevel !== undefined) {
    if (typeof input.reasoningLevel !== 'string' ||
      !(REASONING_LEVELS as readonly string[]).includes(input.reasoningLevel)) {
      return errorResponse(`reasoningLevel must be one of: ${REASONING_LEVELS.join(', ')}`, 400);
    }
  }
  if (input.workerCount !== undefined) {
    if (typeof input.workerCount !== 'number' || !Number.isInteger(input.workerCount) || input.workerCount < 1) {
      return errorResponse('workerCount must be a positive integer', 400);
    }
  }
  if (input.mcpServerIds !== undefined && !Array.isArray(input.mcpServerIds)) {
    return errorResponse('mcpServerIds must be an array of strings', 400);
  }
  if (input.skillIds !== undefined) {
    if (!Array.isArray(input.skillIds) || !input.skillIds.every((id) => typeof id === 'string')) {
      return errorResponse('skillIds must be an array of strings', 400);
    }
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return errorResponse('enabled must be a boolean', 400);
  }

  const createInput: CreateAgentInput = {
    name: input.name as string,
    providerId: input.providerId as string,
    modelId: input.modelId as string,
    description: input.description as string | undefined,
    systemPrompt: input.systemPrompt as string | undefined,
    reasoningLevel: input.reasoningLevel as ReasoningLevel | undefined,
    workerCount: input.workerCount as number | undefined,
    mcpServerIds: input.mcpServerIds as string[] | undefined,
    skillIds: input.skillIds as string[] | undefined,
    enabled: input.enabled as boolean | undefined,
  };

  const agent = await service.create(createInput);
  const responseAgent = await serializeAgent(agent);

  return Response.json(
    { success: true, data: responseAgent } satisfies ApiResponse<AgentResponse>,
    { status: 201 },
  );
}

async function handleList(url: URL): Promise<Response> {
  const params = url.searchParams;
  const query: AgentQuery = {};

  const providerId = params.get('providerId');
  if (providerId) query.providerId = providerId;

  const modelId = params.get('modelId');
  if (modelId) query.modelId = modelId;

  const reasoningLevel = params.get('reasoningLevel');
  if (reasoningLevel) {
    if (!(REASONING_LEVELS as readonly string[]).includes(reasoningLevel)) {
      return errorResponse(`reasoningLevel must be one of: ${REASONING_LEVELS.join(', ')}`, 400);
    }
    query.reasoningLevel = reasoningLevel as ReasoningLevel;
  }

  const enabled = params.get('enabled');
  if (enabled === 'true') query.enabled = true;
  if (enabled === 'false') query.enabled = false;

  const search = params.get('search');
  if (search) query.search = search;

  const sortBy = params.get('sortBy');
  if (sortBy && (VALID_SORT_BY as readonly string[]).includes(sortBy)) {
    query.sortBy = sortBy as AgentQuery['sortBy'];
  }

  const sortOrder = params.get('sortOrder');
  if (sortOrder && (VALID_SORT_ORDER as readonly string[]).includes(sortOrder)) {
    query.sortOrder = sortOrder as AgentQuery['sortOrder'];
  }

  const limit = params.get('limit');
  query.limit = limit ? Math.max(1, Math.min(100, Number(limit) || 50)) : 50;

  const offset = params.get('offset');
  query.offset = offset ? Math.max(0, Number(offset) || 0) : 0;

  const agents = await service.list(query);
  const responseAgents = await serializeAgents(agents);

  const response: PaginatedResponse<typeof responseAgents[number]> = {
    success: true,
    data: responseAgents,
    total: responseAgents.length,
    limit: query.limit,
    offset: query.offset,
  };

  return Response.json(response);
}

async function handleGetById(id: string): Promise<Response> {
  const agent = await service.getById(id);
  if (!agent) {
    return errorResponse('Agent not found', 404);
  }
  const responseAgent = await serializeAgent(agent);
  return Response.json({ success: true, data: responseAgent } satisfies ApiResponse<AgentResponse>);
}

async function handleUpdate(id: string, req: Request): Promise<Response> {
  const existing = await service.getById(id);
  if (!existing) {
    return errorResponse('Agent not found', 404);
  }

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
  if (input.providerId !== undefined && typeof input.providerId !== 'string') {
    return errorResponse('providerId must be a string', 400);
  }
  if (input.modelId !== undefined && typeof input.modelId !== 'string') {
    return errorResponse('modelId must be a string', 400);
  }
  if (input.systemPrompt !== undefined && typeof input.systemPrompt !== 'string') {
    return errorResponse('systemPrompt must be a string', 400);
  }
  if (input.reasoningLevel !== undefined) {
    if (typeof input.reasoningLevel !== 'string' ||
      !(REASONING_LEVELS as readonly string[]).includes(input.reasoningLevel)) {
      return errorResponse(`reasoningLevel must be one of: ${REASONING_LEVELS.join(', ')}`, 400);
    }
  }
  if (input.workerCount !== undefined) {
    if (typeof input.workerCount !== 'number' || !Number.isInteger(input.workerCount) || input.workerCount < 1) {
      return errorResponse('workerCount must be a positive integer', 400);
    }
  }
  if (input.mcpServerIds !== undefined) {
    if (!Array.isArray(input.mcpServerIds) || !input.mcpServerIds.every((id) => typeof id === 'string')) {
      return errorResponse('mcpServerIds must be an array of strings', 400);
    }
  }
  if (input.skillIds !== undefined) {
    if (!Array.isArray(input.skillIds) || !input.skillIds.every((id) => typeof id === 'string')) {
      return errorResponse('skillIds must be an array of strings', 400);
    }
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return errorResponse('enabled must be a boolean', 400);
  }

  const updateInput: UpdateAgentInput = {};
  if (input.name !== undefined) updateInput.name = input.name as string;
  if (input.description !== undefined) updateInput.description = input.description as string;
  if (input.providerId !== undefined) updateInput.providerId = input.providerId as string;
  if (input.modelId !== undefined) updateInput.modelId = input.modelId as string;
  if (input.systemPrompt !== undefined) updateInput.systemPrompt = input.systemPrompt as string;
  if (input.reasoningLevel !== undefined) updateInput.reasoningLevel = input.reasoningLevel as ReasoningLevel;
  if (input.workerCount !== undefined) updateInput.workerCount = input.workerCount as number;
  if (input.mcpServerIds !== undefined) updateInput.mcpServerIds = input.mcpServerIds as string[];
  if (input.skillIds !== undefined) updateInput.skillIds = input.skillIds as string[];
  if (input.enabled !== undefined) updateInput.enabled = input.enabled as boolean;

  const agent = await service.update(id, updateInput);
  if (!agent) {
    return errorResponse('Agent not found', 404);
  }

  const runtimeChanged = agent.providerId !== existing.providerId
    || agent.modelId !== existing.modelId
    || agent.enabled !== existing.enabled
    || JSON.stringify(agent.mcpServerIds) !== JSON.stringify(existing.mcpServerIds);

  if (runtimeChanged) {
    providerRegistry.invalidateProvider(existing.providerId);
    providerRegistry.invalidateProvider(agent.providerId);
    await terminalService.markSessionsForAgentChange(
      id,
      `Agent "${agent.name}" runtime changed. Restart the terminal session to apply the latest agent configuration.`,
    );
  }

  const responseAgent = await serializeAgent(agent);
  return Response.json({ success: true, data: responseAgent } satisfies ApiResponse<AgentResponse>);
}

async function handleDelete(id: string): Promise<Response> {
  const deleted = await service.delete(id);
  if (!deleted) {
    return errorResponse('Agent not found', 404);
  }

  return Response.json(
    { success: true, data: { deleted: true } } satisfies ApiResponse<{ deleted: boolean }>,
  );
}


