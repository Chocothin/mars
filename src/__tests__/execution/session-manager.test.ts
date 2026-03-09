import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionManager } from '../../execution/session-manager';
import { eventBus } from '../../events/bus';
import type { AllEvents } from '../../events/types';

let manager: SessionManager;

beforeEach(() => {
  manager = new SessionManager();
});

afterEach(() => {
  eventBus.removeAllListeners();
});

describe('SessionManager', () => {
  describe('createSession', () => {
    it('creates a session with active status', () => {
      const session = manager.createSession('agent-1', 'exec-1');

      expect(session.id).toBeTruthy();
      expect(session.agentId).toBe('agent-1');
      expect(session.taskExecutionId).toBe('exec-1');
      expect(session.status).toBe('active');
      expect(session.messages).toEqual([]);
      expect(session.externalSessionId).toBeNull();
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.lastActivityAt).toBeGreaterThan(0);
    });

    it('emits task:started event', () => {
      const events: AllEvents[] = [];
      eventBus.onAny((e) => events.push(e));

      const session = manager.createSession('agent-1', 'exec-1');

      expect(events).toHaveLength(1);
      const evt = events[0] as Extract<AllEvents, { type: 'task:started' }>;
      expect(evt.type).toBe('task:started');
      expect(evt.agentId).toBe('agent-1');
      expect(evt.taskId).toBe('exec-1');
      expect(evt.sessionId).toBe(session.id);
    });

    it('generates unique IDs for different sessions', () => {
      const s1 = manager.createSession('agent-1', 'exec-1');
      const s2 = manager.createSession('agent-1', 'exec-2');

      expect(s1.id).not.toBe(s2.id);
    });
  });

  describe('getSession', () => {
    it('returns session by id', () => {
      const created = manager.createSession('agent-1', 'exec-1');
      const fetched = manager.getSession(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it('returns null for unknown id', () => {
      expect(manager.getSession('nonexistent')).toBeNull();
    });
  });

  describe('updateSession', () => {
    it('updates externalSessionId', () => {
      const session = manager.createSession('agent-1', 'exec-1');
      manager.updateSession(session.id, { externalSessionId: 'ext-123' });

      const fetched = manager.getSession(session.id)!;
      expect(fetched.externalSessionId).toBe('ext-123');
    });

    it('updates status', () => {
      const session = manager.createSession('agent-1', 'exec-1');
      manager.updateSession(session.id, { status: 'failed' });

      const fetched = manager.getSession(session.id)!;
      expect(fetched.status).toBe('failed');
    });

    it('updates messages', () => {
      const session = manager.createSession('agent-1', 'exec-1');
      const messages = [{ role: 'user' as const, content: 'hello', timestamp: Date.now() }];
      manager.updateSession(session.id, { messages });

      const fetched = manager.getSession(session.id)!;
      expect(fetched.messages).toHaveLength(1);
    });

    it('updates lastActivityAt on any update', () => {
      const session = manager.createSession('agent-1', 'exec-1');
      const originalActivity = session.lastActivityAt;

      const before = Date.now();
      manager.updateSession(session.id, { status: 'completed' });
      const fetched = manager.getSession(session.id)!;

      expect(fetched.lastActivityAt).toBeGreaterThanOrEqual(before);
    });

    it('does nothing for unknown session id', () => {
      expect(() =>
        manager.updateSession('nonexistent', { status: 'failed' }),
      ).not.toThrow();
    });
  });

  describe('endSession', () => {
    it('removes session from active pool', () => {
      const session = manager.createSession('agent-1', 'exec-1');
      manager.endSession(session.id, 'completed');

      expect(manager.getSession(session.id)).toBeNull();
      expect(manager.getActiveSessions()).toHaveLength(0);
    });

    it('does nothing for unknown session id', () => {
      expect(() => manager.endSession('nonexistent', 'failed')).not.toThrow();
    });
  });

  describe('getActiveSessions', () => {
    it('returns only active sessions', () => {
      manager.createSession('agent-1', 'exec-1');
      const s2 = manager.createSession('agent-2', 'exec-2');
      manager.updateSession(s2.id, { status: 'failed' });

      const active = manager.getActiveSessions();
      expect(active).toHaveLength(1);
      expect(active[0]!.agentId).toBe('agent-1');
    });

    it('returns empty array when no sessions exist', () => {
      expect(manager.getActiveSessions()).toEqual([]);
    });
  });

  describe('cleanupStale', () => {
    it('removes sessions idle longer than maxIdleMs', () => {
      const session = manager.createSession('agent-1', 'exec-1');
      const fetched = manager.getSession(session.id)!;
      fetched.lastActivityAt = Date.now() - 10000;

      manager.cleanupStale(5000);

      expect(manager.getSession(session.id)).toBeNull();
    });

    it('keeps sessions that are not stale', () => {
      const session = manager.createSession('agent-1', 'exec-1');

      manager.cleanupStale(60000);

      expect(manager.getSession(session.id)).not.toBeNull();
    });

    it('skips non-active sessions — cleanupStale only targets active status', () => {
      const s1 = manager.createSession('agent-1', 'exec-1');
      manager.updateSession(s1.id, { status: 'failed' });
      const fetched = manager.getSession(s1.id)!;
      fetched.lastActivityAt = Date.now() - 10000;

      manager.cleanupStale(5000);

      expect(manager.getSession(s1.id)).not.toBeNull();
    });
  });
});
