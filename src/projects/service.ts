import type {
  Project,
  CreateProjectInput,
  UpdateProjectInput,
  ProjectQuery,
  IProjectService,
} from '../types/project';
import type { ITerminalService } from '../types/terminal';
import {
  insertProject,
  getProjectById,
  updateProject,
  deleteProject,
  queryProjects,
} from '../db/project-repo';
import { getDb } from '../db/index';
import { getAgentById } from '../db/agent-repo';
import { getMcpServerById } from '../db/mcp-server-repo';
import { getProviderById } from '../db/provider-repo';
import { deleteRun } from '../db/run-repo';
import { deleteTask } from '../db/task-repo';
import { deleteTaskExecutionsByRunId } from '../db/task-exec-repo';
import { querySessions } from '../db/terminal-repo';
import { terminalService } from '../terminal/service';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const ORCHESTRATOR_AGENT_ID = 'agent-orchestrator';

export class ProjectService implements IProjectService {
  private terminalService: ITerminalService;

  constructor(deps?: {
    terminalService?: ITerminalService;
  }) {
    this.terminalService = deps?.terminalService ?? terminalService;
  }

  async validateDirectory(directoryPath: string): Promise<void> {
    const resolved = resolve(directoryPath);

    if (!existsSync(resolved)) {
      throw new Error(`Directory does not exist: ${resolved}`);
    }

    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }


  }

  async initProjectDirectory(directoryPath: string): Promise<void> {
    const resolved = resolve(directoryPath);
    const marsDir = `${resolved}/.mars`;
    const memoryDir = `${marsDir}/memory`;

    mkdirSync(memoryDir, { recursive: true });
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const resolved = resolve(input.directoryPath);

    await this.validateDirectory(resolved);
    await this.initProjectDirectory(resolved);

    const agentIds = input.agentIds ?? [];
    const providerId = input.providerId;

    if (!agentIds.includes(ORCHESTRATOR_AGENT_ID)) {
      const orchestrator = getAgentById(ORCHESTRATOR_AGENT_ID);
      if (orchestrator?.enabled) {
        agentIds.push(ORCHESTRATOR_AGENT_ID);
      }
    }

    if (agentIds.length === 0) {
      throw new Error('Project must have at least one assigned agent');
    }

    if (providerId !== undefined) {
      this.validateProviderId(providerId);
    }

    this.validateAgentIds(agentIds);

    const now = Date.now();
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? '',
      instructions: input.instructions ?? '',
      directoryPath: resolved,
      providerId,
      status: 'active',
      agentIds,
      mcpServerIds: [],
      createdAt: now,
      updatedAt: now,
    };

    insertProject(project);

    return getProjectById(project.id) ?? project;
  }

  async getById(id: string): Promise<Project | null> {
    return getProjectById(id);
  }

  async update(id: string, input: UpdateProjectInput): Promise<Project | null> {
    const existing = getProjectById(id);
    if (!existing) return null;

    const updates: Partial<Project> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.instructions !== undefined) updates.instructions = input.instructions;
    if (input.providerId !== undefined) {
      this.validateProviderId(input.providerId);
      updates.providerId = input.providerId;
    }
    if (input.status !== undefined) updates.status = input.status;
    if (input.agentIds !== undefined) {
      if (input.agentIds.length === 0) {
        throw new Error('Project must have at least one assigned agent');
      }
      this.validateAgentIds(input.agentIds);
      updates.agentIds = input.agentIds;
    }
    if (input.mcpServerIds !== undefined) {
      this.validateMcpServerIds(input.mcpServerIds);
      updates.mcpServerIds = input.mcpServerIds;
    }

    const changed = updateProject(id, updates);
    if (!changed) return existing;

    return getProjectById(id);
  }

  async delete(id: string): Promise<boolean> {
    const project = getProjectById(id);
    if (!project) {
      return false;
    }

    const deletedSessionIds = this.deleteProjectPersistence(project.id);
    await this.cleanupDeletedSessionRuntimes(deletedSessionIds);
    this.removeProjectOrchestrationArtifacts(project.directoryPath);

    return true;
  }

  async list(query: ProjectQuery): Promise<Project[]> {
    return queryProjects(query);
  }

  private validateAgentIds(ids: string[]): void {
    for (const agentId of ids) {
      const agent = getAgentById(agentId);
      if (!agent) {
        throw new Error(`Agent not found: ${agentId}`);
      }
    }
  }

  private validateProviderId(providerId: string): void {
    const provider = getProviderById(providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`);
    }
  }

  private validateMcpServerIds(ids: string[]): void {
    for (const mcpServerId of ids) {
      const server = getMcpServerById(mcpServerId);
      if (!server) {
        throw new Error(`MCP server not found: ${mcpServerId}`);
      }
    }
  }

  private async cleanupDeletedSessionRuntimes(sessionIds: string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      await this.terminalService.deleteSession(sessionId);
    }
  }

  private removeProjectOrchestrationArtifacts(projectDirectory: string): void {
    const orchestrationDir = join(projectDirectory, '.mars', 'orchestration');
    if (!existsSync(orchestrationDir)) {
      return;
    }

    rmSync(orchestrationDir, { recursive: true, force: true });
  }

  private deleteProjectPersistence(projectId: string): string[] {
    const db = getDb();
    const deletedSessionIds: string[] = [];

    const tx = db.transaction(() => {
      const sessionRows = querySessions({ projectId, limit: 10_000, offset: 0 });
      deletedSessionIds.push(...sessionRows.map((session) => session.id));

      if (deletedSessionIds.length > 0) {
        db.prepare('DELETE FROM terminal_messages WHERE session_id IN (SELECT id FROM terminal_sessions WHERE project_id = $projectId)')
          .run({ $projectId: projectId });
        db.prepare('DELETE FROM terminal_sessions WHERE project_id = $projectId').run({ $projectId: projectId });
      }

      const runRows = db.prepare('SELECT id FROM runs WHERE project_id = $projectId').all({
        $projectId: projectId,
      }) as Array<{ id: string }>;
      for (const run of runRows) {
        deleteTaskExecutionsByRunId(run.id);
        deleteRun(run.id);
      }

      db.prepare(`
        DELETE FROM task_dependencies
        WHERE task_id IN (
          SELECT id FROM tasks WHERE project_id = $projectId
        )
        OR depends_on_task_id IN (
          SELECT id FROM tasks WHERE project_id = $projectId
        )
      `).run({ $projectId: projectId });

      const taskRows = db.prepare('SELECT id FROM tasks WHERE project_id = $projectId').all({
        $projectId: projectId,
      }) as Array<{ id: string }>;
      for (const task of taskRows) {
        deleteTask(projectId, task.id);
      }

      const deleted = deleteProject(projectId);
      if (!deleted) {
        throw new Error(`Failed to delete project: ${projectId}`);
      }
    });

    tx();
    return deletedSessionIds;
  }
}
