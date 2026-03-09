import type { Agent, ReasoningLevel } from '../types/agent';
import type { Project } from '../types/project';
import type { TerminalSession } from '../types/terminal';
import type { RunStatus } from '../orchestrator/types';

export interface OrchestrationAgentSnapshot {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
  reasoningLevel: ReasoningLevel;
  workerCount: number;
  enabled: boolean;
  assignedToProject: boolean;
  matchesOrchestratorHeuristic: boolean;
}

export interface BootstrapSuggestedTask {
  id: string;
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  acceptanceCriteria: string[];
  dependsOnIds: string[];
  assignedAgentId: string | null;
  assignedAgentReason: string;
}

export interface BootstrapDependencyEdge {
  fromTaskId: string;
  toTaskId: string;
  type: 'blocks' | 'informs';
  reason: string;
}

export interface BootstrapRecommendedAssignment {
  taskId: string;
  agentId: string | null;
  reason: string;
}

export interface InstructionAnalysisInput {
  project: Project;
  selectedAgent: Agent;
  availableAgents: OrchestrationAgentSnapshot[];
  systemPrompt: string;
}

export interface InstructionAnalysisResult {
  analysisMode: 'llm' | 'fallback';
  summary: string;
  risks: string[];
  questions: string[];
  notes: string[];
  recommendedAgentAssignments: BootstrapRecommendedAssignment[];
  suggestedRootTasks: BootstrapSuggestedTask[];
  dependencyEdges: BootstrapDependencyEdge[];
  suggestedFinalTestTask: BootstrapSuggestedTask;
}

export interface IInstructionAnalyzer {
  analyze(input: InstructionAnalysisInput): Promise<InstructionAnalysisResult>;
}

export interface OrchestrationBootstrapProposal {
  version: 1;
  generatedAt: number;
  analysisMode: 'llm' | 'fallback';
  project: Pick<Project, 'id' | 'name' | 'description' | 'instructions' | 'directoryPath' | 'providerId' | 'agentIds'>;
  selectedAgentId: string;
  recommendedAssignedAgentIds: string[];
  availableAgents: OrchestrationAgentSnapshot[];
  summary: string;
  risks: string[];
  questions: string[];
  notes: string[];
  recommendedAgentAssignments: BootstrapRecommendedAssignment[];
  suggestedRootTasks: BootstrapSuggestedTask[];
  dependencyEdges: BootstrapDependencyEdge[];
  suggestedFinalTestTask: BootstrapSuggestedTask;
}

export interface OrchestrationBootstrapManifest {
  version: 1;
  generatedAt: number;
  selectedAgentId: string;
  sessionId: string;
  artifacts: {
    systemPromptFile: string;
    proposalFile: string;
  };
  analysisMode: 'llm' | 'fallback';
  recommendedAssignedAgentIds: string[];
  materialization?: {
    proposalGeneratedAt: number;
    materializedAt: number;
    createdTaskIds: string[];
    dependencyCount: number;
    runId: string;
    runStatus: RunStatus;
    noRunStarted: true;
  };
}

export interface ProjectBootstrapState {
  manifest: OrchestrationBootstrapManifest;
  session: TerminalSession;
  proposal: OrchestrationBootstrapProposal;
  systemPrompt: string;
}

export interface BootstrapMaterializationResult {
  createdTaskIds: string[];
  dependencyCount: number;
  alreadyMaterialized: boolean;
  runId: string;
  runStatus: RunStatus;
  noRunStarted: true;
}
