import { randomUUID } from 'node:crypto';
import type { AgentSession } from './types';
import { eventBus } from '../events/bus';

// ─── ISessionManager: 에이전트 실행 세션 생명주기 인터페이스 ───

export interface ISessionManager {
  createSession(agentId: string, taskExecutionId: string): AgentSession;
  getSession(sessionId: string): AgentSession | null;
  updateSession(sessionId: string, updates: Partial<AgentSession>): void;
  endSession(sessionId: string, status: AgentSession['status']): void;
  getActiveSessions(): AgentSession[];
  cleanupStale(maxIdleMs: number): void;
}

// ─── SessionManager: 인메모리 세션 관리 ───

export class SessionManager implements ISessionManager {
  private sessions = new Map<string, AgentSession>();

  createSession(agentId: string, taskExecutionId: string): AgentSession {
    const now = Date.now();
    const session: AgentSession = {
      id: randomUUID(),
      externalSessionId: null,
      agentId,
      taskExecutionId,
      status: 'active',
      messages: [],
      createdAt: now,
      lastActivityAt: now,
    };

    this.sessions.set(session.id, session);

    return session;
  }

  getSession(sessionId: string): AgentSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  updateSession(sessionId: string, updates: Partial<AgentSession>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (updates.externalSessionId !== undefined) {
      session.externalSessionId = updates.externalSessionId;
    }
    if (updates.status !== undefined) {
      session.status = updates.status;
    }
    if (updates.messages !== undefined) {
      session.messages = updates.messages;
    }

    session.lastActivityAt = Date.now();
  }

  endSession(sessionId: string, status: AgentSession['status']): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = status;
    session.lastActivityAt = Date.now();

    this.sessions.delete(sessionId);
  }

  getActiveSessions(): AgentSession[] {
    const active: AgentSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.status === 'active') {
        active.push(session);
      }
    }
    return active;
  }

  cleanupStale(maxIdleMs: number): void {
    const now = Date.now();
    const staleIds: string[] = [];

    for (const [id, session] of this.sessions) {
      if (session.status === 'active' && now - session.lastActivityAt > maxIdleMs) {
        staleIds.push(id);
      }
    }

    for (const id of staleIds) {
      this.endSession(id, 'timeout');
    }
  }
}
