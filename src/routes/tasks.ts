import { TaskService } from '../tasks/service';
import { getTaskByIdGlobal, queryTasksGlobal } from '../db/task-repo';
import { getAgentById } from '../db/agent-repo';
import type {
  CreateTaskInput,
  UpdateTaskInput,
  TaskQuery,
  TaskPriority,
} from '../types/task';
import type { TaskStatus } from '../types/project';
import { KANBAN_COLUMNS } from '../types/project';
import type { ApiResponse, PaginatedResponse } from '../types/common';

const service = new TaskService();
type TaskWithAssignedAgentName = { assignedAgentId: string | null; assignedAgentName: string | null };

function serializeTask<T extends { assignedAgentId: string | null }>(task: T): T & TaskWithAssignedAgentName {
  const agent = task.assignedAgentId ? getAgentById(task.assignedAgentId) : null;
  return {
    ...task,
    assignedAgentName: agent?.name ?? null,
  };
}

function serializeTasks<T extends { assignedAgentId: string | null }>(tasks: T[]): Array<T & TaskWithAssignedAgentName> {
  return tasks.map((task) => serializeTask(task));
}

const VALID_PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const VALID_SORT_BY = ['order', 'createdAt', 'updatedAt', 'priority'] as const;
const VALID_SORT_ORDER = ['asc', 'desc'] as const;

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { success: false, error: message } satisfies ApiResponse,
    { status },
  );
}

interface TaskRouteMatch {
  projectId: string;
  taskId?: string;
  subResource?: 'dependencies' | 'assignment';
  depTaskId?: string;
}

function matchTaskRoute(pathname: string): TaskRouteMatch | null {
  const segments = pathname.split('/');

  if (segments.length === 5 && segments[1] === 'api' && segments[2] === 'projects' && segments[4] === 'tasks') {
    return { projectId: segments[3]! };
  }
  if (segments.length === 6 && segments[1] === 'api' && segments[2] === 'projects' && segments[4] === 'tasks') {
    return { projectId: segments[3]!, taskId: segments[5] || undefined };
  }
  if (segments.length === 7 && segments[1] === 'api' && segments[2] === 'projects' && segments[4] === 'tasks' && segments[6] === 'dependencies') {
    return { projectId: segments[3]!, taskId: segments[5]!, subResource: 'dependencies' };
  }
  if (segments.length === 7 && segments[1] === 'api' && segments[2] === 'projects' && segments[4] === 'tasks' && segments[6] === 'assignment') {
    return { projectId: segments[3]!, taskId: segments[5]!, subResource: 'assignment' };
  }
  if (segments.length === 8 && segments[1] === 'api' && segments[2] === 'projects' && segments[4] === 'tasks' && segments[6] === 'dependencies') {
    return { projectId: segments[3]!, taskId: segments[5]!, subResource: 'dependencies', depTaskId: segments[7]! };
  }
  return null;
}

export async function handleTaskRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    return await handleGlobalList(url);
  }

  if (url.pathname.match(/^\/api\/tasks\/[^/]+$/) && req.method === 'GET') {
    const taskId = url.pathname.split('/')[3];
    if (!taskId) {
      return errorResponse('Task id is required', 400);
    }
    return await handleGlobalGetById(taskId);
  }

  const match = matchTaskRoute(url.pathname);
  if (!match) return null;

  const method = req.method;

  try {
    if (match.subResource === 'dependencies' && match.taskId) {
      if (method === 'GET' && !match.depTaskId) return await handleGetDependencies(match.projectId, match.taskId);
      if (method === 'POST' && !match.depTaskId) return await handleAddDependency(match.projectId, match.taskId, req);
      if (method === 'DELETE' && match.depTaskId) return await handleRemoveDependency(match.projectId, match.taskId, match.depTaskId);
      return null;
    }

    if (match.subResource === 'assignment' && match.taskId) {
      if (method === 'GET') return await handleGetAssignment(match.projectId, match.taskId);
      if (method === 'PUT') return await handleSetAssignment(match.projectId, match.taskId, req);
      if (method === 'DELETE') return await handleClearAssignment(match.projectId, match.taskId);
      return null;
    }

    if (!match.taskId) {
      if (method === 'POST') return await handleCreate(match.projectId, req);
      if (method === 'GET') return await handleList(match.projectId, url);
      return null;
    }

    if (method === 'GET') return await handleGetById(match.projectId, match.taskId);
    if (method === 'PATCH') return await handleUpdate(match.projectId, match.taskId, req);
    if (method === 'DELETE') return await handleDelete(match.projectId, match.taskId);

    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    if (message.includes('not found')) return errorResponse(message, 404);
    if (message.includes('Circular dependency')) return errorResponse(message, 409);
    if (message.includes('cannot depend on itself')) return errorResponse(message, 400);
    if (message.includes('Dependency not found')) return errorResponse(message, 404);
    if (message.includes('is not assigned to project')) return errorResponse(message, 400);
    return errorResponse(message, 500);
  }
}

function parseTaskQuery(url: URL): TaskQuery | Response {
  const params = url.searchParams;
  const query: TaskQuery = {};

  const status = params.get('status');
  if (status) {
    if (!(KANBAN_COLUMNS as readonly string[]).includes(status)) {
      return errorResponse(`status must be one of: ${KANBAN_COLUMNS.join(', ')}`, 400);
    }
    query.status = status as TaskStatus;
  }

  const priority = params.get('priority');
  if (priority) {
    if (!VALID_PRIORITIES.includes(priority as TaskPriority)) {
      return errorResponse(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`, 400);
    }
    query.priority = priority as TaskPriority;
  }

  const parentTaskId = params.get('parentTaskId');
  if (parentTaskId === 'null') {
    query.parentTaskId = null;
  } else if (parentTaskId) {
    query.parentTaskId = parentTaskId;
  }

  const assignedAgentType = params.get('assignedAgentType');
  if (assignedAgentType) query.assignedAgentType = assignedAgentType;

  const assignedAgentId = params.get('assignedAgentId');
  if (assignedAgentId) {
    const agent = getAgentById(assignedAgentId);
    if (!agent) {
      return errorResponse('assignedAgentId must reference an existing agent', 400);
    }
    query.assignedAgentId = assignedAgentId;
  }

  const search = params.get('search');
  if (search) query.search = search;

  const sortBy = params.get('sortBy');
  if (sortBy && (VALID_SORT_BY as readonly string[]).includes(sortBy)) {
    query.sortBy = sortBy as TaskQuery['sortBy'];
  }

  const sortOrder = params.get('sortOrder');
  if (sortOrder && (VALID_SORT_ORDER as readonly string[]).includes(sortOrder)) {
    query.sortOrder = sortOrder as TaskQuery['sortOrder'];
  }

  const limit = params.get('limit');
  query.limit = limit ? Math.max(1, Math.min(200, Number(limit) || 100)) : 100;

  const offset = params.get('offset');
  query.offset = offset ? Math.max(0, Number(offset) || 0) : 0;

  return query;
}

async function handleCreate(projectId: string, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;

  if (!input.title || typeof input.title !== 'string') {
    return errorResponse('title is required and must be a string', 400);
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    return errorResponse('description must be a string', 400);
  }
  if (input.status !== undefined) {
    if (typeof input.status !== 'string' || !(KANBAN_COLUMNS as readonly string[]).includes(input.status)) {
      return errorResponse(`status must be one of: ${KANBAN_COLUMNS.join(', ')}`, 400);
    }
  }
  if (input.priority !== undefined) {
    if (typeof input.priority !== 'string' || !VALID_PRIORITIES.includes(input.priority as TaskPriority)) {
      return errorResponse(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`, 400);
    }
  }
  if (input.parentTaskId !== undefined && typeof input.parentTaskId !== 'string') {
    return errorResponse('parentTaskId must be a string', 400);
  }
  if (input.assignedAgentType !== undefined && !Array.isArray(input.assignedAgentType)) {
    return errorResponse('assignedAgentType must be an array of strings', 400);
  }
  if (input.assignedAgentId !== undefined && typeof input.assignedAgentId !== 'string') {
    return errorResponse('assignedAgentId must be a string', 400);
  }
  if (input.dependsOnTaskIds !== undefined) {
    if (!Array.isArray(input.dependsOnTaskIds) || !input.dependsOnTaskIds.every((id: unknown) => typeof id === 'string')) {
      return errorResponse('dependsOnTaskIds must be an array of strings', 400);
    }
  }

  const createInput: CreateTaskInput = {
    title: input.title as string,
    description: input.description as string | undefined,
    status: input.status as TaskStatus | undefined,
    priority: input.priority as TaskPriority | undefined,
    parentTaskId: input.parentTaskId as string | undefined,
    assignedAgentType: input.assignedAgentType as string[] | undefined,
    assignedAgentId: input.assignedAgentId as string | undefined,
    dependsOnTaskIds: input.dependsOnTaskIds as string[] | undefined,
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria as string[] : undefined,
    expectedOutputs: Array.isArray(input.expectedOutputs) ? input.expectedOutputs as string[] : undefined,
    maxRetries: typeof input.maxRetries === 'number' ? input.maxRetries : undefined,
  };

  const task = await service.create(projectId, createInput);

  return Response.json(
    { success: true, data: serializeTask(task) } satisfies ApiResponse<typeof task & TaskWithAssignedAgentName>,
    { status: 201 },
  );
}

async function handleList(projectId: string, url: URL): Promise<Response> {
  const parsed = parseTaskQuery(url);
  if (parsed instanceof Response) return parsed;
  const query = parsed;

  const tasks = serializeTasks(await service.list(projectId, query));

  const response: PaginatedResponse<typeof tasks[number]> = {
    success: true,
    data: tasks,
    total: tasks.length,
    limit: query.limit ?? 100,
    offset: query.offset ?? 0,
  };

  return Response.json(response);
}

async function handleGlobalList(url: URL): Promise<Response> {
  const parsed = parseTaskQuery(url);
  if (parsed instanceof Response) return parsed;

  const projectId = url.searchParams.get('projectId');
  const tasks = serializeTasks(queryTasksGlobal({ ...parsed, projectId: projectId || undefined }));

  const response: PaginatedResponse<typeof tasks[number]> = {
    success: true,
    data: tasks,
    total: tasks.length,
    limit: parsed.limit ?? 100,
    offset: parsed.offset ?? 0,
  };

  return Response.json(response);
}

async function handleGlobalGetById(taskId: string): Promise<Response> {
  const task = getTaskByIdGlobal(taskId);
  if (!task) {
    return errorResponse('Task not found', 404);
  }
  return Response.json({ success: true, data: serializeTask(task) } satisfies ApiResponse<typeof task & TaskWithAssignedAgentName>);
}

async function handleGetById(projectId: string, taskId: string): Promise<Response> {
  const task = await service.getById(projectId, taskId);
  if (!task) {
    return errorResponse('Task not found', 404);
  }
  return Response.json({ success: true, data: serializeTask(task) } satisfies ApiResponse<typeof task & TaskWithAssignedAgentName>);
}

async function handleUpdate(projectId: string, taskId: string, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;

  if (input.title !== undefined && typeof input.title !== 'string') {
    return errorResponse('title must be a string', 400);
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    return errorResponse('description must be a string', 400);
  }
  if (input.status !== undefined) {
    if (typeof input.status !== 'string' || !(KANBAN_COLUMNS as readonly string[]).includes(input.status)) {
      return errorResponse(`status must be one of: ${KANBAN_COLUMNS.join(', ')}`, 400);
    }
  }
  if (input.priority !== undefined) {
    if (typeof input.priority !== 'string' || !VALID_PRIORITIES.includes(input.priority as TaskPriority)) {
      return errorResponse(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`, 400);
    }
  }
  if (input.order !== undefined && (typeof input.order !== 'number' || !Number.isInteger(input.order))) {
    return errorResponse('order must be an integer', 400);
  }
  if (input.assignedAgentType !== undefined && input.assignedAgentType !== null && !Array.isArray(input.assignedAgentType)) {
    return errorResponse('assignedAgentType must be an array of strings or null', 400);
  }
  if (input.assignedAgentId !== undefined && input.assignedAgentId !== null && typeof input.assignedAgentId !== 'string') {
    return errorResponse('assignedAgentId must be a string or null', 400);
  }

  const updateInput: UpdateTaskInput = {};
  if (input.title !== undefined) updateInput.title = input.title as string;
  if (input.description !== undefined) updateInput.description = input.description as string;
  if (input.status !== undefined) updateInput.status = input.status as TaskStatus;
  if (input.priority !== undefined) updateInput.priority = input.priority as TaskPriority;
  if (input.order !== undefined) updateInput.order = input.order as number;
  if (input.assignedAgentType !== undefined) updateInput.assignedAgentType = input.assignedAgentType as string[] | null;
  if (input.assignedAgentId !== undefined) updateInput.assignedAgentId = input.assignedAgentId as string | null;
  if (Array.isArray(input.acceptanceCriteria)) updateInput.acceptanceCriteria = input.acceptanceCriteria as string[];
  if (Array.isArray(input.expectedOutputs)) updateInput.expectedOutputs = input.expectedOutputs as string[];
  if (typeof input.maxRetries === 'number') updateInput.maxRetries = input.maxRetries;
  if (typeof input.retryCount === 'number') updateInput.retryCount = input.retryCount;
  if (input.reviewFeedback !== undefined) updateInput.reviewFeedback = input.reviewFeedback as string | null;

  const result = await service.update(projectId, taskId, updateInput);
  if (!result) {
    return errorResponse('Task not found', 404);
  }

  return Response.json({
    success: true,
    data: serializeTask(result.task),
    warnings: result.warnings.length > 0 ? result.warnings : undefined,
    autoTransitioned: result.autoTransitioned.length > 0 ? result.autoTransitioned : undefined,
  });
}

async function handleDelete(projectId: string, taskId: string): Promise<Response> {
  const deleted = await service.delete(projectId, taskId);
  if (!deleted) {
    return errorResponse('Task not found', 404);
  }

  return Response.json(
    { success: true, data: { deleted: true } } satisfies ApiResponse<{ deleted: boolean }>,
  );
}

async function handleGetDependencies(projectId: string, taskId: string): Promise<Response> {
  const deps = await service.getDependencies(projectId, taskId);
  return Response.json({ success: true, data: deps } satisfies ApiResponse<typeof deps>);
}

async function handleAddDependency(projectId: string, taskId: string, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;
  if (!input.dependsOnTaskId || typeof input.dependsOnTaskId !== 'string') {
    return errorResponse('dependsOnTaskId is required and must be a string', 400);
  }

  await service.addDependency(projectId, taskId, input.dependsOnTaskId as string);

  const task = await service.getById(projectId, taskId);
  return Response.json(
    { success: true, data: task ? serializeTask(task) : task } satisfies ApiResponse<(NonNullable<typeof task> & TaskWithAssignedAgentName) | null>,
    { status: 201 },
  );
}

async function handleRemoveDependency(projectId: string, taskId: string, depTaskId: string): Promise<Response> {
  await service.removeDependency(projectId, taskId, depTaskId);

  const task = await service.getById(projectId, taskId);
  return Response.json({ success: true, data: task ? serializeTask(task) : task } satisfies ApiResponse<(NonNullable<typeof task> & TaskWithAssignedAgentName) | null>);
}

async function handleGetAssignment(projectId: string, taskId: string): Promise<Response> {
  const task = await service.getById(projectId, taskId);
  if (!task) {
    return errorResponse('Task not found', 404);
  }

  const agent = task.assignedAgentId ? getAgentById(task.assignedAgentId) : null;
  return Response.json({
    success: true,
    data: {
      taskId: task.id,
      assignedAgentId: task.assignedAgentId,
      agent,
    },
  } satisfies ApiResponse);
}

async function handleSetAssignment(projectId: string, taskId: string, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const input = body as Record<string, unknown>;
  if (!input.agentId || typeof input.agentId !== 'string') {
    return errorResponse('agentId is required and must be a string', 400);
  }

  const task = await service.assignAgent(projectId, taskId, input.agentId);
  if (!task) {
    return errorResponse('Task not found', 404);
  }

  return Response.json({ success: true, data: serializeTask(task) } satisfies ApiResponse<typeof task & TaskWithAssignedAgentName>);
}

async function handleClearAssignment(projectId: string, taskId: string): Promise<Response> {
  const task = await service.clearAssignedAgent(projectId, taskId);
  if (!task) {
    return errorResponse('Task not found', 404);
  }

  return Response.json({ success: true, data: serializeTask(task) } satisfies ApiResponse<typeof task & TaskWithAssignedAgentName>);
}


