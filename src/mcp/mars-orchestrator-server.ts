#!/usr/bin/env bun
process.env.MARS_MCP_MODE = '1';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { initDatabase } from '../db/index';
import { getProjectById, updateProject } from '../db/project-repo';
import { getTaskById, getTaskByIdGlobal } from '../db/task-repo';
import { getAgentById } from '../db/agent-repo';
import { getMcpServerById } from '../db/mcp-server-repo';
import { queryRuns } from '../db/run-repo';
import { ProjectService } from '../projects/service';
import { TaskService } from '../tasks/service';
import { AgentService } from '../agents/service';
import { getEngine, getInteractionGate, getInteractionStore } from '../orchestrator/factory';
import { MessageService } from '../messaging/service';
import type { ProjectStatus, TaskStatus } from '../types/project';
import type { TaskPriority, UpdateTaskInput } from '../types/task';
import type { AgentQuery, ReasoningLevel } from '../types/agent';
import type { InteractionStatus, ResponseAction } from '../hitl/types';
import { KANBAN_COLUMNS } from '../types/project';
import { REASONING_LEVELS } from '../types/agent';

initDatabase();

const envProjectId = process.env.MARS_PROJECT_ID;
if (!envProjectId) {
  throw new Error('MARS_PROJECT_ID is required for mars-orchestrator MCP server');
}
const boundProjectId = envProjectId;

const projectService = new ProjectService();
const taskService = new TaskService();
const agentService = new AgentService();
const engine = getEngine();
const interactionStore = getInteractionStore();
const interactionGate = getInteractionGate();
const messageService = new MessageService();

const PROJECT_STATUSES = ['active', 'archived'] as const satisfies readonly ProjectStatus[];
const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const satisfies readonly TaskPriority[];
const RUN_STATUSES = ['pending', 'decomposing', 'scheduling', 'running', 'reviewing', 'paused', 'completed', 'failed', 'cancelled'] as const;
const INTERACTION_STATUSES = ['pending', 'responded', 'timeout', 'cancelled'] as const satisfies readonly InteractionStatus[];
const RESPONSE_ACTIONS = ['approve', 'reject', 'modify', 'answer', 'skip', 'cancel'] as const satisfies readonly ResponseAction[];

function jsonResult<T extends object>(data: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function getProjectOrThrow(projectId: string) {
  if (projectId !== boundProjectId) {
    throw new Error(`Project scope violation: ${projectId}`);
  }

  const project = getProjectById(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  return project;
}

function getTaskOrThrow(projectId: string, taskId: string) {
  const task = getTaskById(projectId, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return task;
}

function getAgentOrThrow(agentId: string) {
  const agent = getAgentById(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const project = getProjectOrThrow(boundProjectId);
  if (!project.agentIds.includes(agentId)) {
    throw new Error(`Agent not found in project ${boundProjectId}: ${agentId}`);
  }

  return agent;
}

function getTaskGlobalInScopeOrThrow(taskId: string) {
  const task = getTaskByIdGlobal(taskId);
  if (!task || task.projectId !== boundProjectId) {
    throw new Error(`Task not found in project ${boundProjectId}: ${taskId}`);
  }
  return task;
}

async function getRunInScopeOrThrow(runId: string) {
  const run = await engine.getRunStatus(runId);
  if (run.projectId !== boundProjectId) {
    throw new Error(`Run not found in project ${boundProjectId}: ${runId}`);
  }
  return run;
}

function ensureScopeProjectId(projectId?: string): string {
  if (projectId && projectId !== boundProjectId) {
    throw new Error(`Project scope violation: ${projectId}`);
  }
  return boundProjectId;
}

async function getProjectContext(projectId: string) {
  const project = getProjectOrThrow(projectId);
  const agents = project.agentIds
    .map((agentId) => getAgentById(agentId))
    .filter((agent): agent is NonNullable<typeof agent> => agent !== null);
  const mcpServers = project.mcpServerIds
    .map((serverId) => getMcpServerById(serverId))
    .filter((server): server is NonNullable<typeof server> => server !== null);
  const runs = await engine.listRuns({ projectId });

  return {
    project,
    agents,
    mcpServers,
    recentRuns: runs.slice(0, 10),
  };
}

async function listInteractions(runId?: string, status?: InteractionStatus) {
  if (runId) {
    await getRunInScopeOrThrow(runId);
  }

  const interactions = runId
    ? await interactionStore.getByRunId(runId)
    : await interactionStore.list(status);

  if (runId && status) {
    return interactions.filter((interaction) => interaction.status === status);
  }

  if (runId) {
    return interactions;
  }

  const scopedInteractions = [];
  for (const interaction of interactions) {
    const run = await engine.getRunStatus(interaction.runId);
    if (run.projectId === boundProjectId) {
      scopedInteractions.push(interaction);
    }
  }

  return scopedInteractions;
}

const server = new McpServer({
  name: 'mars-orchestrator',
  version: '1.0.0',
});

server.registerTool('project_list', {
  description: 'List projects available to the orchestrator.',
  inputSchema: {
    status: z.enum(PROJECT_STATUSES).optional(),
    search: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (args) => {
  const project = getProjectOrThrow(boundProjectId);
  const matchesStatus = !args.status || project.status === args.status;
  const search = args.search?.toLowerCase();
  const matchesSearch = !search
    || project.name.toLowerCase().includes(search)
    || project.description.toLowerCase().includes(search);
  const projects = matchesStatus && matchesSearch ? [project] : [];
  return jsonResult({ projects });
});

server.registerTool('project_get', {
  description: 'Get a single project by id.',
  inputSchema: { projectId: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ projectId }) => jsonResult({ project: getProjectOrThrow(projectId) }));

server.registerTool('project_get_context', {
  description: 'Get project execution context with agents, MCP servers, and recent runs.',
  inputSchema: { projectId: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ projectId }) => jsonResult(await getProjectContext(projectId)));

server.registerTool('task_list', {
  description: 'List tasks for a project.',
  inputSchema: {
    projectId: z.string().min(1),
    status: z.enum(KANBAN_COLUMNS).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    parentTaskId: z.string().nullable().optional(),
    assignedAgentType: z.string().optional(),
    assignedAgentId: z.string().optional(),
    search: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (args) => {
  const projectId = ensureScopeProjectId(args.projectId);
  const { projectId: _projectId, ...query } = args;
  const tasks = await taskService.list(projectId, query);
  return jsonResult({ tasks });
});

server.registerTool('task_get', {
  description: 'Get a single task by id.',
  inputSchema: { taskId: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ taskId }) => {
  const task = getTaskGlobalInScopeOrThrow(taskId);
  return jsonResult({ task });
});

server.registerTool('task_create', {
  description: 'Create a new task in a project.',
  inputSchema: {
    projectId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    status: z.enum(KANBAN_COLUMNS).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    parentTaskId: z.string().optional(),
    assignedAgentType: z.string().optional(),
    assignedAgentId: z.string().optional(),
    dependsOnTaskIds: z.array(z.string()).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ projectId, ...input }) => {
  const scopedProjectId = ensureScopeProjectId(projectId);
  const existing = await taskService.list(scopedProjectId, { limit: 51 });
  if (existing.length >= 50) {
    throw new Error('Project has 50 tasks (maximum). Complete or delete tasks first.');
  }
  return jsonResult({ task: await taskService.create(scopedProjectId, input) });
});

server.registerTool('task_update', {
  description: 'Update an existing task.',
  inputSchema: {
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    patch: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(KANBAN_COLUMNS).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      order: z.number().int().optional(),
      assignedAgentType: z.string().nullable().optional(),
      assignedAgentId: z.string().nullable().optional(),
    }),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ projectId, taskId, patch }) => {
  const result = await taskService.update(ensureScopeProjectId(projectId), taskId, patch as UpdateTaskInput);
  if (!result) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return jsonResult({
    task: result.task,
    warnings: result.warnings,
    autoTransitioned: result.autoTransitioned,
  });
});

server.registerTool('task_delete', {
  description: 'Delete a task from a project.',
  inputSchema: { projectId: z.string().min(1), taskId: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ projectId, taskId }) => jsonResult({ deleted: await taskService.delete(ensureScopeProjectId(projectId), taskId) }));

server.registerTool('task_get_dependencies', {
  description: 'List upstream dependencies for a task.',
  inputSchema: { projectId: z.string().min(1), taskId: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ projectId, taskId }) => jsonResult({ dependencies: await taskService.getDependencies(ensureScopeProjectId(projectId), taskId) }));

server.registerTool('task_add_dependency', {
  description: 'Add a dependency edge to a task.',
  inputSchema: {
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    dependsOnTaskId: z.string().min(1),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ projectId, taskId, dependsOnTaskId }) => {
  const scopedProjectId = ensureScopeProjectId(projectId);
  await taskService.addDependency(scopedProjectId, taskId, dependsOnTaskId);
  return jsonResult({ task: getTaskOrThrow(scopedProjectId, taskId) });
});

server.registerTool('task_remove_dependency', {
  description: 'Remove a dependency edge from a task.',
  inputSchema: {
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    dependsOnTaskId: z.string().min(1),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ projectId, taskId, dependsOnTaskId }) => {
  const scopedProjectId = ensureScopeProjectId(projectId);
  await taskService.removeDependency(scopedProjectId, taskId, dependsOnTaskId);
  return jsonResult({ task: getTaskOrThrow(scopedProjectId, taskId) });
});

server.registerTool('agent_list', {
  description: 'List agents assigned to this project.',
  inputSchema: {
    providerId: z.string().optional(),
    modelId: z.string().optional(),
    reasoningLevel: z.enum(REASONING_LEVELS).optional(),
    enabled: z.boolean().optional(),
    search: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (args) => {
  const project = getProjectOrThrow(boundProjectId);
  const agents = (await agentService.list(args as AgentQuery & { reasoningLevel?: ReasoningLevel }))
    .filter((agent) => project.agentIds.includes(agent.id));
  return jsonResult({ agents });
});

server.registerTool('agent_list_global', {
  description: 'List ALL enabled agents in the system, not just project-scoped. Use to discover specialists to add to the project.',
  inputSchema: {
    search: z.string().optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (args) => {
  const project = getProjectOrThrow(boundProjectId);
  const agents = await agentService.list({ enabled: true, search: args.search });
  return jsonResult({
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      reasoningLevel: a.reasoningLevel,
      workerCount: a.workerCount,
      assignedToProject: project.agentIds.includes(a.id),
    })),
  });
});

server.registerTool('project_add_agent', {
  description: 'Add an agent to this project. Required before assigning the agent to tasks.',
  inputSchema: {
    agentId: z.string().min(1),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ agentId }) => {
  const agent = getAgentById(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  if (!agent.enabled) throw new Error(`Agent is disabled: ${agentId}`);

  const project = getProjectOrThrow(boundProjectId);

  const MAX_AGENTS = 10;
  if (project.agentIds.length >= MAX_AGENTS) {
    throw new Error(`Project already has ${MAX_AGENTS} agents (maximum). Remove an agent first.`);
  }

  if (project.agentIds.includes(agentId)) {
    return jsonResult({ alreadyAssigned: true, agentId });
  }

  updateProject(boundProjectId, {
    agentIds: [...project.agentIds, agentId],
  });

  return jsonResult({ added: true, agentId, agent: { id: agent.id, name: agent.name } });
});

server.registerTool('agent_get', {
  description: 'Get a single agent by id.',
  inputSchema: { agentId: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ agentId }) => jsonResult({ agent: getAgentOrThrow(agentId) }));

server.registerTool('assignment_get', {
  description: 'Get the current persistent agent assignment for a task.',
  inputSchema: { projectId: z.string().min(1), taskId: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ projectId, taskId }) => {
  const task = getTaskOrThrow(ensureScopeProjectId(projectId), taskId);
  return jsonResult({
    taskId: task.id,
    assignedAgentId: task.assignedAgentId,
    agent: task.assignedAgentId ? getAgentOrThrow(task.assignedAgentId) : null,
  });
});

server.registerTool('assignment_set', {
  description: 'Persistently assign a concrete agent to a task.',
  inputSchema: { projectId: z.string().min(1), taskId: z.string().min(1), agentId: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ projectId, taskId, agentId }) => {
  const task = await taskService.assignAgent(ensureScopeProjectId(projectId), taskId, agentId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return jsonResult({ task: { id: task.id, assignedAgentId: task.assignedAgentId } });
});

server.registerTool('task_assign_agent', {
  description: 'Alias for assignment_set using spec naming.',
  inputSchema: { projectId: z.string().min(1), taskId: z.string().min(1), agentId: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ projectId, taskId, agentId }) => {
  const task = await taskService.assignAgent(ensureScopeProjectId(projectId), taskId, agentId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return jsonResult({ task: { id: task.id, assignedAgentId: task.assignedAgentId } });
});

server.registerTool('assignment_clear', {
  description: 'Clear the persistent agent assignment for a task.',
  inputSchema: { projectId: z.string().min(1), taskId: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ projectId, taskId }) => {
  const task = await taskService.clearAssignedAgent(ensureScopeProjectId(projectId), taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return jsonResult({ task: { id: task.id, assignedAgentId: task.assignedAgentId } });
});

server.registerTool('run_create', {
  description: 'Create a project-scoped orchestration run. Limited to 1 active run per project.',
  inputSchema: {
    projectId: z.string().min(1),
    taskIds: z.array(z.string()).min(1),
    config: z.object({
      maxConcurrency: z.number().int().positive().optional(),
      maxRetries: z.number().int().min(0).optional(),
      timeoutMs: z.number().int().positive().optional(),
      taskTimeoutMs: z.number().int().positive().optional(),
      autoReview: z.boolean().optional(),
      requireHumanApproval: z.boolean().optional(),
    }).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ projectId, taskIds, config }) => {
  const scopedProjectId = ensureScopeProjectId(projectId);
  const activeRuns = queryRuns({ projectId: scopedProjectId, status: 'running' });
  const pendingRuns = queryRuns({ projectId: scopedProjectId, status: 'pending' });
  if (activeRuns.length + pendingRuns.length >= 2) {
    throw new Error(`Project already has ${activeRuns.length} running and ${pendingRuns.length} pending runs. Cancel or complete existing runs before creating new ones.`);
  }
  return jsonResult({ run: await engine.createRun(scopedProjectId, taskIds, config) });
});

server.registerTool('run_list', {
  description: 'List runs for a project, optionally filtered by status.',
  inputSchema: {
    projectId: z.string().min(1).optional(),
    status: z.enum(RUN_STATUSES).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ projectId, status, limit, offset }) => jsonResult({
  runs: await engine.listRuns({
    projectId: ensureScopeProjectId(projectId),
    status,
    limit,
    offset,
  }),
}));

server.registerTool('run_get', {
  description: 'Get a single run.',
  inputSchema: { runId: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ runId }) => jsonResult({ run: await getRunInScopeOrThrow(runId) }));

server.registerTool('run_start', {
  description: 'Start a pending run asynchronously.',
  inputSchema: { runId: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ runId }) => {
  const run = await getRunInScopeOrThrow(runId);
  if (run.status !== 'pending') {
    throw new Error(`Cannot start run in status '${run.status}'`);
  }
  engine.startRun(runId).catch((error) => {
    console.error(`[MCP mars-orchestrator] Run ${runId} failed:`, error);
  });
  return jsonResult({ accepted: true, runId });
});

server.registerTool('run_pause', {
  description: 'Pause a run.',
  inputSchema: { runId: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ runId }) => {
  await getRunInScopeOrThrow(runId);
  await engine.pauseRun(runId);
  return jsonResult({ accepted: true, runId });
});

server.registerTool('run_resume', {
  description: 'Resume a paused run.',
  inputSchema: { runId: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ runId }) => {
  await getRunInScopeOrThrow(runId);
  await engine.resumeRun(runId);
  return jsonResult({ accepted: true, runId });
});

server.registerTool('run_cancel', {
  description: 'Cancel a run.',
  inputSchema: { runId: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ runId }) => {
  await getRunInScopeOrThrow(runId);
  await engine.cancelRun(runId);
  return jsonResult({ accepted: true, runId });
});

server.registerTool('run_poll', {
  description: 'Poll a run until it completes, fails, or has pending HITL interactions. Returns immediately on terminal state.',
  inputSchema: {
    runId: z.string().min(1),
    intervalMs: z.number().int().min(1000).max(30000).optional(),
    maxWaitMs: z.number().int().min(5000).max(300000).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ runId, intervalMs = 3000, maxWaitMs = 60000 }) => {
  const startTime = Date.now();

  while (true) {
    const run = await getRunInScopeOrThrow(runId);

    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      return jsonResult({ run, reason: 'terminal_state' });
    }

    const pending = await listInteractions(runId, 'pending');
    if (pending.length > 0) {
      return jsonResult({ run, pendingInteractions: pending, reason: 'hitl_pending' });
    }

    if (Date.now() - startTime >= maxWaitMs) {
      return jsonResult({ run, reason: 'timeout' });
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
});

server.registerTool('interaction_list', {
  description: 'List HITL interactions, optionally filtered by run and status.',
  inputSchema: {
    runId: z.string().optional(),
    status: z.enum(INTERACTION_STATUSES).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ runId, status }) => jsonResult({ interactions: await listInteractions(runId, status) }));

server.registerTool('interaction_get', {
  description: 'Get a single HITL interaction.',
  inputSchema: { interactionId: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ interactionId }) => {
  const interaction = await interactionStore.getById(interactionId);
  if (!interaction) {
    throw new Error(`Interaction not found: ${interactionId}`);
  }
  await getRunInScopeOrThrow(interaction.runId);
  return jsonResult({ interaction });
});

server.registerTool('interaction_respond', {
  description: 'Respond to a pending HITL approval interaction.',
  inputSchema: {
    interactionId: z.string().min(1),
    decision: z.enum(['approve', 'reject', 'modify']),
    message: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ interactionId, decision, message, payload }) => {
  const interaction = await interactionStore.getById(interactionId);
  if (!interaction) {
    throw new Error(`Interaction not found: ${interactionId}`);
  }
  await getRunInScopeOrThrow(interaction.runId);
  await interactionGate.respond(interactionId, {
    action: decision,
    message: message ?? null,
    modifiedPayload: payload ?? null,
    respondedBy: 'human',
  });
  return jsonResult({ resolved: true, interaction: await interactionStore.getById(interactionId) });
});


server.registerTool('message_send', {
  description: 'Send a direct message to another agent.',
  inputSchema: {
    runId: z.string(),
    from: z.string(),
    to: z.string(),
    type: z.enum(['dm', 'broadcast', 'task_assignment', 'shutdown', 'plan_approval', 'idle_notification']),
    payload: z.record(z.string(), z.unknown()),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ runId, from, to, type, payload }) => {
  const message = messageService.send({ runId, from, to, type, payload });
  return jsonResult({ message });
});

server.registerTool('message_read', {
  description: 'Get unread messages for an agent.',
  inputSchema: {
    agentId: z.string(),
    runId: z.string().optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ agentId, runId }) => {
  const messages = messageService.getUnread(agentId, runId);
  return jsonResult({ messages });
});

server.registerTool('message_mark_read', {
  description: 'Mark a message as read.',
  inputSchema: {
    messageId: z.string(),
    agentId: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ messageId, agentId }) => {
  const marked = messageService.markRead(messageId, agentId);
  return jsonResult({ marked });
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[mars-orchestrator] failed to start', error);
  process.exit(1);
});
