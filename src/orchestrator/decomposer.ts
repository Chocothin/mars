import type { ProposedSubtask } from '../events/types';
import type { Task, ITaskService, CreateTaskInput } from '../types/task';
import type { IAgentRunner } from '../execution/agent-runner';
import type { IAgentService } from '../types/agent';
import type { AgentContext, RunnerCallbacks } from '../execution/types';
import { eventBus } from '../events/bus';
import { getTaskByIdGlobal } from '../db/task-repo';
import { getDefaultProvider } from '../db/provider-repo';
import type { DependencyEdge } from './types';

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

export interface ITaskDecomposer {
  propose(taskId: string, projectContext: string): Promise<ProposedSubtask[]>;
  confirm(parentTaskId: string, approved: ProposedSubtask[]): Promise<Task[]>;
}

export class TaskDecomposer implements ITaskDecomposer {
  private agentRunner: IAgentRunner;
  private taskService: ITaskService;
  private agentService: IAgentService;

  constructor(deps: {
    agentRunner: IAgentRunner;
    taskService: ITaskService;
    agentService: IAgentService;
  }) {
    this.agentRunner = deps.agentRunner;
    this.taskService = deps.taskService;
    this.agentService = deps.agentService;
  }

  /**
   * 태스크를 AI 에이전트를 사용하여 서브태스크로 분해한다.
   *
   * 전략:
   * 1. 부모 태스크의 title/description + 프로젝트 컨텍스트를 기반으로
   *    분해 프롬프트를 조립한다.
   * 2. AgentRunner로 분해 전용 에이전트를 실행하여 JSON 배열 형태의
   *    서브태스크 제안을 받는다.
   * 3. 파싱 실패 시 빈 배열을 반환하여 안전하게 폴백한다.
   */
  async propose(taskId: string, projectContext: string): Promise<ProposedSubtask[]> {
    eventBus.emit({ type: 'decompose:started', taskId });

    const task = getTaskByIdGlobal(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const enabledAgents = await this.agentService.list({ enabled: true });
    const agentListBlock = enabledAgents
      .map(a => `  - id: "${a.id}", name: "${a.name}", description: "${a.description}"`)
      .join('\n');

    const decompositionPrompt = [
      'You are a task decomposition specialist.',
      'Break down the following task into smaller, actionable IMPLEMENTATION subtasks.',
      'Every subtask MUST produce real code, files, or runnable artifacts — NOT documentation or plans.',
      '',
      `Task Title: ${task.title}`,
      `Task Description: ${task.description}`,
      '',
      `Project Context: ${projectContext}`,
      '',
      'Available agents:',
      agentListBlock,
      '',
      'Return a JSON array of subtasks. Each subtask must have:',
      '- title: string — use action verbs: "Implement", "Create", "Build", "Set up", "Write tests for"',
      '- description: string — describe WHAT code/files to produce, not what to plan or document',
      '- assignedAgentId: string — the id of the most suitable agent from the list above',
      '- requiredCapabilities: string[] (e.g. ["coding", "testing"])',
      '- dependsOn: string[] (titles of other subtasks from THIS decomposition ONLY — cross-parent dependencies are forbidden)',
      '- estimatedDurationMin: number',
      '- acceptanceCriteria: string[] — 3-5 specific, verifiable conditions that PROVE this task is done.',
      '  Each criterion must be binary (met/not met) and reference concrete file outputs.',
      '  BAD: "App should work well"',
      '  BAD: "Plan documented in docs/plan.md"',
      '  GOOD: "File src/components/Timer.tsx exists and exports a Timer component"',
      '  GOOD: "API endpoint /api/users returns 200 with JSON array"',
      '  GOOD: "Running `bun test` passes all tests in src/__tests__/"',
      '- expectedOutputs: string[] — List of source code files or artifacts this task should produce',
      '',
      'IMPORTANT: Do NOT create documentation-only or planning-only subtasks.',
      'Every subtask must result in working code checked into the project.',
      '',
      'Return ONLY the JSON array, no other text.',
    ].join('\n');

    const defaultProvider = getDefaultProvider();
    if (!defaultProvider) {
      throw new Error('No default provider configured. Create a provider and mark it as default.');
    }

    const context: AgentContext = {
      agent: {
        id: 'decomposer-internal',
        name: 'Decomposer',
        description: 'Task decomposition agent',
        providerId: defaultProvider.id,
        modelId: defaultProvider.config.defaultModel ?? 'claude-sonnet-4-20250514',
        systemPrompt: '',
        reasoningLevel: 'none',
        workerCount: 1,
        mcpServerIds: [],
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      task,
      systemPrompt: decompositionPrompt,
      tools: [],
      memory: '',
      priorResults: [],
      workingDirectory: '',
      orchestrationBrief: null,
      mcpServerIds: [],
      mcpServers: [],
    };

    const taskExecutionId = crypto.randomUUID();

    const noopCallbacks: RunnerCallbacks = {
      onStart: () => {},
      onChunk: () => {},
      onToolUse: () => {},
      onComplete: () => {},
      onError: () => {},
    };

    const result = await this.agentRunner.run(context, taskExecutionId, noopCallbacks);

    let proposed: ProposedSubtask[];
    try {
      proposed = this.extractJsonArray(result.result);
    } catch {
      proposed = [];
    }

    proposed = this.reduceTransitiveDeps(proposed);

    eventBus.emit({ type: 'decompose:proposed', taskId, subtasks: proposed });

    return proposed;
  }

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

  async confirm(parentTaskId: string, approved: ProposedSubtask[]): Promise<Task[]> {
    const parentTask = getTaskByIdGlobal(parentTaskId);
    if (!parentTask) {
      throw new Error(`Parent task not found: ${parentTaskId}`);
    }

    const createdTasks: Task[] = [];
    const titleToId = new Map<string, string>();

    for (const subtask of approved) {
      const dependsOnTaskIds: string[] = [];
      for (const depTitle of subtask.dependsOn) {
        const depId = titleToId.get(depTitle);
        if (depId) {
          dependsOnTaskIds.push(depId);
        }
      }

      const input: CreateTaskInput = {
        title: subtask.title,
        description: subtask.description,
        parentTaskId: parentTaskId,
        assignedAgentType: subtask.requiredCapabilities.join(','),
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
      subtaskIds: createdTasks.map((t) => t.id),
    });

    return createdTasks;
  }
}
