import type { ICliExecutor } from '../types/provider';
import type { IAgentService, Agent } from '../types/agent';
import { OrchestratorSession } from './orchestrator-session';
import type { OrchestratorSessionConfig } from './orchestrator-session';
import { getProjectById } from '../db/project-repo';
import { writeMcpConfig } from '../terminal/provider/mcp-config-writer';

// ─── OrchestratorRegistry: projectId → OrchestratorSession 매핑 ───

export class OrchestratorRegistry {
  private sessions = new Map<string, OrchestratorSession>();
  private cliExecutor: ICliExecutor;
  private agentService: IAgentService;

  constructor(deps: {
    cliExecutor: ICliExecutor;
    agentService: IAgentService;
  }) {
    this.cliExecutor = deps.cliExecutor;
    this.agentService = deps.agentService;
  }

  async getOrCreate(projectId: string): Promise<OrchestratorSession> {
    const existing = this.sessions.get(projectId);
    if (existing && existing.getState() !== 'terminated') {
      return existing;
    }

    const project = getProjectById(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const orchestratorAgent = await this.findOrchestratorAgent();
    if (!orchestratorAgent) {
      throw new Error('No orchestrator agent configured. Create an agent with "orchestrator" in its name.');
    }

    const config: OrchestratorSessionConfig = {
      agent: orchestratorAgent,
      cliExecutor: this.cliExecutor,
      projectId,
      projectDirectory: project.directoryPath,
    };

    const session = new OrchestratorSession(config);
    this.sessions.set(projectId, session);
    return session;
  }

  get(projectId: string): OrchestratorSession | null {
    const session = this.sessions.get(projectId);
    if (!session || session.getState() === 'terminated') return null;
    return session;
  }

  terminate(projectId: string): void {
    const session = this.sessions.get(projectId);
    if (session) {
      session.terminate();
      this.sessions.delete(projectId);
    }
  }

  terminateAll(): void {
    for (const [id, session] of this.sessions) {
      session.terminate();
    }
    this.sessions.clear();
  }

  listActive(): Array<{ projectId: string; state: string }> {
    const result: Array<{ projectId: string; state: string }> = [];
    for (const [projectId, session] of this.sessions) {
      if (session.getState() !== 'terminated') {
        result.push({ projectId, state: session.getState() });
      }
    }
    return result;
  }

  private async findOrchestratorAgent(): Promise<Agent | null> {
    const agents = await this.agentService.list({ enabled: true });
    return agents.find(a => a.name.toLowerCase().includes('orchestrator')) ?? agents[0] ?? null;
  }
}
