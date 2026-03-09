import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../../db/index';
import { insertAgent } from '../../db/agent-repo';
import { countProjects, getProjectById, insertProject } from '../../db/project-repo';
import { insertProvider } from '../../db/provider-repo';
import { queryRuns } from '../../db/run-repo';
import { queryTasksGlobal } from '../../db/task-repo';
import { querySessions } from '../../db/terminal-repo';
import { OrchestrationBootstrapService } from '../../orchestration/bootstrap-service';
import type { IInstructionAnalyzer, InstructionAnalysisInput, InstructionAnalysisResult } from '../../orchestration/types';
import { ProjectService } from '../../projects/service';
import type { Agent } from '../../types/agent';
import type { Project } from '../../types/project';
import type { Provider } from '../../types/provider';

const now = Date.now();
const tempDirs: string[] = [];

function createTempProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mars-bootstrap-'));
  tempDirs.push(dir);
  return dir;
}

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: overrides.id ?? 'prov-1',
    name: overrides.name ?? 'Provider',
    description: overrides.description ?? '',
    providerType: overrides.providerType ?? 'anthropic',
    authMethod: overrides.authMethod ?? 'api_key',
    apiKey: overrides.apiKey ?? 'test-key',
    baseUrl: overrides.baseUrl ?? null,
    enabled: overrides.enabled ?? true,
    isDefault: overrides.isDefault ?? true,
    config: overrides.config ?? {},
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function makeAgent(overrides: Partial<Agent> & Pick<Agent, 'id' | 'name'>): Agent {
  return {
    id: overrides.id,
    name: overrides.name,
    description: overrides.description ?? '',
    providerId: overrides.providerId ?? 'prov-1',
    modelId: overrides.modelId ?? 'claude-sonnet-4.6',
    systemPrompt: overrides.systemPrompt ?? '',
    reasoningLevel: overrides.reasoningLevel ?? 'none',
    workerCount: overrides.workerCount ?? 3,
    mcpServerIds: overrides.mcpServerIds ?? [],
    skillIds: overrides.skillIds ?? [],
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function makeProject(overrides: Partial<Project> & Pick<Project, 'id' | 'name' | 'directoryPath'>): Project {
  return {
    id: overrides.id,
    name: overrides.name,
    description: overrides.description ?? '',
    instructions: overrides.instructions ?? '',
    directoryPath: overrides.directoryPath,
    providerId: overrides.providerId,
    status: overrides.status ?? 'active',
    agentIds: overrides.agentIds ?? [],
    mcpServerIds: overrides.mcpServerIds ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

class FixedAnalyzer implements IInstructionAnalyzer {
  async analyze(input: InstructionAnalysisInput): Promise<InstructionAnalysisResult> {
    return {
      analysisMode: 'fallback',
      summary: `Prepared bootstrap proposal for ${input.project.name}`,
      risks: ['Human approval is still required before execution.'],
      questions: ['Should the proposed plan be materialized as tasks later?'],
      notes: ['No execution was started during bootstrap.'],
      recommendedAgentAssignments: [
        { taskId: 'root-1', agentId: input.selectedAgent.id, reason: 'Bootstrap owner.' },
        { taskId: 'final-test', agentId: input.selectedAgent.id, reason: 'Final verification owner.' },
      ],
      suggestedRootTasks: [
        {
          id: 'root-1',
          title: 'Analyze requirements',
          description: 'Create an approval-ready orchestration outline.',
          priority: 'high',
          acceptanceCriteria: ['Outline the main scope.', 'List open questions.'],
          dependsOnIds: [],
          assignedAgentId: input.selectedAgent.id,
          assignedAgentReason: 'Bootstrap owner.',
        },
      ],
      dependencyEdges: [
        {
          fromTaskId: 'root-1',
          toTaskId: 'final-test',
          type: 'blocks',
          reason: 'Verification waits for planning tasks.',
        },
      ],
      suggestedFinalTestTask: {
        id: 'final-test',
        title: 'Run final verification checklist',
        description: 'Validate the approved orchestration proposal before execution.',
        priority: 'high',
        acceptanceCriteria: ['Confirm proposed tasks and dependencies.', 'Keep execution gated.'],
        dependsOnIds: ['root-1'],
        assignedAgentId: input.selectedAgent.id,
        assignedAgentReason: 'Final verification owner.',
      },
    };
  }
}

class EchoAnalyzer implements IInstructionAnalyzer {
  async analyze(input: InstructionAnalysisInput): Promise<InstructionAnalysisResult> {
    return {
      analysisMode: 'fallback',
      summary: `bootstrap:${input.project.instructions}:${input.selectedAgent.id}`,
      risks: [],
      questions: [],
      notes: [],
      recommendedAgentAssignments: [
        { taskId: 'root-1', agentId: input.selectedAgent.id, reason: 'owner' },
      ],
      suggestedRootTasks: [
        {
          id: 'root-1',
          title: 'Refresh task',
          description: input.project.instructions,
          priority: 'high',
          acceptanceCriteria: [],
          dependsOnIds: [],
          assignedAgentId: input.selectedAgent.id,
          assignedAgentReason: 'owner',
        },
      ],
      dependencyEdges: [],
      suggestedFinalTestTask: {
        id: 'final-test',
        title: 'Final test',
        description: 'Final verification',
        priority: 'high',
        acceptanceCriteria: [],
        dependsOnIds: ['root-1'],
        assignedAgentId: input.selectedAgent.id,
        assignedAgentReason: 'owner',
      },
    };
  }
}

class InvalidReferenceAnalyzer implements IInstructionAnalyzer {
  async analyze(_input: InstructionAnalysisInput): Promise<InstructionAnalysisResult> {
    return {
      analysisMode: 'llm',
      summary: 'invalid references should be sanitized',
      risks: [],
      questions: [],
      notes: [],
      recommendedAgentAssignments: [
        { taskId: 'root-1', agentId: 'missing-agent', reason: 'bad ref' },
        { taskId: 'ghost-task', agentId: 'missing-agent', reason: 'bad task ref' },
      ],
      suggestedRootTasks: [
        {
          id: 'root-1',
          title: 'Primary task',
          description: 'Task with invalid references',
          priority: 'high',
          acceptanceCriteria: [],
          dependsOnIds: ['ghost-task', 'root-1'],
          assignedAgentId: 'missing-agent',
          assignedAgentReason: 'bad ref',
        },
      ],
      dependencyEdges: [
        { fromTaskId: 'ghost-task', toTaskId: 'root-1', type: 'blocks', reason: 'invalid source' },
        { fromTaskId: 'root-1', toTaskId: 'final-test', type: 'blocks', reason: 'valid edge' },
        { fromTaskId: 'final-test', toTaskId: 'missing-final', type: 'blocks', reason: 'invalid target' },
      ],
      suggestedFinalTestTask: {
        id: 'final-test',
        title: 'Final verification',
        description: 'Check the plan',
        priority: 'high',
        acceptanceCriteria: [],
        dependsOnIds: ['ghost-task', 'root-1'],
        assignedAgentId: 'missing-agent',
        assignedAgentReason: 'bad ref',
      },
    };
  }
}

describe('OrchestrationBootstrapService', () => {
  beforeAll(() => {
    process.env.MARS_DB_PATH = ':memory:';
    initDatabase();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM terminal_messages');
    db.exec('DELETE FROM terminal_sessions');
    db.exec('DELETE FROM task_dependencies');
    db.exec('DELETE FROM task_executions');
    db.exec('DELETE FROM tasks');
    db.exec('DELETE FROM runs');
    db.exec('DELETE FROM projects');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM providers');
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('bootstraps artifacts, assigns the selected orchestrator, and keeps tasks/runs gated', async () => {
    insertProvider(makeProvider());
    insertAgent(makeAgent({ id: 'worker-agent', name: 'Worker Agent' }));
    insertAgent(makeAgent({ id: 'orch-agent', name: 'Orchestrator Agent' }));

    const bootstrapService = new OrchestrationBootstrapService({ instructionAnalyzer: new FixedAnalyzer() });
    const service = new ProjectService({ bootstrapService });
    const directoryPath = createTempProjectDir();

    const project = await service.create({
      name: 'Bootstrap Project',
      directoryPath,
      instructions: 'Investigate the backend scope and stage an approval-ready plan.',
    });

    expect(project.agentIds).toEqual(['orch-agent']);

    const stored = getProjectById(project.id);
    expect(stored?.agentIds).toEqual(['orch-agent']);

    const sessions = querySessions({ projectId: project.id, limit: 10, offset: 0 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.agentId).toBe('orch-agent');

    const orchestrationDir = join(directoryPath, '.mars', 'orchestration');
    const systemPromptPath = join(orchestrationDir, 'system-prompt.txt');
    const proposalPath = join(orchestrationDir, 'proposal.json');
    const manifestPath = join(orchestrationDir, 'bootstrap.json');

    expect(existsSync(systemPromptPath)).toBe(true);
    expect(existsSync(proposalPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);

    const systemPrompt = readFileSync(systemPromptPath, 'utf8');
    expect(systemPrompt).toContain('Do not create tasks, runs, or implementation changes.');
    expect(systemPrompt).toContain('Do not auto-execute project work.');

    const proposal = JSON.parse(readFileSync(proposalPath, 'utf8')) as Record<string, unknown>;
    expect(proposal.selectedAgentId).toBe('orch-agent');
    expect(proposal.recommendedAssignedAgentIds).toEqual(['orch-agent']);
    expect((proposal.suggestedRootTasks as unknown[])).toHaveLength(1);
    expect((proposal.dependencyEdges as unknown[])).toHaveLength(1);
    expect((proposal.suggestedFinalTestTask as Record<string, unknown>).id).toBe('final-test');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest.selectedAgentId).toBe('orch-agent');
    expect(manifest.sessionId).toBe(sessions[0]?.id);

    expect(queryTasksGlobal({ projectId: project.id, limit: 20, offset: 0 })).toEqual([]);
    expect(queryRuns({ projectId: project.id, limit: 20, offset: 0 })).toEqual([]);
  });

  it('reuses the existing project-agent terminal session on repeated bootstrap', async () => {
    insertProvider(makeProvider());
    insertAgent(makeAgent({ id: 'orch-agent', name: 'Orchestrator Agent' }));

    const bootstrapService = new OrchestrationBootstrapService({ instructionAnalyzer: new FixedAnalyzer() });
    const service = new ProjectService({ bootstrapService });
    const directoryPath = createTempProjectDir();

    const project = await service.create({
      name: 'Reusable Session Project',
      directoryPath,
      instructions: 'Create a reusable orchestrator context only.',
    });

    const firstState = await bootstrapService.getBootstrap(project.id);
    expect(firstState).not.toBeNull();
    if (!firstState) {
      throw new Error('Expected bootstrap state to exist');
    }

    const secondState = await bootstrapService.bootstrap(project.id);
    expect(secondState.session.id).toBe(firstState.session.id);

    const sessions = querySessions({ projectId: project.id, limit: 10, offset: 0 });
    expect(sessions).toHaveLength(1);
  });

  it('prefers a project-assigned orchestrator over a global orchestrator candidate', async () => {
    insertProvider(makeProvider());
    insertAgent(makeAgent({ id: 'global-orch', name: 'Orchestrator Agent Global' }));
    insertAgent(makeAgent({ id: 'project-orch', name: 'Project Orchestrator' }));
    insertAgent(makeAgent({ id: 'project-worker', name: 'Project Worker' }));

    const directoryPath = createTempProjectDir();
    const project = makeProject({
      id: 'project-heuristic',
      name: 'Heuristic Project',
      directoryPath,
      instructions: 'Stage planning only.',
      agentIds: ['project-worker', 'project-orch'],
    });
    insertProject(project);

    const bootstrapService = new OrchestrationBootstrapService({ instructionAnalyzer: new FixedAnalyzer() });
    const state = await bootstrapService.bootstrap(project.id);

    expect(state.manifest.selectedAgentId).toBe('project-orch');
    expect(state.proposal.selectedAgentId).toBe('project-orch');
  });

  it('fails with a clear error and rolls back project creation when agent selection is ambiguous', async () => {
    insertProvider(makeProvider());
    insertAgent(makeAgent({ id: 'agent-a', name: 'Agent A' }));
    insertAgent(makeAgent({ id: 'agent-b', name: 'Agent B' }));

    const bootstrapService = new OrchestrationBootstrapService({ instructionAnalyzer: new FixedAnalyzer() });
    const service = new ProjectService({ bootstrapService });

    await expect(service.create({
      name: 'Ambiguous Project',
      directoryPath: createTempProjectDir(),
      instructions: 'Need planning but no orchestrator is explicitly assigned.',
    })).rejects.toThrow('Unable to auto-select an orchestrator agent');

    expect(countProjects()).toBe(0);
  });

  it('refreshes bootstrap artifacts after bootstrap-shaping project updates', async () => {
    insertProvider(makeProvider());
    insertAgent(makeAgent({ id: 'orch-agent', name: 'Orchestrator Agent' }));
    insertAgent(makeAgent({ id: 'alt-orch', name: 'Alternate Orchestrator' }));

    const bootstrapService = new OrchestrationBootstrapService({ instructionAnalyzer: new EchoAnalyzer() });
    const service = new ProjectService({ bootstrapService });
    const directoryPath = createTempProjectDir();

    const project = await service.create({
      name: 'Refresh Project',
      directoryPath,
      instructions: 'initial instructions',
      agentIds: ['orch-agent'],
    });

    const proposalPath = join(directoryPath, '.mars', 'orchestration', 'proposal.json');
    const initialProposal = JSON.parse(readFileSync(proposalPath, 'utf8')) as { summary: string; selectedAgentId: string };
    expect(initialProposal.summary).toBe('bootstrap:initial instructions:orch-agent');
    expect(initialProposal.selectedAgentId).toBe('orch-agent');

    const updated = await service.update(project.id, {
      instructions: 'updated instructions',
      agentIds: ['alt-orch'],
    });

    expect(updated?.agentIds).toEqual(['alt-orch']);

    const refreshedProposal = JSON.parse(readFileSync(proposalPath, 'utf8')) as { summary: string; selectedAgentId: string };
    expect(refreshedProposal.summary).toBe('bootstrap:updated instructions:alt-orch');
    expect(refreshedProposal.selectedAgentId).toBe('alt-orch');
  });

  it('sanitizes invalid agent and dependency references from analysis output', async () => {
    insertProvider(makeProvider());
    insertAgent(makeAgent({ id: 'orch-agent', name: 'Orchestrator Agent' }));

    const bootstrapService = new OrchestrationBootstrapService({ instructionAnalyzer: new InvalidReferenceAnalyzer() });
    const service = new ProjectService({ bootstrapService });
    const directoryPath = createTempProjectDir();

    const project = await service.create({
      name: 'Sanitized Project',
      directoryPath,
      instructions: 'sanitize invalid references',
    });

    const bootstrap = await bootstrapService.getBootstrap(project.id);
    expect(bootstrap).not.toBeNull();
    if (!bootstrap) {
      throw new Error('Expected bootstrap state to exist');
    }

    expect(bootstrap.proposal.suggestedRootTasks[0]?.assignedAgentId).toBe('orch-agent');
    expect(bootstrap.proposal.suggestedRootTasks[0]?.dependsOnIds).toEqual([]);
    expect(bootstrap.proposal.suggestedFinalTestTask.assignedAgentId).toBe('orch-agent');
    expect(bootstrap.proposal.suggestedFinalTestTask.dependsOnIds).toEqual(['root-1']);
    expect(bootstrap.proposal.recommendedAgentAssignments).toEqual([
      { taskId: 'root-1', agentId: 'orch-agent', reason: 'bad ref' },
    ]);
    expect(bootstrap.proposal.dependencyEdges).toEqual([
      { fromTaskId: 'root-1', toTaskId: 'final-test', type: 'blocks', reason: 'valid edge' },
    ]);
  });
});
