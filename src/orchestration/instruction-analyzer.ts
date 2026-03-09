import type { Agent } from '../types/agent';
import type { ICliExecutor } from '../types/provider';
import type {
  BootstrapDependencyEdge,
  BootstrapRecommendedAssignment,
  BootstrapSuggestedTask,
  IInstructionAnalyzer,
  InstructionAnalysisInput,
  InstructionAnalysisResult,
} from './types';
import { getProviderById } from '../db/provider-repo';
import { ClaudeCliExecutor } from '../providers/claude-cli';
import { CodexCliExecutor } from '../providers/codex-cli';

interface AnalysisPayload {
  summary?: unknown;
  risks?: unknown;
  questions?: unknown;
  notes?: unknown;
  recommendedAgentAssignments?: unknown;
  suggestedRootTasks?: unknown;
  dependencyEdges?: unknown;
  suggestedFinalTestTask?: unknown;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function splitInstructionUnits(instructions: string): string[] {
  const rawUnits = instructions
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((line) => normalizeWhitespace(line.replace(/^[-*\d.)\s]+/, '')))
    .filter((line) => line.length > 0);

  return rawUnits.slice(0, 4);
}

function deriveTaskTitle(unit: string, index: number): string {
  const words = unit
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  if (words.length === 0) {
    return `Bootstrap task ${index + 1}`;
  }

  const title = words.join(' ').trim();
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function buildFallbackRootTasks(selectedAgent: Agent, instructions: string): BootstrapSuggestedTask[] {
  const units = splitInstructionUnits(instructions);

  if (units.length === 0) {
    return [
      {
        id: 'root-1',
        title: 'Clarify project instructions',
        description: 'Review missing or incomplete project instructions and prepare a concrete orchestration scope for human approval.',
        priority: 'high',
        acceptanceCriteria: [
          'Summarize the intended outcome in machine-readable form.',
          'List unresolved requirements that block task materialization.',
        ],
        dependsOnIds: [],
        assignedAgentId: selectedAgent.id,
        assignedAgentReason: 'Selected orchestrator agent owns bootstrap clarification and planning.',
      },
    ];
  }

  return units.map((unit, index) => ({
    id: `root-${index + 1}`,
    title: deriveTaskTitle(unit, index),
    description: unit,
    priority: index === 0 ? 'high' : 'medium',
    acceptanceCriteria: [
      `Implement working code/artifacts for: ${unit}`,
      'All produced files compile/pass linting without errors.',
    ],
    dependsOnIds: [],
    assignedAgentId: selectedAgent.id,
    assignedAgentReason: 'Selected agent implements this deliverable.',
  }));
}

function buildFallbackResult(input: InstructionAnalysisInput): InstructionAnalysisResult {
  const normalizedInstructions = normalizeWhitespace(input.project.instructions);
  const suggestedRootTasks = buildFallbackRootTasks(input.selectedAgent, normalizedInstructions);
  const suggestedFinalTestTask: BootstrapSuggestedTask = {
    id: 'final-test',
    title: 'Run integration tests and verify build',
    description: 'Run all tests, verify the build succeeds, and confirm the project works end-to-end.',
    priority: 'high',
    acceptanceCriteria: [
      'All unit and integration tests pass.',
      'Project builds without errors.',
      'Key user flows work end-to-end.',
    ],
    dependsOnIds: suggestedRootTasks.map((task) => task.id),
    assignedAgentId: input.selectedAgent.id,
    assignedAgentReason: 'QA agent runs final verification after all implementation tasks complete.',
  };

  const dependencyEdges: BootstrapDependencyEdge[] = suggestedRootTasks.map((task) => ({
    fromTaskId: task.id,
    toTaskId: suggestedFinalTestTask.id,
    type: 'blocks',
    reason: 'Final verification should wait for all suggested root tasks to be approved and completed.',
  }));

  const recommendedAgentAssignments: BootstrapRecommendedAssignment[] = [
    ...suggestedRootTasks.map((task) => ({
      taskId: task.id,
      agentId: input.selectedAgent.id,
      reason: task.assignedAgentReason,
    })),
    {
      taskId: suggestedFinalTestTask.id,
      agentId: input.selectedAgent.id,
      reason: suggestedFinalTestTask.assignedAgentReason,
    },
  ];

  const risks = normalizedInstructions.length === 0
    ? ['Project instructions are empty; the proposal is a safe bootstrap draft that needs human refinement before materialization.']
    : ['Bootstrap analysis inferred structure from free-form instructions and should be reviewed before any tasks are materialized.'];

  const questions = normalizedInstructions.length === 0
    ? ['What outcome should this project orchestrator prepare for later approval and execution?']
    : ['Which proposed tasks should remain in scope for the first approved orchestration run?'];

  const notes = [
    'Bootstrap created implementation-ready tasks from project instructions.',
    'Tasks will produce actual code, schemas, and artifacts when executed.',
  ];

  const summary = normalizedInstructions.length === 0
    ? 'Created a bootstrap-safe orchestration draft because the project has no instructions yet.'
    : `Prepared a bootstrap proposal from ${suggestedRootTasks.length} instruction-derived planning areas.`;

  return {
    analysisMode: 'fallback',
    summary,
    risks,
    questions,
    notes,
    recommendedAgentAssignments,
    suggestedRootTasks,
    dependencyEdges,
    suggestedFinalTestTask,
  };
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1]!.trim() : text.trim();
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in output');
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  throw new Error('Unterminated JSON object in output');
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueStrings(value.filter((entry): entry is string => typeof entry === 'string'))
    : [];
}

function parseSuggestedTask(value: unknown, fallbackId: string, selectedAgent: Agent): BootstrapSuggestedTask | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';

  if (title.length === 0 || description.length === 0) {
    return null;
  }

  const priority = raw.priority === 'high' || raw.priority === 'medium' || raw.priority === 'low'
    ? raw.priority
    : 'medium';
  const assignedAgentId = typeof raw.assignedAgentId === 'string' ? raw.assignedAgentId : selectedAgent.id;
  const assignedAgentReason = typeof raw.assignedAgentReason === 'string' && raw.assignedAgentReason.trim().length > 0
    ? raw.assignedAgentReason.trim()
    : 'Selected orchestrator agent is the default bootstrap owner.';

  return {
    id: typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id : fallbackId,
    title,
    description,
    priority,
    acceptanceCriteria: parseStringArray(raw.acceptanceCriteria),
    dependsOnIds: parseStringArray(raw.dependsOnIds),
    assignedAgentId,
    assignedAgentReason,
  };
}

function parseDependencyEdge(value: unknown): BootstrapDependencyEdge | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (typeof raw.fromTaskId !== 'string' || typeof raw.toTaskId !== 'string') {
    return null;
  }

  return {
    fromTaskId: raw.fromTaskId,
    toTaskId: raw.toTaskId,
    type: raw.type === 'informs' ? 'informs' : 'blocks',
    reason: typeof raw.reason === 'string' && raw.reason.trim().length > 0
      ? raw.reason.trim()
      : 'Analysis-derived dependency edge.',
  };
}

function parseRecommendedAssignments(value: unknown): BootstrapRecommendedAssignment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const raw = entry as Record<string, unknown>;
    if (typeof raw.taskId !== 'string' || typeof raw.reason !== 'string') {
      return [];
    }

    return [{
      taskId: raw.taskId,
      agentId: typeof raw.agentId === 'string' ? raw.agentId : null,
      reason: raw.reason,
    }];
  });
}

function validateAnalysisPayload(payload: AnalysisPayload, input: InstructionAnalysisInput): InstructionAnalysisResult | null {
  const suggestedRootTasks = Array.isArray(payload.suggestedRootTasks)
    ? payload.suggestedRootTasks
      .map((entry, index) => parseSuggestedTask(entry, `root-${index + 1}`, input.selectedAgent))
      .filter((entry): entry is BootstrapSuggestedTask => entry !== null)
    : [];

  const suggestedFinalTestTask = parseSuggestedTask(payload.suggestedFinalTestTask, 'final-test', input.selectedAgent);
  const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';

  if (summary.length === 0 || suggestedRootTasks.length === 0 || !suggestedFinalTestTask) {
    return null;
  }

  const dependencyEdges = Array.isArray(payload.dependencyEdges)
    ? payload.dependencyEdges
      .map(parseDependencyEdge)
      .filter((entry): entry is BootstrapDependencyEdge => entry !== null)
    : [];

  const recommendedAgentAssignments = parseRecommendedAssignments(payload.recommendedAgentAssignments);

  return {
    analysisMode: 'llm',
    summary,
    risks: parseStringArray(payload.risks),
    questions: parseStringArray(payload.questions),
    notes: parseStringArray(payload.notes),
    recommendedAgentAssignments: recommendedAgentAssignments.length > 0
      ? recommendedAgentAssignments
      : [
          ...suggestedRootTasks.map((task) => ({
            taskId: task.id,
            agentId: task.assignedAgentId,
            reason: task.assignedAgentReason,
          })),
          {
            taskId: suggestedFinalTestTask.id,
            agentId: suggestedFinalTestTask.assignedAgentId,
            reason: suggestedFinalTestTask.assignedAgentReason,
          },
        ],
    suggestedRootTasks,
    dependencyEdges,
    suggestedFinalTestTask,
  };
}

function buildAnalysisPrompt(input: InstructionAnalysisInput): string {
  const availableAgents = input.availableAgents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    assignedToProject: agent.assignedToProject,
    matchesOrchestratorHeuristic: agent.matchesOrchestratorHeuristic,
    modelId: agent.modelId,
  }));

  return [
    'Analyze the project instructions and return a JSON object only.',
    'Each suggestedRootTask MUST be an implementation task that produces real code, files, or artifacts.',
    'Task titles should use action verbs like "Implement", "Create", "Build", "Set up" — NOT "Plan", "Design", "Define", "Review".',
    'acceptanceCriteria must reference concrete file outputs (e.g., "src/db/schema.ts exists and exports createTables function").',
    '',
    'Project metadata:',
    JSON.stringify({
      id: input.project.id,
      name: input.project.name,
      description: input.project.description,
      instructions: input.project.instructions,
      directoryPath: input.project.directoryPath,
      selectedAgentId: input.selectedAgent.id,
      availableAgents,
    }, null, 2),
    '',
    'Return this schema exactly:',
    JSON.stringify({
      summary: 'string',
      risks: ['string'],
      questions: ['string'],
      notes: ['string'],
      recommendedAgentAssignments: [{ taskId: 'string', agentId: 'string|null', reason: 'string' }],
      suggestedRootTasks: [{
        id: 'root-1',
        title: 'string',
        description: 'string',
        priority: 'high|medium|low',
        acceptanceCriteria: ['string'],
        dependsOnIds: ['string'],
        assignedAgentId: 'string|null',
        assignedAgentReason: 'string',
      }],
      dependencyEdges: [{ fromTaskId: 'string', toTaskId: 'string', type: 'blocks|informs', reason: 'string' }],
      suggestedFinalTestTask: {
        id: 'final-test',
        title: 'string',
        description: 'string',
        priority: 'high|medium|low',
        acceptanceCriteria: ['string'],
        dependsOnIds: ['string'],
        assignedAgentId: 'string|null',
        assignedAgentReason: 'string',
      },
    }, null, 2),
  ].join('\n');
}

export class DefaultInstructionAnalyzer implements IInstructionAnalyzer {
  private claudeCliExecutor: ICliExecutor;
  private codexCliExecutor: ICliExecutor;

  constructor(deps?: {
    claudeCliExecutor?: ICliExecutor;
    codexCliExecutor?: ICliExecutor;
  }) {
    this.claudeCliExecutor = deps?.claudeCliExecutor ?? new ClaudeCliExecutor();
    this.codexCliExecutor = deps?.codexCliExecutor ?? new CodexCliExecutor();
  }

  async analyze(input: InstructionAnalysisInput): Promise<InstructionAnalysisResult> {
    const normalizedInstructions = normalizeWhitespace(input.project.instructions);
    if (normalizedInstructions.length === 0) {
      return buildFallbackResult(input);
    }

    const provider = getProviderById(input.selectedAgent.providerId);
    if (!provider || provider.config.useDirectApi === true || provider.authMethod !== 'oauth') {
      return buildFallbackResult(input);
    }

    const cliExecutor = provider.providerType === 'openai'
      ? this.codexCliExecutor
      : provider.providerType === 'anthropic'
        ? this.claudeCliExecutor
        : null;

    if (!cliExecutor) {
      return buildFallbackResult(input);
    }

    try {
      const result = await cliExecutor.execute(input.selectedAgent.providerId, {
        prompt: buildAnalysisPrompt(input),
        systemPrompt: input.systemPrompt,
        model: input.selectedAgent.modelId,
        workingDirectory: input.project.directoryPath,
        permissionMode: 'plan',
        outputFormat: provider.providerType === 'anthropic' ? 'json' : 'text',
      });

      if (!result.success) {
        console.error('[InstructionAnalyzer] CLI execution failed:', { exitCode: result.exitCode, error: result.error, outputLength: result.output?.length });
        return buildFallbackResult(input);
      }

      const rawOutput = stripCodeFences(result.output);
      const jsonStr = extractJsonObject(rawOutput);
      const payload = JSON.parse(jsonStr) as AnalysisPayload;
      return validateAnalysisPayload(payload, input) ?? buildFallbackResult(input);
    } catch (error) {
      console.error('[InstructionAnalyzer] Analysis error:', error instanceof Error ? error.message : error);
      return buildFallbackResult(input);
    }
  }
}

export { buildFallbackResult };
