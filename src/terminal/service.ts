import type { TerminalSession, TerminalMessage, SessionQuery, MessageQuery, ITerminalService } from '../types/terminal';
import { insertSession, getSessionById, getSessionByProjectAgent, getMatchingSession, querySessions, deleteSession as deleteSessionDb, getMessagesBySession, deleteMessagesBySession, updateSessionLifecycle, updateSessionMcpServerIds } from '../db/terminal-repo';
import { getAgentById } from '../db/agent-repo';
import { getProjectById } from '../db/project-repo';
import { getMcpServerById } from '../db/mcp-server-repo';
import { randomUUID } from 'node:crypto';
import { ptyRuntimeManager } from './pty-runtime-manager';
import { sessionAccessTokenManager } from './session-access-token-manager';
import { resolveTerminalRuntime } from './runtime-spec';

class TerminalService implements ITerminalService {
  async getOrCreateSession(projectId: string, agentId: string, mcpServerIds?: string[]): Promise<TerminalSession> {
    const project = await getProjectById(projectId);
    if (!project) {
      throw new Error('Project not found: ' + projectId);
    }

    if (mcpServerIds !== undefined) {
      this.validateMcpServerIds(mcpServerIds);
    }

    const requestedMcpServerIds = mcpServerIds ?? [];
    const existing = await getMatchingSession(projectId, agentId, requestedMcpServerIds);
    if (existing) {
      return this.reconcileSessionRuntime(existing);
    }

    const agent = await getAgentById(agentId);
    if (!agent) {
      throw new Error('Agent not found: ' + agentId);
    }

    if (!project.agentIds.includes(agentId)) {
      throw new Error(`Agent ${agentId} is not assigned to project ${projectId}`);
    }

    const activeSessions = await querySessions({ projectId, agentId, limit: 1000, offset: 0 });
    if (activeSessions.length >= agent.workerCount) {
      const sameProjectAgent = activeSessions[0]!;
      updateSessionMcpServerIds(sameProjectAgent.id, requestedMcpServerIds);
      const refreshed = getSessionById(sameProjectAgent.id);
      return this.reconcileSessionRuntime(refreshed ?? { ...sameProjectAgent, mcpServerIds: requestedMcpServerIds });
    }

    const session: TerminalSession = {
      id: randomUUID(),
      projectId,
      agentId,
      mcpServerIds: requestedMcpServerIds,
      workingDirectory: project.directoryPath,
      status: 'idle',
      cliSessionId: null,
      accessToken: randomUUID(),
      runtimeFingerprint: null,
      runtimeVersion: 1,
      restartRequired: false,
      restartReason: null,
      restartMarkedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const runtime = resolveTerminalRuntime(session);
    session.workingDirectory = runtime.workingDirectory;
    session.runtimeFingerprint = runtime.fingerprint;

    insertSession(session);
    return session;
  }

  async getSession(sessionId: string): Promise<TerminalSession | null> {
    const session = getSessionById(sessionId);
    if (!session) {
      return null;
    }

    return this.reconcileSessionRuntime(session);
  }

  async getSessionByProjectAgent(projectId: string, agentId: string): Promise<TerminalSession | null> {
    const session = getSessionByProjectAgent(projectId, agentId);
    if (!session) {
      return null;
    }

    return this.reconcileSessionRuntime(session);
  }

  async listSessions(query: SessionQuery): Promise<TerminalSession[]> {
    return querySessions(query);
  }

  async restartSession(sessionId: string): Promise<TerminalSession | null> {
    const session = getSessionById(sessionId);
    if (!session) {
      return null;
    }

    const runtime = resolveTerminalRuntime(session);
    ptyRuntimeManager.terminate(sessionId);
    updateSessionLifecycle(sessionId, {
      workingDirectory: runtime.workingDirectory,
      status: 'idle',
      cliSessionId: null,
      accessToken: sessionAccessTokenManager.rotate(sessionId),
      runtimeFingerprint: runtime.fingerprint,
      runtimeVersion: (session.runtimeVersion ?? 0) + 1,
      restartRequired: false,
      restartReason: null,
      restartMarkedAt: null,
    });

    return getSessionById(sessionId);
  }

  async markSessionsForMcpServerChange(mcpServerId: string, reason: string): Promise<string[]> {
    const sessions = querySessions({ limit: 10_000, offset: 0 });
    const affectedSessionIds: string[] = [];
    const markedAt = Date.now();

    for (const session of sessions) {
      const project = getProjectById(session.projectId);
      const agent = getAgentById(session.agentId);
      const isAffected = project?.mcpServerIds.includes(mcpServerId)
        || agent?.mcpServerIds.includes(mcpServerId)
        || session.mcpServerIds.includes(mcpServerId);

      if (!isAffected) {
        continue;
      }

      this.applyRuntimeChange(session, reason, markedAt);
      affectedSessionIds.push(session.id);
    }

    return affectedSessionIds;
  }

  async markSessionsForProviderChange(providerId: string, reason: string): Promise<string[]> {
    const sessions = querySessions({ limit: 10_000, offset: 0 });
    const affectedSessionIds: string[] = [];
    const markedAt = Date.now();

    for (const session of sessions) {
      const agent = getAgentById(session.agentId);
      if (agent?.providerId !== providerId) {
        continue;
      }

      this.applyRuntimeChange(session, reason, markedAt);
      affectedSessionIds.push(session.id);
    }

    return affectedSessionIds;
  }

  async markSessionsForAgentChange(agentId: string, reason: string): Promise<string[]> {
    const sessions = querySessions({ agentId, limit: 10_000, offset: 0 });
    const markedAt = Date.now();

    for (const session of sessions) {
      this.applyRuntimeChange(session, reason, markedAt);
    }

    return sessions.map((session) => session.id);
  }

  async markSessionsForProjectChange(projectId: string, reason: string): Promise<string[]> {
    const sessions = querySessions({ projectId, limit: 10_000, offset: 0 });
    const markedAt = Date.now();

    for (const session of sessions) {
      this.applyRuntimeChange(session, reason, markedAt);
    }

    return sessions.map((session) => session.id);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    ptyRuntimeManager.terminate(sessionId);
    sessionAccessTokenManager.revoke(sessionId);
    deleteMessagesBySession(sessionId);
    return deleteSessionDb(sessionId);
  }

  async getMessages(query: MessageQuery): Promise<TerminalMessage[]> {
    return getMessagesBySession(query);
  }

  async clearMessages(sessionId: string): Promise<void> {
    deleteMessagesBySession(sessionId);
  }

  private validateMcpServerIds(ids: string[]): void {
    for (const mcpId of ids) {
      const server = getMcpServerById(mcpId);
      if (!server) {
        throw new Error(`MCP server not found: ${mcpId}`);
      }
    }
  }

  private reconcileSessionRuntime(session: TerminalSession): TerminalSession {
    const runtime = resolveTerminalRuntime(session);
    const currentToken = session.accessToken ?? sessionAccessTokenManager.getOrCreate(session.id);
    const hasPersistedRuntime = Boolean(session.runtimeFingerprint);
    const runtimeFingerprintChanged = hasPersistedRuntime && session.runtimeFingerprint !== runtime.fingerprint;

    if (!runtimeFingerprintChanged) {
      const needsUpdate = session.workingDirectory !== runtime.workingDirectory
        || session.runtimeFingerprint !== runtime.fingerprint
        || (session.runtimeVersion ?? 0) < 1
        || session.accessToken !== currentToken;

      if (needsUpdate) {
        updateSessionLifecycle(session.id, {
          workingDirectory: runtime.workingDirectory,
          accessToken: currentToken,
          runtimeFingerprint: runtime.fingerprint,
          runtimeVersion: Math.max(session.runtimeVersion ?? 0, 1),
        });
      }

      const refreshed = getSessionById(session.id);
      return refreshed ?? {
        ...session,
        workingDirectory: runtime.workingDirectory,
        accessToken: currentToken,
        runtimeFingerprint: runtime.fingerprint,
        runtimeVersion: Math.max(session.runtimeVersion ?? 0, 1),
      };
    }

    this.applyRuntimeChange(session, 'Terminal runtime changed. Restart the terminal session to apply the latest provider, project, or MCP configuration.');
    return getSessionById(session.id) ?? session;
  }

  private applyRuntimeChange(session: TerminalSession, reason: string, markedAt = Date.now()): void {
    const runtime = resolveTerminalRuntime(session);
    ptyRuntimeManager.terminate(session.id);
    updateSessionLifecycle(session.id, {
      workingDirectory: runtime.workingDirectory,
      cliSessionId: null,
      accessToken: sessionAccessTokenManager.rotate(session.id),
      runtimeFingerprint: runtime.fingerprint,
      runtimeVersion: (session.runtimeVersion ?? 0) + 1,
      restartRequired: true,
      restartReason: reason,
      restartMarkedAt: markedAt,
    });
  }

}

export const terminalService = new TerminalService();
export { TerminalService };
