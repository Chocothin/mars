import { describe, expect, it } from 'bun:test';
import { DefaultInstructionAnalyzer } from '../../orchestration/instruction-analyzer';
import type { ICliExecutor, CliExecuteOptions, CliExecuteResult, ProviderConnectionResult } from '../../types/provider';
import type { InstructionAnalysisInput } from '../../orchestration/types';
import type { Agent } from '../../types/agent';
import type { Project } from '../../types/project';
import type { Provider } from '../../types/provider';
import { initDatabase, getDb } from '../../db/index';
import { insertProvider } from '../../db/provider-repo';

const now = Date.now();

class FakeCliExecutor implements ICliExecutor {
  constructor(private readonly output: CliExecuteResult) {}

  async execute(_providerId: string, _options: CliExecuteOptions): Promise<CliExecuteResult> {
    return this.output;
  }

  async executeStreaming(
    _providerId: string,
    _options: CliExecuteOptions,
    _onChunk: (chunk: string) => void,
  ): Promise<CliExecuteResult> {
    return this.output;
  }

  async checkHealth(_providerId: string): Promise<ProviderConnectionResult> {
    return { success: true, latencyMs: 1 };
  }

  async getAuthStatus(): Promise<ProviderConnectionResult['authStatus']> {
    return { loggedIn: true, authMethod: 'oauth' };
  }
}

function makeProvider(): Provider {
  return {
    id: 'prov-oauth',
    name: 'OAuth Provider',
    description: '',
    providerType: 'anthropic',
    authMethod: 'oauth',
    apiKey: null,
    baseUrl: null,
    enabled: true,
    isDefault: true,
    config: { useDirectApi: false },
    createdAt: now,
    updatedAt: now,
  };
}

function makeInput(instructions: string): InstructionAnalysisInput {
  const project: Project = {
    id: 'project-1',
    name: 'Project',
    description: '',
    instructions,
    directoryPath: '/tmp/project',
    providerId: 'prov-oauth',
    status: 'active',
    agentIds: ['orch-agent'],
    mcpServerIds: [],
    createdAt: now,
    updatedAt: now,
  };

  const selectedAgent: Agent = {
    id: 'orch-agent',
    name: 'Orchestrator Agent',
    description: '',
    providerId: 'prov-oauth',
    modelId: 'claude-sonnet-4.6',
    systemPrompt: '',
    reasoningLevel: 'none',
    workerCount: 1,
    mcpServerIds: [],
    skillIds: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };

  return {
    project,
    selectedAgent,
    availableAgents: [{
      id: 'orch-agent',
      name: 'Orchestrator Agent',
      providerId: 'prov-oauth',
      modelId: 'claude-sonnet-4.6',
      reasoningLevel: 'none',
      workerCount: 1,
      enabled: true,
      assignedToProject: true,
      matchesOrchestratorHeuristic: true,
    }],
    systemPrompt: 'bootstrap prompt',
  };
}

describe('DefaultInstructionAnalyzer', () => {
  initDatabase();
  getDb().exec('DELETE FROM providers');
  insertProvider(makeProvider());

  it('falls back deterministically when instructions are empty', async () => {
    const analyzer = new DefaultInstructionAnalyzer();
    const result = await analyzer.analyze(makeInput(''));

    expect(result.analysisMode).toBe('fallback');
    expect(result.suggestedRootTasks).toHaveLength(1);
    expect(result.suggestedFinalTestTask.id).toBe('final-test');
  });

  it('falls back when CLI output is invalid', async () => {
    const analyzer = new DefaultInstructionAnalyzer({
      claudeCliExecutor: new FakeCliExecutor({
        success: true,
        output: '{"invalid":true}',
        exitCode: 0,
        durationMs: 5,
      }),
    });

    const result = await analyzer.analyze(makeInput('Plan the backend rollout and validation.'));
    expect(result.analysisMode).toBe('fallback');
    expect(result.suggestedRootTasks.length).toBeGreaterThan(0);
  });
});
