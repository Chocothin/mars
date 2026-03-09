import { MemoryStorage } from '../memory/storage';
import { MemoryCompactor } from '../memory/compactor';
import { getStats } from '../db/memory-index';
import type {
  CreateMemoryFileInput,
  UpdateMemoryFileInput,
  MemoryQuery,
  MemoryTier,
} from '../types/memory';
import type { ApiResponse, PaginatedResponse } from '../types/common';

const storage = new MemoryStorage();
const compactor = new MemoryCompactor();

const VALID_TIERS: MemoryTier[] = ['global', 'project', 'agent'];
const VALID_SORT_BY = ['createdAt', 'updatedAt', 'lastAccessedAt', 'sizeBytes', 'tokenCount'] as const;
const VALID_SORT_ORDER = ['asc', 'desc'] as const;

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { success: false, error: message } satisfies ApiResponse,
    { status },
  );
}

function extractIdFromPath(pathname: string): string | null {
  const segments = pathname.split('/');
  if (segments.length === 4 && segments[1] === 'api' && segments[2] === 'memory') {
    return segments[3] || null;
  }
  return null;
}

export async function handleMemoryRoutes(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (!path.startsWith('/api/memory')) {
    return null;
  }

  try {
    if (path === '/api/memory/stats' && method === 'GET') {
      return handleGetStats(url);
    }

    if (path === '/api/memory/compact/estimate' && method === 'POST') {
      return await handleCompactEstimate(req);
    }

    if (path === '/api/memory/compact/targets' && method === 'GET') {
      return await handleCompactTargets(url);
    }

    if (path === '/api/memory/compact' && method === 'POST') {
      return await handleCompact(req);
    }

    if (path === '/api/memory' && method === 'POST') {
      return await handleCreate(req);
    }

    if (path === '/api/memory' && method === 'GET') {
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
    return errorResponse(
      err instanceof Error ? err.message : 'Internal server error',
      500,
    );
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

  if (!input.tier || typeof input.tier !== 'string') {
    return errorResponse('tier is required and must be a string', 400);
  }
  if (!VALID_TIERS.includes(input.tier as MemoryTier)) {
    return errorResponse(`tier must be one of: ${VALID_TIERS.join(', ')}`, 400);
  }
  if (!input.scope || typeof input.scope !== 'string') {
    return errorResponse('scope is required and must be a string', 400);
  }
  if (!input.filename || typeof input.filename !== 'string') {
    return errorResponse('filename is required and must be a string', 400);
  }
  if (!input.content || typeof input.content !== 'string') {
    return errorResponse('content is required and must be a string', 400);
  }
  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    return errorResponse('tags must be an array of strings', 400);
  }

  const createInput: CreateMemoryFileInput = {
    tier: input.tier as MemoryTier,
    scope: input.scope as string,
    filename: input.filename as string,
    content: input.content as string,
    tags: input.tags as string[] | undefined,
  };

  const file = await storage.createFile(createInput);

  return Response.json(
    { success: true, data: file } satisfies ApiResponse<typeof file>,
    { status: 201 },
  );
}

async function handleList(url: URL): Promise<Response> {
  const params = url.searchParams;

  const query: MemoryQuery = {};

  const tier = params.get('tier');
  if (tier) {
    if (!VALID_TIERS.includes(tier as MemoryTier)) {
      return errorResponse(`tier must be one of: ${VALID_TIERS.join(', ')}`, 400);
    }
    query.tier = tier as MemoryTier;
  }

  const scope = params.get('scope');
  if (scope) query.scope = scope;

  const tags = params.get('tags');
  if (tags) query.tags = tags.split(',').map((t) => t.trim()).filter(Boolean);

  const search = params.get('search');
  if (search) query.search = search;

  const isProtected = params.get('isProtected');
  if (isProtected === 'true') query.isProtected = true;
  else if (isProtected === 'false') query.isProtected = false;

  const sortBy = params.get('sortBy');
  if (sortBy && (VALID_SORT_BY as readonly string[]).includes(sortBy)) {
    query.sortBy = sortBy as MemoryQuery['sortBy'];
  }

  const sortOrder = params.get('sortOrder');
  if (sortOrder && (VALID_SORT_ORDER as readonly string[]).includes(sortOrder)) {
    query.sortOrder = sortOrder as MemoryQuery['sortOrder'];
  }

  const limit = params.get('limit');
  query.limit = limit ? Math.max(1, Math.min(100, Number(limit) || 50)) : 50;

  const offset = params.get('offset');
  query.offset = offset ? Math.max(0, Number(offset) || 0) : 0;

  const files = await storage.listFiles(query);

  // TODO: Implement proper total count via a separate COUNT query in queryFiles.
  // Currently returning result length which doesn't reflect total matching records for pagination.
  const response: PaginatedResponse<typeof files[number]> = {
    success: true,
    data: files,
    total: files.length,
    limit: query.limit,
    offset: query.offset,
  };

  return Response.json(response);
}

async function handleGetById(id: string): Promise<Response> {
  const file = await storage.readFile(id);

  if (!file) {
    return errorResponse('Memory file not found', 404);
  }

  return Response.json({ success: true, data: file } satisfies ApiResponse<typeof file>);
}

async function handleUpdate(id: string, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;

  if (input.content !== undefined && typeof input.content !== 'string') {
    return errorResponse('content must be a string', 400);
  }
  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    return errorResponse('tags must be an array of strings', 400);
  }
  if (input.filename !== undefined && typeof input.filename !== 'string') {
    return errorResponse('filename must be a string', 400);
  }

  const updateInput: UpdateMemoryFileInput = {};
  if (input.content !== undefined) updateInput.content = input.content as string;
  if (input.tags !== undefined) updateInput.tags = input.tags as string[];
  if (input.filename !== undefined) updateInput.filename = input.filename as string;

  const file = await storage.updateFile(id, updateInput);

  if (!file) {
    return errorResponse('Memory file not found', 404);
  }

  return Response.json({ success: true, data: file } satisfies ApiResponse<typeof file>);
}

async function handleDelete(id: string): Promise<Response> {
  const deleted = await storage.deleteFile(id);

  if (!deleted) {
    return errorResponse('Memory file not found', 404);
  }

  return Response.json(
    { success: true, data: { deleted: true } } satisfies ApiResponse<{ deleted: boolean }>,
  );
}

async function handleCompactTargets(url: URL): Promise<Response> {
  const params = url.searchParams;

  const tier = params.get('tier');
  if (!tier || !VALID_TIERS.includes(tier as MemoryTier)) {
    return errorResponse(`tier is required and must be one of: ${VALID_TIERS.join(', ')}`, 400);
  }

  const scope = params.get('scope');
  if (!scope) {
    return errorResponse('scope is required', 400);
  }

  const maxTokensParam = params.get('maxTokens');
  if (!maxTokensParam) {
    return errorResponse('maxTokens is required', 400);
  }

  const maxTokens = Number(maxTokensParam);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return errorResponse('maxTokens must be a positive number', 400);
  }

  const targets = await compactor.identifyTargets(tier as MemoryTier, scope, maxTokens);

  return Response.json({ success: true, data: targets } satisfies ApiResponse<typeof targets>);
}

async function handleCompactEstimate(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;

  if (!input.fileIds || !Array.isArray(input.fileIds)) {
    return errorResponse('fileIds is required and must be an array of strings', 400);
  }

  const fileIds = input.fileIds as string[];
  if (fileIds.some((id) => typeof id !== 'string')) {
    return errorResponse('All fileIds must be strings', 400);
  }

  const estimate = await compactor.estimateCompaction(fileIds);

  return Response.json({ success: true, data: estimate } satisfies ApiResponse<typeof estimate>);
}

async function handleCompact(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;

  if (!input.fileIds || !Array.isArray(input.fileIds)) {
    return errorResponse('fileIds is required and must be an array of strings', 400);
  }

  const fileIds = input.fileIds as string[];
  if (fileIds.some((id) => typeof id !== 'string')) {
    return errorResponse('All fileIds must be strings', 400);
  }

  const result = await compactor.compact(fileIds);

  return Response.json({ success: true, data: result } satisfies ApiResponse<typeof result>);
}

function handleGetStats(url: URL): Response {
  const params = url.searchParams;

  const tier = params.get('tier');
  if (tier && !VALID_TIERS.includes(tier as MemoryTier)) {
    return errorResponse(`tier must be one of: ${VALID_TIERS.join(', ')}`, 400);
  }

  const scope = params.get('scope') ?? undefined;

  const stats = getStats(
    tier ? (tier as MemoryTier) : undefined,
    scope,
  );

  return Response.json({ success: true, data: stats } satisfies ApiResponse<typeof stats>);
}
