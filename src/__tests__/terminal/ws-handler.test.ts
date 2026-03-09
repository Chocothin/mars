import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { getDb, initDatabase } from '../../db/index';
import { terminalService } from '../../terminal/service';
import { sessionAccessTokenManager } from '../../terminal/session-access-token-manager';
import { TerminalWsHandler } from '../../terminal/ws-handler';
import type { WsData } from '../../terminal/ws-handler';
import type { WsServerMessage } from '../../types/terminal';

function createMockWs(connectionId: string): { ws: { data: WsData; send: (msg: string) => void }; sent: string[] } {
  const sent: string[] = [];
  return {
    ws: {
      data: { connectionId },
      send(message: string) {
        sent.push(message);
      },
    },
    sent,
  };
}

const testEvent: WsServerMessage = { type: 'content_delta', sessionId: 'placeholder', delta: 'test' };

describe('TerminalWsHandler', () => {
  let handler: TerminalWsHandler;
  let sessionId: string;
  let accessToken: string;

  beforeAll(() => {
    process.env.MARS_DB_PATH = ':memory:';
    initDatabase();
  });

  beforeEach(async () => {
    const db = getDb();
    db.exec('DELETE FROM terminal_messages');
    db.exec('DELETE FROM terminal_sessions');
    db.exec('DELETE FROM projects');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM providers');

    const now = Date.now();
    db.exec(`
      INSERT INTO providers (id, name, provider_type, auth_method, enabled, is_default, config, created_at, updated_at)
      VALUES ('prov-1', 'Provider', 'anthropic', 'oauth', 1, 1, '{}', ${now}, ${now})
    `);
    db.exec(`
      INSERT INTO agents (id, name, provider_id, model_id, system_prompt, reasoning_level, worker_count, mcp_server_ids, skill_ids, enabled, created_at, updated_at)
      VALUES ('agent-1', 'Agent', 'prov-1', 'claude-sonnet-4.6', '', 'none', 2, '[]', '[]', 1, ${now}, ${now})
    `);
    db.exec(`
      INSERT INTO projects (id, name, description, instructions, directory_path, provider_id, status, agent_ids, mcp_server_ids, created_at, updated_at)
      VALUES ('project-1', 'Project', '', '', '/tmp', '', 'active', '["agent-1"]', '[]', ${now}, ${now})
    `);

    const session = await terminalService.getOrCreateSession('project-1', 'agent-1');
    sessionId = session.id;
    accessToken = session.accessToken ?? sessionAccessTokenManager.getOrCreate(session.id);
    handler = new TerminalWsHandler();
  });

  it('handleOpen sends connected message with connectionId', () => {
    const { ws, sent } = createMockWs('conn-1');
    handler.handleOpen(ws as never);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] ?? '{}')).toEqual({ type: 'connected', connectionId: 'conn-1' });
  });

  it('subscribes with a valid token and receives broadcasts', () => {
    const { ws, sent } = createMockWs('conn-1');
    handler.handleOpen(ws as never);
    sent.length = 0;

    handler.handleMessage(ws as never, JSON.stringify({ type: 'subscribe', sessionId, accessToken }));
    expect(JSON.parse(sent[0] ?? '{}')).toEqual({ type: 'subscribed', sessionId });

    sent.length = 0;
    handler.broadcastToSession(sessionId, { ...testEvent, sessionId });
    expect(JSON.parse(sent[0] ?? '{}')).toEqual({ type: 'content_delta', sessionId, delta: 'test' });
  });

  it('removes stale subscribers after token rotation', () => {
    const { ws, sent } = createMockWs('conn-1');
    handler.handleOpen(ws as never);
    handler.handleMessage(ws as never, JSON.stringify({ type: 'subscribe', sessionId, accessToken }));

    sent.length = 0;
    sessionAccessTokenManager.rotate(sessionId);
    handler.broadcastToSession(sessionId, { ...testEvent, sessionId });

    expect(JSON.parse(sent[0] ?? '{}')).toEqual({
      type: 'error',
      sessionId,
      error: 'Invalid terminal session access token',
    });

    sent.length = 0;
    handler.broadcastToSession(sessionId, { ...testEvent, sessionId });
    expect(sent).toHaveLength(0);
  });

  it('unsubscribe stops future broadcasts', () => {
    const { ws, sent } = createMockWs('conn-1');
    handler.handleOpen(ws as never);
    handler.handleMessage(ws as never, JSON.stringify({ type: 'subscribe', sessionId, accessToken }));
    handler.handleMessage(ws as never, JSON.stringify({ type: 'unsubscribe', sessionId }));

    sent.length = 0;
    handler.broadcastToSession(sessionId, { ...testEvent, sessionId });
    expect(sent).toHaveLength(0);
  });

  it('invalid message format sends error message', () => {
    const { ws, sent } = createMockWs('conn-1');
    handler.handleOpen(ws as never);
    sent.length = 0;

    handler.handleMessage(ws as never, 'invalid json');
    expect(JSON.parse(sent[0] ?? '{}').type).toBe('error');
  });
});
