import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, IAgentService } from '../types/agent';
import type { Project } from '../types/project';
import type { ITerminalService } from '../types/terminal';
import { AgentService } from '../agents/service';
import { terminalService } from '../terminal/service';
import { getProjectById, updateProject } from '../db/project-repo';
import { DefaultInstructionAnalyzer } from './instruction-analyzer';
import type {
  IInstructionAnalyzer,
  OrchestrationAgentSnapshot,
  OrchestrationBootstrapManifest,
  OrchestrationBootstrapProposal,
  ProjectBootstrapState,
} from './types';

const ORCHESTRATION_DIR = '.mars/orchestration';
const SYSTEM_PROMPT_FILE = 'system-prompt.txt';
const PROPOSAL_FILE = 'proposal.json';
const MANIFEST_FILE = 'bootstrap.json';

export class BootstrapStateError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'BootstrapStateError';
    this.statusCode = statusCode;
  }
}

function matchesOrchestratorHeuristic(agent: Agent): boolean {
  return agent.name.toLowerCase().includes('orchestrator');
}

function compareAgents(a: Agent, b: Agent): number {
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

function compareSnapshots(a: OrchestrationAgentSnapshot, b: OrchestrationAgentSnapshot): number {
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

function ensureProject(projectId: string): Project {
  const project = getProjectById(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  return project;
}

function buildSystemPrompt(project: Project, agent: Agent, availableAgents: OrchestrationAgentSnapshot[]): string {
  const agentSummary = availableAgents
    .map((entry) => `- ${entry.name} (${entry.id}) | assigned=${entry.assignedToProject} | orchestratorHint=${entry.matchesOrchestratorHeuristic}`)
    .join('\n');

  const instructions = project.instructions.trim().length > 0
    ? project.instructions.trim()
    : '(none provided)';

  return [
    'You are the project-scoped orchestrator bootstrap agent for MARS.',
    '',
    'Project Metadata',
    `- Project ID: ${project.id}`,
    `- Project Name: ${project.name}`,
    `- Directory: ${project.directoryPath}`,
    `- Selected Agent ID: ${agent.id}`,
    '',
    'Operating Policy',
    '- Analyze the project and produce an implementation-ready task plan.',
    '- Each root task MUST represent a concrete implementation deliverable (code, schema, config, tests).',
    '- Tasks must produce actual files: source code, database schemas, API routes, UI components, tests, configs.',
    '- Do NOT create planning-only or documentation-only tasks. Every task must result in working code or artifacts.',
    '- Surface risks and questions alongside the implementation plan.',
    '',
    'Project Description',
    project.description.trim().length > 0 ? project.description.trim() : '(none provided)',
    '',
    'Project Instructions',
    instructions,
    '',
    'Available Agents Snapshot',
    agentSummary || '- (no enabled agents found)',
  ].join('\n');
}

export class OrchestrationBootstrapService {
  private agentService: IAgentService;
  private terminalService: ITerminalService;
  private instructionAnalyzer: IInstructionAnalyzer;

  constructor(deps?: {
    agentService?: IAgentService;
    terminalService?: ITerminalService;
    instructionAnalyzer?: IInstructionAnalyzer;
  }) {
    this.agentService = deps?.agentService ?? new AgentService();
    this.terminalService = deps?.terminalService ?? terminalService;
    this.instructionAnalyzer = deps?.instructionAnalyzer ?? new DefaultInstructionAnalyzer();
  }

  async bootstrap(projectId: string): Promise<ProjectBootstrapState> {
    const project = ensureProject(projectId);
    const enabledAgents = (await this.agentService.list({ enabled: true, limit: 1000, offset: 0 }))
      .slice()
      .sort(compareAgents);

    const selectedAgent = this.selectAgent(project, enabledAgents);
    const projectWithAgent = this.ensureAssigned(project, selectedAgent.id);
    const availableAgents = enabledAgents
      .map((agent) => this.toSnapshot(agent, projectWithAgent.agentIds))
      .sort(compareSnapshots);

    const session = await this.terminalService.getOrCreateSession(projectWithAgent.id, selectedAgent.id);
    const orchestrationDir = this.ensureOrchestrationDirectory(projectWithAgent.directoryPath);
    const systemPrompt = buildSystemPrompt(projectWithAgent, selectedAgent, availableAgents);
    const proposal = await this.buildProposal(projectWithAgent, selectedAgent, availableAgents, systemPrompt);
    const manifest: OrchestrationBootstrapManifest = {
      version: 1,
      generatedAt: proposal.generatedAt,
      selectedAgentId: selectedAgent.id,
      sessionId: session.id,
      artifacts: {
        systemPromptFile: SYSTEM_PROMPT_FILE,
        proposalFile: PROPOSAL_FILE,
      },
      analysisMode: proposal.analysisMode,
      recommendedAssignedAgentIds: proposal.recommendedAssignedAgentIds,
    };

    writeFileSync(join(orchestrationDir, SYSTEM_PROMPT_FILE), systemPrompt, 'utf8');

    if (proposal.analysisMode === 'fallback') {
      const existing = this.readExistingProposal(orchestrationDir);
      if (existing?.analysisMode === 'llm') {
        manifest.analysisMode = 'llm';
        writeFileSync(join(orchestrationDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');
        return { manifest, session, proposal: existing, systemPrompt };
      }
    }

    writeFileSync(join(orchestrationDir, PROPOSAL_FILE), JSON.stringify(proposal, null, 2), 'utf8');
    writeFileSync(join(orchestrationDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');

    return {
      manifest,
      session,
      proposal,
      systemPrompt,
    };
  }

  async getBootstrap(projectId: string): Promise<ProjectBootstrapState | null> {
    const project = getProjectById(projectId);
    if (!project) {
      return null;
    }

    const orchestrationDir = join(project.directoryPath, ORCHESTRATION_DIR);
    const manifestPath = join(orchestrationDir, MANIFEST_FILE);
    const proposalPath = join(orchestrationDir, PROPOSAL_FILE);
    const promptPath = join(orchestrationDir, SYSTEM_PROMPT_FILE);

    if (!existsSync(manifestPath) || !existsSync(proposalPath) || !existsSync(promptPath)) {
      return null;
    }

    let manifest: OrchestrationBootstrapManifest;
    let proposal: OrchestrationBootstrapProposal;
    let systemPrompt: string;

    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as OrchestrationBootstrapManifest;
      proposal = JSON.parse(readFileSync(proposalPath, 'utf8')) as OrchestrationBootstrapProposal;
      systemPrompt = readFileSync(promptPath, 'utf8');
    } catch {
      throw new BootstrapStateError('Project bootstrap artifacts are corrupt. Re-bootstrap is required.', 409);
    }

    const session = await this.terminalService.getSession(manifest.sessionId);

    if (!session) {
      throw new BootstrapStateError('Project bootstrap session is missing. Re-bootstrap is required.', 409);
    }

    return {
      manifest,
      session,
      proposal,
      systemPrompt,
    };
  }

  private ensureOrchestrationDirectory(projectDirectory: string): string {
    const orchestrationDir = join(projectDirectory, ORCHESTRATION_DIR);
    mkdirSync(orchestrationDir, { recursive: true });
    return orchestrationDir;
  }

  private toSnapshot(agent: Agent, projectAgentIds: string[]): OrchestrationAgentSnapshot {
    return {
      id: agent.id,
      name: agent.name,
      providerId: agent.providerId,
      modelId: agent.modelId,
      reasoningLevel: agent.reasoningLevel,
      workerCount: agent.workerCount,
      enabled: agent.enabled,
      assignedToProject: projectAgentIds.includes(agent.id),
      matchesOrchestratorHeuristic: matchesOrchestratorHeuristic(agent),
    };
  }

  private selectAgent(project: Project, enabledAgents: Agent[]): Agent {
    const enabledProjectAgents = enabledAgents.filter((agent) => project.agentIds.includes(agent.id));
    const projectOrchestrators = enabledProjectAgents.filter(matchesOrchestratorHeuristic);
    if (projectOrchestrators.length > 0) {
      return projectOrchestrators[0]!;
    }

    const globalOrchestrators = enabledAgents.filter(matchesOrchestratorHeuristic);
    if (globalOrchestrators.length > 0) {
      return globalOrchestrators[0]!;
    }

    if (enabledProjectAgents.length === 1) {
      return enabledProjectAgents[0]!;
    }

    if (enabledAgents.length === 1) {
      return enabledAgents[0]!;
    }

    throw new Error(
      `Unable to auto-select an orchestrator agent for project ${project.id}. Assign an enabled agent whose name contains "orchestrator", or explicitly assign a single enabled agent to the project.`,
    );
  }

  private ensureAssigned(project: Project, selectedAgentId: string): Project {
    if (project.agentIds.includes(selectedAgentId)) {
      return project;
    }

    const nextAgentIds = [...project.agentIds, selectedAgentId];
    updateProject(project.id, { agentIds: nextAgentIds });
    return {
      ...project,
      agentIds: nextAgentIds,
      updatedAt: Date.now(),
    };
  }

  private async buildProposal(
    project: Project,
    selectedAgent: Agent,
    availableAgents: OrchestrationAgentSnapshot[],
    systemPrompt: string,
  ): Promise<OrchestrationBootstrapProposal> {
    const analysis = await this.instructionAnalyzer.analyze({
      project,
      selectedAgent,
      availableAgents,
      systemPrompt,
    });
    const sanitized = this.sanitizeAnalysis(analysis, selectedAgent.id, availableAgents.map((agent) => agent.id));

    const recommendedAssignedAgentIds = [...new Set([
      selectedAgent.id,
      ...sanitized.recommendedAgentAssignments
        .map((assignment) => assignment.agentId)
        .filter((agentId): agentId is string => typeof agentId === 'string' && agentId.length > 0),
    ])];

    return {
      version: 1,
      generatedAt: Date.now(),
      analysisMode: analysis.analysisMode,
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        instructions: project.instructions,
        directoryPath: project.directoryPath,
        providerId: project.providerId,
        agentIds: project.agentIds,
      },
      selectedAgentId: selectedAgent.id,
      recommendedAssignedAgentIds,
      availableAgents,
      summary: sanitized.summary,
      risks: sanitized.risks,
      questions: sanitized.questions,
      notes: sanitized.notes,
      recommendedAgentAssignments: sanitized.recommendedAgentAssignments,
      suggestedRootTasks: sanitized.suggestedRootTasks,
      dependencyEdges: sanitized.dependencyEdges,
      suggestedFinalTestTask: sanitized.suggestedFinalTestTask,
    };
  }

  private sanitizeAnalysis(
    proposal: OrchestrationBootstrapProposal['suggestedRootTasks'] extends infer _ ? Awaited<ReturnType<IInstructionAnalyzer['analyze']>> : never,
    selectedAgentId: string,
    availableAgentIds: string[],
  ) {
    const validAgentIds = new Set(availableAgentIds);
    const rootTasks = proposal.suggestedRootTasks.map((task, index) => ({
      ...task,
      id: task.id.trim().length > 0 ? task.id : `root-${index + 1}`,
      assignedAgentId: this.sanitizeAgentId(task.assignedAgentId, selectedAgentId, validAgentIds),
    }));

    const taskIds = new Set(rootTasks.map((task) => task.id));
    const finalTestId = proposal.suggestedFinalTestTask.id.trim().length > 0 ? proposal.suggestedFinalTestTask.id : 'final-test';
    const knownEdgeIds = new Set([...taskIds, finalTestId]);

    const sanitizedRootTasks = rootTasks.map((task) => ({
      ...task,
      dependsOnIds: task.dependsOnIds.filter((dependencyId) => taskIds.has(dependencyId) && dependencyId !== task.id),
    }));

    const suggestedFinalTestTask = {
      ...proposal.suggestedFinalTestTask,
      id: finalTestId,
      assignedAgentId: this.sanitizeAgentId(proposal.suggestedFinalTestTask.assignedAgentId, selectedAgentId, validAgentIds),
      dependsOnIds: proposal.suggestedFinalTestTask.dependsOnIds.filter((dependencyId) => taskIds.has(dependencyId)),
    };

    const dependencyEdges = proposal.dependencyEdges.filter((edge) => (
      knownEdgeIds.has(edge.fromTaskId)
      && knownEdgeIds.has(edge.toTaskId)
      && edge.fromTaskId !== edge.toTaskId
    ));

    const recommendedAgentAssignments = proposal.recommendedAgentAssignments
      .filter((assignment) => knownEdgeIds.has(assignment.taskId))
      .map((assignment) => ({
        ...assignment,
        agentId: this.sanitizeAgentId(assignment.agentId, selectedAgentId, validAgentIds),
      }));

    return {
      ...proposal,
      suggestedRootTasks: sanitizedRootTasks,
      suggestedFinalTestTask,
      dependencyEdges,
      recommendedAgentAssignments,
    };
  }

  private sanitizeAgentId(agentId: string | null, selectedAgentId: string, validAgentIds: Set<string>): string {
    return agentId && validAgentIds.has(agentId) ? agentId : selectedAgentId;
  }

  private readExistingProposal(orchestrationDir: string): OrchestrationBootstrapProposal | null {
    const proposalPath = join(orchestrationDir, PROPOSAL_FILE);
    try {
      if (existsSync(proposalPath)) {
        return JSON.parse(readFileSync(proposalPath, 'utf8')) as OrchestrationBootstrapProposal;
      }
    } catch { /* corrupt — safe to overwrite */ }
    return null;
  }
}
