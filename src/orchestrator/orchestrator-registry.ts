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
    const projectContext = await this.buildProjectContext(project);

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

  private async buildProjectContext(project: Project): Promise<string | undefined> {
    const parts: string[] = [];

    parts.push(`# Project: ${project.name}`);
    parts.push(`\n## Project ID\n${project.id}`);
    if (project.description) {
      parts.push(`\n## Description\n${project.description}`);
    }
    if (project.instructions) {
      parts.push(`\n## Instructions\n${project.instructions}`);
    }
    parts.push(`\n## Directory\n${project.directoryPath}`);
    parts.push(await this.buildAgentCatalog());
    parts.push(this.buildMcpToolCatalog(project.id));

    return parts.join('\n');
  }

  private async buildAgentCatalog(): Promise<string> {
    try {
      const agents = await this.agentService.list({ enabled: true });
      if (agents.length === 0) return '';

      const lines = agents
        .filter(a => !a.name.toLowerCase().includes('orchestrator'))
        .map(a => `- **${a.name}** (${a.id}) — ${a.description ?? ''}`);

      if (lines.length === 0) return '';

      return `\n## 시스템 에이전트 (참고용 — Decomposer가 하위 태스크에 자동 배정)\n${lines.join('\n')}`;
    } catch {
      return '';
    }
  }

  private buildMcpToolCatalog(projectId: string): string {
    return `
## MARS Orchestrator MCP Tools

You have access to the \`mars-orchestrator\` MCP server. Use these tools for ALL project/task/run management.
**Always pass projectId: "${projectId}" when required.**

### Task Management
- \`task_create\` — Create a task. Params: { projectId, title, description?, status?: (backlog|ready), priority?: (low|medium|high|urgent), parentTaskId?, assignedAgentType?, dependsOnTaskIds? }
- \`task_list\` — List tasks. Params: { projectId, status?, priority?, parentTaskId?, search? }
- \`task_get\` — Get task by ID. Params: { taskId }
- \`task_update\` — Update task. Params: { projectId, taskId, patch: { title?, description?, status?: (backlog|blocked|ready|in_progress|review|done|failed|cancelled), priority?, assignedAgentType? } }
- \`task_delete\` — Delete task. Params: { projectId, taskId }
- \`task_add_dependency\` — Add dependency. Params: { projectId, taskId, dependsOnTaskId }
- \`task_remove_dependency\` — Remove dependency. Params: { projectId, taskId, dependsOnTaskId }

**Valid status values**: backlog, blocked, ready, in_progress, review, done, failed, cancelled. For new tasks use \`backlog\` (default) or \`ready\`.
**Valid priority values**: low, medium, high, urgent.

### Agent Management
- \`agent_list\` — List project agents. Params: { }
- \`agent_list_global\` — List ALL system agents. Params: { search? }
- \`project_add_agent\` — Add agent to project. Params: { agentId }

### Run Management
- \`run_create\` — Create a run. Params: { projectId, taskIds, config? }
- \`run_start\` — Start a pending run. Params: { runId }
- \`run_list\` — List runs. Params: { projectId?, status? }
- \`run_cancel\` — Cancel a run. Params: { runId }

### Project
- \`project_get\` — Get project info. Params: { projectId }
- \`project_get_context\` — Get full context (agents, MCP servers, runs). Params: { projectId }

**IMPORTANT**: Do NOT try to write to the database directly or create files for task storage. Always use these MCP tools.`;
  }
}
