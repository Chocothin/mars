import type { ProposedSubtask } from '../events/types';
import type { Task, ITaskService, CreateTaskInput } from '../types/task';
import type { ICliExecutor, CliExecuteOptions } from '../types/provider';
import type { IAgentService } from '../types/agent';
import { eventBus } from '../events/bus';
import { getTaskByIdGlobal } from '../db/task-repo';
import { getDefaultProvider } from '../db/provider-repo';
import type { DependencyEdge } from './types';
import { AGENT_TYPES, getAgentType, normalizeAgentType } from './agent-pool';

// ─── Graph: transitive reduction (DFS reachability) ───

function hasPath(adj: Map<string, Set<string>>, from: string, to: string): boolean {
  const visited = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === to) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    const neighbors = adj.get(node);
    if (neighbors) {
      for (const n of neighbors) {
        if (!visited.has(n)) stack.push(n);
      }
    }
  }
  return false;
}

export function transitiveReduction(edges: DependencyEdge[]): DependencyEdge[] {
  const adj = new Map<string, Set<string>>();
  for (const { fromTaskId, toTaskId } of edges) {
    if (!adj.has(fromTaskId)) adj.set(fromTaskId, new Set());
    adj.get(fromTaskId)!.add(toTaskId);
  }

  return edges.filter(({ fromTaskId, toTaskId }) => {
    adj.get(fromTaskId)!.delete(toTaskId);
    const reachable = hasPath(adj, fromTaskId, toTaskId);
    adj.get(fromTaskId)!.add(toTaskId);
    return !reachable;
  });
}

// ─── ITaskDecomposer ───

export interface ITaskDecomposer {
  propose(taskId: string, projectContext: string): Promise<ProposedSubtask[]>;
  confirm(parentTaskId: string, approved: ProposedSubtask[]): Promise<Task[]>;
  decompose(taskId: string, projectContext: string): Promise<Task[]>;
}

// ─── TaskDecomposer ───

export class TaskDecomposer implements ITaskDecomposer {
  private cliExecutor: ICliExecutor;
  private taskService: ITaskService;
  private agentService: IAgentService;

  constructor(deps: {
    cliExecutor: ICliExecutor;
    taskService: ITaskService;
    agentService: IAgentService;
  }) {
    this.cliExecutor = deps.cliExecutor;
    this.taskService = deps.taskService;
    this.agentService = deps.agentService;
  }

  async decompose(taskId: string, projectContext: string): Promise<Task[]> {
    const proposed = await this.propose(taskId, projectContext);
    if (proposed.length === 0) return [];
    return this.confirm(taskId, proposed);
  }

  async propose(taskId: string, projectContext: string): Promise<ProposedSubtask[]> {
    eventBus.emit({ type: 'decompose:started', taskId });

    const task = getTaskByIdGlobal(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const enabledAgents = await this.agentService.list({ enabled: true });
    const agentListBlock = enabledAgents
      .map(a => `  - "${getAgentType(a)}"`)
      .join('\n');
    const validTypesStr = AGENT_TYPES.join(', ');

    const prompt = [
      'You are a task decomposition specialist.',
      'Break down the following task into smaller, actionable IMPLEMENTATION subtasks.',
      'Every subtask MUST produce real code, files, or runnable artifacts.',
      '',
      `Task Title: ${task.title}`,
      `Task Description: ${task.description}`,
      '',
      `Project Context: ${projectContext}`,
      '',
      'Available agent types:',
      agentListBlock,
      '',
      'Return a JSON array of subtasks. Each subtask must have:',
      '- title: string (action verb: "Implement", "Create", "Build", "Write tests for")',
      '- description: string (WHAT code/files to produce)',
      `- assignedAgentType: string[] (MUST use ONLY these exact values: [${validTypesStr}] — e.g. ["backend"])`,
      '- requiredCapabilities: string[]',
      '- dependsOn: string[] (titles of other subtasks from THIS decomposition ONLY)',
      '- estimatedDurationMin: number',
      '- acceptanceCriteria: string[] (3-5 specific, verifiable, binary conditions)',
      '- expectedOutputs: string[] (source files or artifacts)',
      '',
      'IMPORTANT: Every subtask must result in working code. No documentation-only tasks.',
      'Return ONLY the JSON array, no other text.',
    ].join('\n');

    const defaultProvider = getDefaultProvider();
    if (!defaultProvider) {
      throw new Error('No default provider configured');
    }

    const options: CliExecuteOptions = {
      prompt,
      model: defaultProvider.config.defaultModel,
      outputFormat: 'text',
    };

    const result = await this.cliExecutor.execute(defaultProvider.id, options);

    let proposed: ProposedSubtask[];
    try {
      proposed = this.extractJsonArray(result.output);
    } catch {
      proposed = [];
    }

    proposed = this.reduceTransitiveDeps(proposed);
    eventBus.emit({ type: 'decompose:proposed', taskId, subtasks: proposed });

    return proposed;
  }

  async confirm(parentTaskId: string, approved: ProposedSubtask[]): Promise<Task[]> {
    const parentTask = getTaskByIdGlobal(parentTaskId);
    if (!parentTask) throw new Error(`Parent task not found: ${parentTaskId}`);

    const createdTasks: Task[] = [];
    const titleToId = new Map<string, string>();

    for (const subtask of approved) {
      const dependsOnTaskIds: string[] = [];
      for (const depTitle of subtask.dependsOn) {
        const depId = titleToId.get(depTitle);
        if (depId) dependsOnTaskIds.push(depId);
      }

      const raw = (subtask as unknown as Record<string, unknown>).assignedAgentType;
      const rawList: string[] = Array.isArray(raw)
        ? raw as string[]
        : typeof raw === 'string'
          ? raw.split(',').map(s => s.trim()).filter(Boolean)
          : subtask.requiredCapabilities.length > 0 && subtask.requiredCapabilities[0]
            ? [subtask.requiredCapabilities[0]]
            : [];

      const assignedAgentType: string[] = rawList
        .map(v => normalizeAgentType(v))
        .filter((v): v is NonNullable<typeof v> => v !== null);

      const input: CreateTaskInput = {
        title: subtask.title,
        description: subtask.description,
        parentTaskId,
        assignedAgentType,
        assignedAgentId: subtask.assignedAgentId,
        dependsOnTaskIds,
        acceptanceCriteria: subtask.acceptanceCriteria ?? [],
        expectedOutputs: subtask.expectedOutputs ?? [],
      };

      const created = await this.taskService.create(parentTask.projectId, input);
      createdTasks.push(created);
      titleToId.set(subtask.title, created.id);
    }

    eventBus.emit({
      type: 'decompose:approved',
      taskId: parentTaskId,
      subtaskIds: createdTasks.map(t => t.id),
    });

    return createdTasks;
  }

  // ─── Internal ───

  private reduceTransitiveDeps(subtasks: ProposedSubtask[]): ProposedSubtask[] {
    const edges: DependencyEdge[] = [];
    for (const st of subtasks) {
      for (const dep of st.dependsOn) {
        edges.push({ fromTaskId: dep, toTaskId: st.title, type: 'blocks' });
      }
    }

    const reduced = transitiveReduction(edges);
    const depsMap = new Map<string, string[]>();
    for (const { fromTaskId, toTaskId } of reduced) {
      if (!depsMap.has(toTaskId)) depsMap.set(toTaskId, []);
      depsMap.get(toTaskId)!.push(fromTaskId);
    }

    return subtasks.map(st => ({
      ...st,
      dependsOn: depsMap.get(st.title) ?? [],
    }));
  }

  private extractJsonArray(raw: string): ProposedSubtask[] {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = fenced ? fenced[1]!.trim() : raw.trim();

    const bracketStart = jsonStr.indexOf('[');
    const bracketEnd = jsonStr.lastIndexOf(']');
    if (bracketStart === -1 || bracketEnd === -1) {
      throw new Error('No JSON array found');
    }

    return JSON.parse(jsonStr.slice(bracketStart, bracketEnd + 1)) as ProposedSubtask[];
  }
}
