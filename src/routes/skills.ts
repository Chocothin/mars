import { SkillService } from '../skills/service';
import type { CreateSkillInput, UpdateSkillInput, SkillQuery } from '../types/skill';
import type { ApiResponse, PaginatedResponse } from '../types/common';

const service = new SkillService();

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
  if (segments.length === 4 && segments[1] === 'api' && segments[2] === 'skills') {
    return segments[3] || null;
  }
  return null;
}

export async function handleSkillRoutes(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (!path.startsWith('/api/skills')) {
    return null;
  }

  try {
    if (path === '/api/skills' && method === 'POST') {
      return await handleCreate(req);
    }

    if (path === '/api/skills' && method === 'GET') {
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
    const isValidation = message.includes('Skill name must');
    const isConflict = message.includes('already exists');
    const status = isConflict ? 409 : isValidation ? 400 : 500;
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
  if (input.content === undefined || typeof input.content !== 'string') {
    return errorResponse('content is required and must be a string', 400);
  }

  const createInput: CreateSkillInput = {
    name: input.name,
    content: input.content,
  };

  const skill = await service.create(createInput);

  return Response.json(
    { success: true, data: skill } satisfies ApiResponse<typeof skill>,
    { status: 201 },
  );
}

async function handleList(url: URL): Promise<Response> {
  const params = url.searchParams;
  const query: SkillQuery = {};

  const search = params.get('search');
  if (search) query.search = search;

  const sortBy = params.get('sortBy');
  if (sortBy && (VALID_SORT_BY as readonly string[]).includes(sortBy)) {
    query.sortBy = sortBy as SkillQuery['sortBy'];
  }

  const sortOrder = params.get('sortOrder');
  if (sortOrder && (VALID_SORT_ORDER as readonly string[]).includes(sortOrder)) {
    query.sortOrder = sortOrder as SkillQuery['sortOrder'];
  }

  const limit = params.get('limit');
  query.limit = limit ? Math.max(1, Math.min(100, Number(limit) || 50)) : 50;

  const offset = params.get('offset');
  query.offset = offset ? Math.max(0, Number(offset) || 0) : 0;

  const skills = await service.list(query);

  const response: PaginatedResponse<typeof skills[number]> = {
    success: true,
    data: skills,
    total: skills.length,
    limit: query.limit,
    offset: query.offset,
  };

  return Response.json(response);
}

async function handleGetById(id: string): Promise<Response> {
  const skill = await service.getById(id);
  if (!skill) {
    return errorResponse('Skill not found', 404);
  }
  return Response.json({ success: true, data: skill } satisfies ApiResponse<typeof skill>);
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
  if (input.content !== undefined && typeof input.content !== 'string') {
    return errorResponse('content must be a string', 400);
  }

  const updateInput: UpdateSkillInput = {};
  if (input.name !== undefined) updateInput.name = input.name as string;
  if (input.content !== undefined) updateInput.content = input.content as string;

  const skill = await service.update(id, updateInput);
  if (!skill) {
    return errorResponse('Skill not found', 404);
  }

  return Response.json({ success: true, data: skill } satisfies ApiResponse<typeof skill>);
}

async function handleDelete(id: string): Promise<Response> {
  const deleted = await service.delete(id);
  if (!deleted) {
    return errorResponse('Skill not found', 404);
  }

  return Response.json(
    { success: true, data: { deleted: true } } satisfies ApiResponse<{ deleted: boolean }>,
  );
}
