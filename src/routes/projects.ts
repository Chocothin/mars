import { ProjectService } from '../projects/service';
import { getRunById, queryRuns } from '../db/run-repo';
import { getTaskByIdGlobal } from '../db/task-repo';
import type {
  CreateProjectInput,
  UpdateProjectInput,
  ProjectQuery,
  ProjectStatus,
} from '../types/project';
import type { ApiResponse, PaginatedResponse } from '../types/common';
import { terminalService } from '../terminal/service';

const service = new ProjectService();

const VALID_STATUSES: ProjectStatus[] = ['active', 'archived'];
const VALID_SORT_BY = ['name', 'createdAt', 'updatedAt'] as const;
const VALID_SORT_ORDER = ['asc', 'desc'] as const;

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { success: false, error: message } satisfies ApiResponse,
    { status },
  );
}

type ProjectRouteSegments = {
  id: string | null;
  action: string | null;
  subAction: string | null;
};

type DagNodeStatus = 'pending' | 'running' | 'completed' | 'failed';

type DagSnapshotPayload = {
  pipeline: {
    runId: string;
    name: string;
    status: string;
    step: number;
    totalSteps: number;
    elapsedMs: number;
  };
  stats: {
    totalTokens: number;
    avgLatencyMs: number;
    estimatedCostUsd: number;
    activeNodes: number;
    totalNodes: number;
  };
  graph: {
    nodes: Array<{
      id: string;
      label: string;
      kind: 'task';
      status: DagNodeStatus;
      x: number;
      y: number;
      progress: number;
      detail: string;
    }>;
    edges: Array<{ from: string; to: string; label: string }>;
  };
  selectedNode: {
    id: string;
    metrics: { tokens: number; latencyMs: number; costUsd: number; steps: number };
    lastInput: string;
    lastOutput: string;
  } | null;
  logs: Array<{ timestamp: number; level: 'info' | 'error'; message: string }>;
};

function extractSegments(pathname: string): ProjectRouteSegments {
  const segments = pathname.replace('/api/projects', '').split('/').filter(Boolean);
  return {
    id: segments[0] ?? null,
    action: segments[1] ?? null,
    subAction: segments[2] ?? null,
  };
}

function mapNodeStatus(value: string | undefined): DagNodeStatus {
  if (value === 'completed') return 'completed';
  if (value === 'failed' || value === 'cancelled' || value === 'skipped') return 'failed';
  if (value === 'running' || value === 'assigned' || value === 'retrying') return 'running';
  return 'pending';
}

export async function handleProjectRoutes(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (!path.startsWith('/api/projects')) {
    return null;
  }

  try {
    if (path === '/api/projects' && method === 'POST') {
      return await handleCreate(req);
    }

    if (path === '/api/projects' && method === 'GET') {
      return await handleList(url);
    }

    const { id, action, subAction } = extractSegments(path);
    if (id) {
      if (!action && method === 'GET') return await handleGetById(id);
      if (!action && method === 'PATCH') return await handleUpdate(id, req);
      if (!action && method === 'DELETE') return await handleDelete(id);
      if (action === 'dag' && method === 'GET') return await handleDagSnapshot(id, url);
    }

    return null;
  } catch (err) {
    return errorResponse(
      err instanceof Error ? err.message : 'Internal server error',
      500,
    );
  }
}

async function handleDagSnapshot(projectId: string, url: URL): Promise<Response> {
  const project = await service.getById(projectId);
  if (!project) {
    return errorResponse('Project not found', 404);
  }

  const requestedRunId = url.searchParams.get('runId');
  const run = requestedRunId
    ? getRunById(requestedRunId)
    : queryRuns({ projectId, sortBy: 'createdAt', sortOrder: 'desc', limit: 1, offset: 0 })[0] ?? null;

  if (!run || run.projectId !== projectId) {
    return errorResponse('Run not found for project', 404);
  }

  const batchCount = run.executionPlan?.batches.length ?? 0;
  const edges = run.executionPlan?.dependencyGraph ?? [];
  const nodeIdSet = new Set<string>();
  for (const edge of edges) {
    nodeIdSet.add(edge.fromTaskId);
    nodeIdSet.add(edge.toTaskId);
  }
  for (const batch of run.executionPlan?.batches ?? []) {
    for (const taskId of batch.taskIds) {
      nodeIdSet.add(taskId);
    }
  }

  const taskExecutions = run.result?.taskResults ?? [];
  const executionByTaskId = new Map(taskExecutions.map((item) => [item.taskId, item]));

  const nodeIds = Array.from(nodeIdSet);
  const graphNodes = nodeIds.map((taskId, index) => {
    const task = getTaskByIdGlobal(taskId);
    const execution = executionByTaskId.get(taskId);
    const status = mapNodeStatus(execution?.status);
    const x = 220 + (index % 4) * 220;
    const y = 140 + Math.floor(index / 4) * 120;
    const progress = status === 'completed' ? 1 : status === 'running' ? 0.5 : 0;
    const detail = execution?.error
      ? execution.error
      : execution?.status ?? task?.status ?? 'pending';

    return {
      id: taskId,
      label: task?.title ?? taskId,
      kind: 'task' as const,
      status,
      x,
      y,
      progress,
      detail,
    };
  });

  const totalTokens = taskExecutions.reduce((sum, item) => sum + (item.output?.tokensUsed ?? 0), 0);
  const estimatedCostUsd = taskExecutions.reduce((sum, item) => sum + (item.output?.costUsd ?? 0), 0);
  const completedDurations = taskExecutions
    .map((item) => item.durationMs)
    .filter((value): value is number => typeof value === 'number' && value >= 0);
  const avgLatencyMs = completedDurations.length > 0
    ? Math.round(completedDurations.reduce((sum, value) => sum + value, 0) / completedDurations.length)
    : 0;
  const activeNodes = graphNodes.filter((node) => node.status === 'running').length;

  const selectedExecution = taskExecutions.find((item) => item.status === 'running') ?? taskExecutions[0] ?? null;
  const selectedNode = selectedExecution
    ? {
      id: selectedExecution.taskId,
      metrics: {
        tokens: selectedExecution.output?.tokensUsed ?? 0,
        latencyMs: selectedExecution.durationMs ?? 0,
        costUsd: selectedExecution.output?.costUsd ?? 0,
        steps: selectedExecution.attempt,
      },
      lastInput: selectedExecution.input.prompt,
      lastOutput: selectedExecution.output?.result ?? selectedExecution.error ?? '',
    }
    : null;

  const logs = taskExecutions.flatMap((execution) => {
    const entries: Array<{ timestamp: number; level: 'info' | 'error'; message: string }> = [];
    if (execution.startedAt) {
      entries.push({
        timestamp: execution.startedAt,
        level: 'info',
        message: `Task ${execution.taskId} started`,
      });
    }
    if (execution.error && execution.completedAt) {
      entries.push({
        timestamp: execution.completedAt,
        level: 'error',
        message: `Task ${execution.taskId} failed: ${execution.error}`,
      });
    } else if (execution.completedAt) {
      entries.push({
        timestamp: execution.completedAt,
        level: 'info',
        message: `Task ${execution.taskId} completed`,
      });
    }
    return entries;
  }).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);

  const payload: DagSnapshotPayload = {
    pipeline: {
      runId: run.id,
      name: project.name,
      status: run.status,
      step: Math.max(1, taskExecutions.filter((item) => item.status === 'completed').length),
      totalSteps: batchCount,
      elapsedMs: run.startedAt ? Date.now() - run.startedAt : 0,
    },
    stats: {
      totalTokens,
      avgLatencyMs,
      estimatedCostUsd,
      activeNodes,
      totalNodes: graphNodes.length,
    },
    graph: {
      nodes: graphNodes,
      edges: edges.map((edge) => ({ from: edge.fromTaskId, to: edge.toTaskId, label: edge.type })),
    },
    selectedNode,
    logs,
  };

  return Response.json({ success: true, data: payload } satisfies ApiResponse<DagSnapshotPayload>);
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
  if (!input.directoryPath || typeof input.directoryPath !== 'string') {
    return errorResponse('directoryPath is required and must be a string', 400);
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    return errorResponse('description must be a string', 400);
  }
  if (input.instructions !== undefined && typeof input.instructions !== 'string') {
    return errorResponse('instructions must be a string', 400);
  }
  if (input.providerId !== undefined && typeof input.providerId !== 'string') {
    return errorResponse('providerId must be a string', 400);
  }
  if (input.agentIds !== undefined) {
    if (!Array.isArray(input.agentIds) || !input.agentIds.every((id) => typeof id === 'string')) {
      return errorResponse('agentIds must be an array of strings', 400);
    }
  }

  const createInput: CreateProjectInput = {
    name: input.name as string,
    directoryPath: input.directoryPath as string,
    description: input.description as string | undefined,
    instructions: input.instructions as string | undefined,
    providerId: input.providerId as string | undefined,
    agentIds: input.agentIds as string[] | undefined,
  };

  const project = await service.create(createInput);

  return Response.json(
    { success: true, data: project } satisfies ApiResponse<typeof project>,
    { status: 201 },
  );
}

async function handleList(url: URL): Promise<Response> {
  const params = url.searchParams;
  const query: ProjectQuery = {};

  const status = params.get('status');
  if (status) {
    if (!VALID_STATUSES.includes(status as ProjectStatus)) {
      return errorResponse(`status must be one of: ${VALID_STATUSES.join(', ')}`, 400);
    }
    query.status = status as ProjectStatus;
  }

  const search = params.get('search');
  if (search) query.search = search;

  const sortBy = params.get('sortBy');
  if (sortBy && (VALID_SORT_BY as readonly string[]).includes(sortBy)) {
    query.sortBy = sortBy as ProjectQuery['sortBy'];
  }

  const sortOrder = params.get('sortOrder');
  if (sortOrder && (VALID_SORT_ORDER as readonly string[]).includes(sortOrder)) {
    query.sortOrder = sortOrder as ProjectQuery['sortOrder'];
  }

  const limit = params.get('limit');
  query.limit = limit ? Math.max(1, Math.min(100, Number(limit) || 50)) : 50;

  const offset = params.get('offset');
  query.offset = offset ? Math.max(0, Number(offset) || 0) : 0;

  const projects = await service.list(query);

  const response: PaginatedResponse<typeof projects[number]> = {
    success: true,
    data: projects,
    total: projects.length,
    limit: query.limit,
    offset: query.offset,
  };

  return Response.json(response);
}

async function handleGetById(id: string): Promise<Response> {
  const project = await service.getById(id);

  if (!project) {
    return errorResponse('Project not found', 404);
  }

  return Response.json({ success: true, data: project } satisfies ApiResponse<typeof project>);
}

async function handleUpdate(id: string, req: Request): Promise<Response> {
  const existing = await service.getById(id);
  if (!existing) {
    return errorResponse('Project not found', 404);
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
  if (input.instructions !== undefined && typeof input.instructions !== 'string') {
    return errorResponse('instructions must be a string', 400);
  }
  if (input.providerId !== undefined && typeof input.providerId !== 'string') {
    return errorResponse('providerId must be a string', 400);
  }
  if (input.status !== undefined) {
    if (typeof input.status !== 'string' || !VALID_STATUSES.includes(input.status as ProjectStatus)) {
      return errorResponse(`status must be one of: ${VALID_STATUSES.join(', ')}`, 400);
    }
  }
  if (input.agentIds !== undefined) {
    if (!Array.isArray(input.agentIds) || !input.agentIds.every((id) => typeof id === 'string')) {
      return errorResponse('agentIds must be an array of strings', 400);
    }
  }
  if (input.mcpServerIds !== undefined) {
    if (!Array.isArray(input.mcpServerIds) || !input.mcpServerIds.every((id) => typeof id === 'string')) {
      return errorResponse('mcpServerIds must be an array of strings', 400);
    }
  }

  const updateInput: UpdateProjectInput = {};
  if (input.name !== undefined) updateInput.name = input.name as string;
  if (input.description !== undefined) updateInput.description = input.description as string;
  if (input.instructions !== undefined) updateInput.instructions = input.instructions as string;
  if (input.providerId !== undefined) updateInput.providerId = input.providerId as string;
  if (input.status !== undefined) updateInput.status = input.status as ProjectStatus;
  if (input.agentIds !== undefined) updateInput.agentIds = input.agentIds as string[];
  if (input.mcpServerIds !== undefined) updateInput.mcpServerIds = input.mcpServerIds as string[];

  const project = await service.update(id, updateInput);

  if (!project) {
    return errorResponse('Project not found', 404);
  }

  const runtimeChanged = JSON.stringify(project.agentIds) !== JSON.stringify(existing.agentIds)
    || JSON.stringify(project.mcpServerIds) !== JSON.stringify(existing.mcpServerIds);

  if (runtimeChanged) {
    await terminalService.markSessionsForProjectChange(
      id,
      `Project "${project.name}" runtime changed. Restart the terminal session to apply the latest project configuration.`,
    );
  }

  return Response.json({ success: true, data: project } satisfies ApiResponse<typeof project>);
}

async function handleDelete(id: string): Promise<Response> {
  const deleted = await service.delete(id);

  if (!deleted) {
    return errorResponse('Project not found', 404);
  }

  return Response.json(
    { success: true, data: { deleted: true } } satisfies ApiResponse<{ deleted: boolean }>,
  );
}
