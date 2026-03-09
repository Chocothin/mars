import { ProviderDeletionConflictError, ProviderService } from '../providers/service';
import { ClaudeCliExecutor } from '../providers/claude-cli';
import { CodexCliExecutor } from '../providers/codex-cli';
import { terminalService } from '../terminal/service';
import { providerRegistry } from '../terminal/provider/registry';
import type {
  CreateProviderInput,
  UpdateProviderInput,
  ProviderQuery,
  ProviderType,
  AuthMethod,
  ProviderConnectionResult,
} from '../types/provider';
import { PROVIDER_TYPES, AUTH_METHODS } from '../types/provider';
import type { ApiResponse, PaginatedResponse } from '../types/common';

const service = new ProviderService();
const claudeCliExecutor = new ClaudeCliExecutor();
const codexCliExecutor = new CodexCliExecutor();

const VALID_SORT_BY = ['name', 'createdAt', 'updatedAt'] as const;
const VALID_SORT_ORDER = ['asc', 'desc'] as const;

type ProviderAuthSwitchPayload = {
  method: AuthMethod;
  apiKey?: string | null;
};

type ProviderAuthSwitchResult = {
  provider: Awaited<ReturnType<ProviderService['update']>>;
  authStatus?: ProviderConnectionResult['authStatus'];
};

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { success: false, error: message } satisfies ApiResponse,
    { status },
  );
}

function extractSegments(pathname: string): { id: string | null; action: string | null } {
  const segments = pathname.replace('/api/providers', '').split('/').filter(Boolean);
  return {
    id: segments[0] || null,
    action: segments[1] || null,
  };
}

export async function handleProviderRoutes(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (!path.startsWith('/api/providers')) {
    return null;
  }

  try {
    if (path === '/api/providers' && method === 'POST') {
      return await handleCreate(req);
    }

    if (path === '/api/providers' && method === 'GET') {
      return await handleList(url);
    }

    if (path === '/api/providers/default' && method === 'GET') {
      return await handleGetDefault();
    }

    const { id, action } = extractSegments(path);
    if (id && id !== 'default') {
      if (!action && method === 'GET') return await handleGetById(id);
      if (!action && method === 'PATCH') return await handleUpdate(id, req);
      if (!action && method === 'DELETE') return await handleDelete(id);
      if (action === 'auth' && method === 'POST') return await handleAuthSwitch(id, req);
      if (action === 'test-connection' && method === 'POST') return await handleTestConnection(id);
      if (action === 'models' && method === 'GET') return await handleGetModels(id);
      if (action === 'health' && method === 'GET') return await handleHealthCheck(id);
    }

    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    const status = err instanceof ProviderDeletionConflictError ? err.status
      : message.includes('already exists') ? 409
      : message.includes('not found') ? 404
      : message.includes('not authenticated') ? 409
      : message.includes('Invalid') || message.includes('Only anthropic') ? 400
      : 500;
    return errorResponse(message, status);
  }
}

async function handleAuthSwitch(id: string, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;
  if (!input.method || typeof input.method !== 'string' ||
    !(AUTH_METHODS as readonly string[]).includes(input.method)) {
    return errorResponse(`method is required and must be one of: ${AUTH_METHODS.join(', ')}`, 400);
  }
  if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== 'string') {
    return errorResponse('apiKey must be a string or null', 400);
  }

  const payload: ProviderAuthSwitchPayload = {
    method: input.method as AuthMethod,
    apiKey: input.apiKey as string | null | undefined,
  };

  if (payload.method === 'oauth') {
    const existingProvider = await service.getById(id);
    if (!existingProvider) {
      return errorResponse('Provider not found', 404);
    }

    const authStatus = existingProvider.providerType === 'openai'
      ? await codexCliExecutor.getAuthStatus()
      : await claudeCliExecutor.getAuthStatus();
    if (!authStatus?.loggedIn) {
      const providerLabel = existingProvider.providerType === 'openai' ? 'Codex CLI' : 'Claude Code';
      throw new Error(`${providerLabel} is not authenticated with OAuth`);
    }

    const provider = await service.update(id, {
      authMethod: 'oauth',
      config: {
        useDirectApi: false,
        ...(existingProvider.providerType === 'openai' ? { cliPath: '/usr/local/bin/codex' } : {}),
      },
      apiKey: null,
    });

    if (!provider) {
      return errorResponse('Provider not found', 404);
    }

    providerRegistry.invalidateProvider(id);
    await terminalService.markSessionsForProviderChange(
      id,
      `Provider "${provider.name}" authentication/runtime changed. Restart the terminal session to apply the latest provider configuration.`,
    );

    return Response.json({
      success: true,
      data: { provider, authStatus } satisfies ProviderAuthSwitchResult,
    } satisfies ApiResponse<ProviderAuthSwitchResult>);
  }

  const apiKey = payload.apiKey?.trim();
  const provider = await service.update(id, {
    authMethod: 'api_key',
    config: { useDirectApi: true },
    ...(apiKey ? { apiKey } : {}),
  });

  if (!provider) {
    return errorResponse('Provider not found', 404);
  }

  providerRegistry.invalidateProvider(id);
  await terminalService.markSessionsForProviderChange(
    id,
    `Provider "${provider.name}" authentication/runtime changed. Restart the terminal session to apply the latest provider configuration.`,
  );

  return Response.json({
    success: true,
    data: { provider } satisfies ProviderAuthSwitchResult,
  } satisfies ApiResponse<ProviderAuthSwitchResult>);
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
  if (!input.providerType || typeof input.providerType !== 'string' ||
    !(PROVIDER_TYPES as readonly string[]).includes(input.providerType)) {
    return errorResponse(`providerType is required and must be one of: ${PROVIDER_TYPES.join(', ')}`, 400);
  }
  if (!input.authMethod || typeof input.authMethod !== 'string' ||
    !(AUTH_METHODS as readonly string[]).includes(input.authMethod)) {
    return errorResponse(`authMethod is required and must be one of: ${AUTH_METHODS.join(', ')}`, 400);
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    return errorResponse('description must be a string', 400);
  }
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') {
    return errorResponse('apiKey must be a string', 400);
  }
  if (input.baseUrl !== undefined && typeof input.baseUrl !== 'string') {
    return errorResponse('baseUrl must be a string', 400);
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return errorResponse('enabled must be a boolean', 400);
  }
  if (input.isDefault !== undefined && typeof input.isDefault !== 'boolean') {
    return errorResponse('isDefault must be a boolean', 400);
  }
  if (input.config !== undefined && (typeof input.config !== 'object' || input.config === null || Array.isArray(input.config))) {
    return errorResponse('config must be an object', 400);
  }

  const createInput: CreateProviderInput = {
    name: input.name as string,
    providerType: input.providerType as ProviderType,
    authMethod: input.authMethod as AuthMethod,
    description: input.description as string | undefined,
    apiKey: input.apiKey as string | undefined,
    baseUrl: input.baseUrl as string | undefined,
    enabled: input.enabled as boolean | undefined,
    isDefault: input.isDefault as boolean | undefined,
    config: input.config as CreateProviderInput['config'],
  };

  const provider = await service.create(createInput);

  return Response.json(
    { success: true, data: provider } satisfies ApiResponse<typeof provider>,
    { status: 201 },
  );
}

async function handleList(url: URL): Promise<Response> {
  const params = url.searchParams;
  const query: ProviderQuery = {};

  const providerType = params.get('providerType');
  if (providerType) {
    if (!(PROVIDER_TYPES as readonly string[]).includes(providerType)) {
      return errorResponse(`providerType must be one of: ${PROVIDER_TYPES.join(', ')}`, 400);
    }
    query.providerType = providerType as ProviderType;
  }

  const authMethod = params.get('authMethod');
  if (authMethod) {
    if (!(AUTH_METHODS as readonly string[]).includes(authMethod)) {
      return errorResponse(`authMethod must be one of: ${AUTH_METHODS.join(', ')}`, 400);
    }
    query.authMethod = authMethod as AuthMethod;
  }

  const enabled = params.get('enabled');
  if (enabled === 'true') query.enabled = true;
  if (enabled === 'false') query.enabled = false;

  const search = params.get('search');
  if (search) query.search = search;

  const sortBy = params.get('sortBy');
  if (sortBy && (VALID_SORT_BY as readonly string[]).includes(sortBy)) {
    query.sortBy = sortBy as ProviderQuery['sortBy'];
  }

  const sortOrder = params.get('sortOrder');
  if (sortOrder && (VALID_SORT_ORDER as readonly string[]).includes(sortOrder)) {
    query.sortOrder = sortOrder as ProviderQuery['sortOrder'];
  }

  const limit = params.get('limit');
  query.limit = limit ? Math.max(1, Math.min(100, Number(limit) || 50)) : 50;

  const offset = params.get('offset');
  query.offset = offset ? Math.max(0, Number(offset) || 0) : 0;

  const providers = await service.list(query);

  const response: PaginatedResponse<typeof providers[number]> = {
    success: true,
    data: providers,
    total: providers.length,
    limit: query.limit,
    offset: query.offset,
  };

  return Response.json(response);
}

async function handleGetById(id: string): Promise<Response> {
  const provider = await service.getById(id);
  if (!provider) {
    return errorResponse('Provider not found', 404);
  }
  return Response.json({ success: true, data: provider } satisfies ApiResponse<typeof provider>);
}

async function handleGetDefault(): Promise<Response> {
  const provider = await service.getDefault();
  if (!provider) {
    return errorResponse('No default provider set', 404);
  }
  return Response.json({ success: true, data: provider } satisfies ApiResponse<typeof provider>);
}

async function handleUpdate(id: string, req: Request): Promise<Response> {
  const existing = await service.getById(id);
  if (!existing) {
    return errorResponse('Provider not found', 404);
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
  if (input.providerType !== undefined) {
    if (typeof input.providerType !== 'string' ||
      !(PROVIDER_TYPES as readonly string[]).includes(input.providerType)) {
      return errorResponse(`providerType must be one of: ${PROVIDER_TYPES.join(', ')}`, 400);
    }
  }
  if (input.authMethod !== undefined) {
    if (typeof input.authMethod !== 'string' ||
      !(AUTH_METHODS as readonly string[]).includes(input.authMethod)) {
      return errorResponse(`authMethod must be one of: ${AUTH_METHODS.join(', ')}`, 400);
    }
  }
  if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== 'string') {
    return errorResponse('apiKey must be a string or null', 400);
  }
  if (input.baseUrl !== undefined && input.baseUrl !== null && typeof input.baseUrl !== 'string') {
    return errorResponse('baseUrl must be a string or null', 400);
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return errorResponse('enabled must be a boolean', 400);
  }
  if (input.isDefault !== undefined && typeof input.isDefault !== 'boolean') {
    return errorResponse('isDefault must be a boolean', 400);
  }
  if (input.config !== undefined && (typeof input.config !== 'object' || input.config === null || Array.isArray(input.config))) {
    return errorResponse('config must be an object', 400);
  }

  const updateInput: UpdateProviderInput = {};
  if (input.name !== undefined) updateInput.name = input.name as string;
  if (input.description !== undefined) updateInput.description = input.description as string;
  if (input.providerType !== undefined) updateInput.providerType = input.providerType as ProviderType;
  if (input.authMethod !== undefined) updateInput.authMethod = input.authMethod as AuthMethod;
  if (input.apiKey !== undefined) updateInput.apiKey = input.apiKey as string | null;
  if (input.baseUrl !== undefined) updateInput.baseUrl = input.baseUrl as string | null;
  if (input.enabled !== undefined) updateInput.enabled = input.enabled as boolean;
  if (input.isDefault !== undefined) updateInput.isDefault = input.isDefault as boolean;
  if (input.config !== undefined) updateInput.config = input.config as UpdateProviderInput['config'];

  const provider = await service.update(id, updateInput);
  if (!provider) {
    return errorResponse('Provider not found', 404);
  }

  const runtimeChanged = provider.providerType !== existing.providerType
    || provider.authMethod !== existing.authMethod
    || provider.enabled !== existing.enabled
    || provider.config.useDirectApi !== existing.config.useDirectApi
    || provider.config.cliPath !== existing.config.cliPath
    || provider.config.defaultModel !== existing.config.defaultModel
    || provider.config.permissionMode !== existing.config.permissionMode
    || JSON.stringify(provider.config.customArgs ?? []) !== JSON.stringify(existing.config.customArgs ?? []);

  if (runtimeChanged) {
    providerRegistry.invalidateProvider(id);
    await terminalService.markSessionsForProviderChange(
      id,
      `Provider "${provider.name}" runtime changed. Restart the terminal session to apply the latest provider configuration.`,
    );
  }

  return Response.json({ success: true, data: provider } satisfies ApiResponse<typeof provider>);
}

async function handleDelete(id: string): Promise<Response> {
  const deleted = await service.delete(id);
  if (!deleted) {
    return errorResponse('Provider not found', 404);
  }

  providerRegistry.invalidateProvider(id);

  return Response.json(
    { success: true, data: { deleted: true } } satisfies ApiResponse<{ deleted: boolean }>,
  );
}

async function handleTestConnection(id: string): Promise<Response> {
  const result = await service.testConnection(id);
  return Response.json({ success: true, data: result } satisfies ApiResponse<typeof result>);
}

async function handleGetModels(id: string): Promise<Response> {
  const models = await service.getModels(id);
  return Response.json({ success: true, data: models } satisfies ApiResponse<typeof models>);
}

async function handleHealthCheck(id: string): Promise<Response> {
  const result = await service.checkHealth(id);
  return Response.json({ success: true, data: result } satisfies ApiResponse<typeof result>);
}
