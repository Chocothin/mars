import { randomUUID } from 'node:crypto';
import { getSessionById, updateSessionLifecycle } from '../db/terminal-repo';

export class SessionAccessTokenManager {
  getOrCreate(sessionId: string): string {
    const session = getSessionById(sessionId);
    if (!session) {
      throw new Error('Terminal session not found: ' + sessionId);
    }

    if (session.accessToken) {
      return session.accessToken;
    }

    return this.rotate(sessionId);
  }

  validate(sessionId: string, token: string): boolean {
    const session = getSessionById(sessionId);
    return session?.accessToken === token;
  }

  rotate(sessionId: string): string {
    const token = randomUUID();
    updateSessionLifecycle(sessionId, { accessToken: token });
    return token;
  }

  revoke(sessionId: string): void {
    updateSessionLifecycle(sessionId, { accessToken: '' });
  }
}

export const sessionAccessTokenManager = new SessionAccessTokenManager();
