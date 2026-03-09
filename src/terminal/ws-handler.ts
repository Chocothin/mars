import type { WsClientMessage, WsServerMessage } from '../types/terminal';
import type { ServerWebSocket } from 'bun';
import { getSessionById } from '../db/terminal-repo';
import { terminalService } from './service';
import { sessionExecutor } from './session-executor';
import { ptyRuntimeManager } from './pty-runtime-manager';
import { sessionAccessTokenManager } from './session-access-token-manager';

export interface WsData {
  connectionId: string;
}

export class TerminalWsHandler {
  private connections: Map<string, ServerWebSocket<WsData>> = new Map();
  private subscriptions: Map<string, Map<string, string>> = new Map();
  private connectionSessions: Map<string, Set<string>> = new Map();
  private connectionPtySessions: Map<string, Map<string, string>> = new Map();

  handleOpen(ws: ServerWebSocket<WsData>): void {
    this.connections.set(ws.data.connectionId, ws);
    this.send(ws, { type: 'connected', connectionId: ws.data.connectionId });
  }

  handleClose(ws: ServerWebSocket<WsData>): void {
    const connectionId = ws.data.connectionId;
    const sessionIds = this.connectionSessions.get(connectionId);

    if (sessionIds) {
      for (const sessionId of sessionIds) {
        this.unregisterSessionSubscription(connectionId, sessionId);
      }
    }

    const attachedSessionIds = this.connectionPtySessions.get(connectionId);
    if (attachedSessionIds) {
      for (const sessionId of attachedSessionIds.keys()) {
        ptyRuntimeManager.detach(sessionId, connectionId);
      }
    }

    this.connections.delete(connectionId);
    this.connectionSessions.delete(connectionId);
    this.connectionPtySessions.delete(connectionId);
  }

  handleMessage(ws: ServerWebSocket<WsData>, rawMessage: string | Buffer): void {
    try {
      const messageStr = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString();
      const msg: WsClientMessage = JSON.parse(messageStr);

      switch (msg.type) {
        case 'subscribe': {
          if (!this.ensureSessionAuthorized(ws, msg.sessionId, msg.accessToken, 'error')) {
            break;
          }
          if (!this.subscriptions.has(msg.sessionId)) {
            this.subscriptions.set(msg.sessionId, new Map());
          }
          this.subscriptions.get(msg.sessionId)!.set(ws.data.connectionId, msg.accessToken);

          if (!this.connectionSessions.has(ws.data.connectionId)) {
            this.connectionSessions.set(ws.data.connectionId, new Set());
          }
          this.connectionSessions.get(ws.data.connectionId)!.add(msg.sessionId);

          this.send(ws, { type: 'subscribed', sessionId: msg.sessionId });
          break;
        }

        case 'unsubscribe': {
          this.unregisterSessionSubscription(ws.data.connectionId, msg.sessionId);
          this.unregisterPtyAttachment(ws.data.connectionId, msg.sessionId);

          this.send(ws, { type: 'unsubscribed', sessionId: msg.sessionId });
          break;
        }

        case 'send': {
          if (!this.ensureSessionAuthorized(ws, msg.sessionId, msg.accessToken, 'error')) {
            break;
          }
          this.handleSend(ws, msg.sessionId, msg.content);
          break;
        }

        case 'abort': {
          if (!this.ensureSessionAuthorized(ws, msg.sessionId, msg.accessToken, 'error')) {
            break;
          }
          sessionExecutor.abort(msg.sessionId);
          this.broadcastToSession(msg.sessionId, { type: 'aborted', sessionId: msg.sessionId });
          break;
        }

        case 'pty_attach': {
          if (!this.ensureSessionAuthorized(ws, msg.sessionId, msg.accessToken, 'pty_error')) {
            break;
          }
          void this.handlePtyAttach(ws, msg.sessionId, msg.accessToken, msg.cols, msg.rows);
          break;
        }

        case 'pty_input': {
          if (!this.ensureSessionAuthorized(ws, msg.sessionId, msg.accessToken, 'pty_error') || !this.ensurePtyOwnership(ws, msg.sessionId)) {
            break;
          }
          ptyRuntimeManager.write(msg.sessionId, msg.data);
          break;
        }

        case 'pty_resize': {
          if (!this.ensureSessionAuthorized(ws, msg.sessionId, msg.accessToken, 'pty_error') || !this.ensurePtyOwnership(ws, msg.sessionId)) {
            break;
          }
          ptyRuntimeManager.resize(msg.sessionId, msg.cols, msg.rows);
          break;
        }

        case 'pty_detach': {
          if (!this.ensureSessionAuthorized(ws, msg.sessionId, msg.accessToken, 'pty_error') || !this.ensurePtyOwnership(ws, msg.sessionId)) {
            break;
          }
          this.unregisterPtyAttachment(ws.data.connectionId, msg.sessionId);
          break;
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Invalid message format';
      this.send(ws, { type: 'error', sessionId: null, error: errorMessage });
    }
  }

  private async handlePtyAttach(
    ws: ServerWebSocket<WsData>,
    sessionId: string,
    accessToken: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    const session = await terminalService.getSession(sessionId);
    if (!session) {
      this.send(ws, { type: 'pty_error', sessionId, error: 'Session not found' });
      return;
    }

    if (!this.connectionPtySessions.has(ws.data.connectionId)) {
      this.connectionPtySessions.set(ws.data.connectionId, new Map());
    }
    this.connectionPtySessions.get(ws.data.connectionId)?.set(sessionId, accessToken);

    await ptyRuntimeManager.attach(session, ws.data.connectionId, { cols, rows }, (event) => {
      const authError = this.getAuthorizationError(sessionId, accessToken);
      if (authError) {
        this.send(ws, { type: 'pty_error', sessionId, error: authError });
        this.unregisterPtyAttachment(ws.data.connectionId, sessionId);
        this.unregisterSessionSubscription(ws.data.connectionId, sessionId);
        return;
      }

      this.send(ws, event);
    });
  }

  private async handleSend(ws: ServerWebSocket<WsData>, sessionId: string, content: string): Promise<void> {
    try {
      const session = await terminalService.getSession(sessionId);
      if (!session) {
        this.send(ws, { type: 'error', sessionId, error: 'Session not found' });
        return;
      }

      await sessionExecutor.execute(session, content, (event) => {
        this.broadcastToSession(sessionId, event);
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.broadcastToSession(sessionId, { type: 'error', sessionId, error: errorMessage });
    }
  }

  broadcastToSession(sessionId: string, event: WsServerMessage): void {
    const subscribers = this.subscriptions.get(sessionId);
    if (!subscribers) return;

    for (const [connectionId, accessToken] of subscribers.entries()) {
      const ws = this.connections.get(connectionId);
      const authError = this.getAuthorizationError(sessionId, accessToken);
      if (authError) {
        if (ws) {
          this.send(ws, { type: 'error', sessionId, error: authError });
        }
        this.unregisterPtyAttachment(connectionId, sessionId);
        this.unregisterSessionSubscription(connectionId, sessionId);
        continue;
      }

      if (ws) {
        this.send(ws, event);
      }
    }
  }

  private unregisterSessionSubscription(connectionId: string, sessionId: string): void {
    const subscribers = this.subscriptions.get(sessionId);
    if (subscribers) {
      subscribers.delete(connectionId);
      if (subscribers.size === 0) {
        this.subscriptions.delete(sessionId);
      }
    }

    const sessions = this.connectionSessions.get(connectionId);
    if (!sessions) {
      return;
    }

    sessions.delete(sessionId);
    if (sessions.size === 0) {
      this.connectionSessions.delete(connectionId);
    }
  }

  private unregisterPtyAttachment(connectionId: string, sessionId: string): void {
    ptyRuntimeManager.detach(sessionId, connectionId);
    const sessions = this.connectionPtySessions.get(connectionId);
    if (!sessions) {
      return;
    }

    sessions.delete(sessionId);
    if (sessions.size === 0) {
      this.connectionPtySessions.delete(connectionId);
    }
  }

  private ensurePtyOwnership(ws: ServerWebSocket<WsData>, sessionId: string): boolean {
    const sessions = this.connectionPtySessions.get(ws.data.connectionId);
    if (sessions?.has(sessionId)) {
      return true;
    }

    this.send(ws, { type: 'pty_error', sessionId, error: 'Connection is not attached to this PTY session' });
    return false;
  }

  private ensureSessionAuthorized(
    ws: ServerWebSocket<WsData>,
    sessionId: string,
    accessToken: string,
    errorType: 'error' | 'pty_error',
  ): boolean {
    const authError = this.getAuthorizationError(sessionId, accessToken);
    if (!authError) {
      return true;
    }

    if (errorType === 'pty_error') {
      this.send(ws, { type: 'pty_error', sessionId, error: authError });
    } else {
      this.send(ws, { type: 'error', sessionId, error: authError });
    }

    return false;
  }

  private getAuthorizationError(sessionId: string, accessToken: string): string | null {
    const session = getSessionById(sessionId);
    if (session?.restartRequired) {
      return session.restartReason ?? 'Terminal session restart required before continuing.';
    }

    if (sessionAccessTokenManager.validate(sessionId, accessToken)) {
      return null;
    }

    return 'Invalid terminal session access token';
  }

  private send(ws: ServerWebSocket<WsData>, message: WsServerMessage): void {
    ws.send(JSON.stringify(message));
  }
}

export const terminalWsHandler = new TerminalWsHandler();
