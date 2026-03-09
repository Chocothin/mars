import type { ICliExecutor } from '../types/provider';
import type { IAgentService, Agent } from '../types/agent';
import { OrchestratorSession } from './orchestrator-session';
import type { OrchestratorSessionConfig } from './orchestrator-session';
import { getProjectById } from '../db/project-repo';
import { getMcpServerById } from '../db/mcp-server-repo';
import { writeMcpConfig } from '../terminal/provider/mcp-config-writer';
import type { CliMcpServerEntry } from '../terminal/provider/mcp-config-writer';
import type { Project } from '../types/project';
import { join } from 'node:path';

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

    const mcpConfigPath = this.resolveMcpConfig(project);
    const projectContext = this.buildProjectContext(project);

    const config: OrchestratorSessionConfig = {
      agent: orchestratorAgent,
      cliExecutor: this.cliExecutor,
      projectId,
      projectDirectory: project.directoryPath,
      mcpConfigPath,
      projectContext,
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

  private resolveMcpConfig(project: Project): string | undefined {
    const servers = (project.mcpServerIds ?? [])
      .map(id => getMcpServerById(id))
      .filter((s): s is NonNullable<typeof s> => s !== null && s.enabled);

    const marsOrchEntry: CliMcpServerEntry = {
      command: 'bun',
      args: [join(process.cwd(), 'src/mcp/mars-orchestrator-server.ts')],
      env: { MARS_PROJECT_ID: project.id, MARS_MCP_MODE: '1' },
    };

    return writeMcpConfig(servers, { 'mars-orchestrator': marsOrchEntry });
  }

  private buildProjectContext(project: Project): string | undefined {
    const parts: string[] = [];

    parts.push(`# Project: ${project.name}`);
    if (project.description) {
      parts.push(`\n## Description\n${project.description}`);
    }
    if (project.instructions) {
      parts.push(`\n## Instructions\n${project.instructions}`);
    }
    parts.push(`\n## Directory\n${project.directoryPath}`);

    return parts.join('\n');
  }
}
