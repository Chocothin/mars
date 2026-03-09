import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../../db/index';
import { insertProject } from '../../db/project-repo';
import { insertAgent } from '../../db/agent-repo';
import { insertProvider } from '../../db/provider-repo';
import { insertMcpServer } from '../../db/mcp-server-repo';
import { insertSession, getSessionById } from '../../db/terminal-repo';
import { ProjectService } from '../../projects/service';
import type { Project } from '../../types/project';
import type { Agent } from '../../types/agent';
import type { Provider } from '../../types/provider';
import type { McpServer } from '../../types/mcp-server';
import type {
  ITerminalService,
  MessageQuery,
  SessionQuery,
  TerminalMessage,
  TerminalSession,
} from '../../types/terminal';

const now = Date.now();
const tempDirs: string[] = [];

function createTempProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mars-project-service-'));
  tempDirs.push(dir);
  return dir;
}

function makeProvider(): Provider {
  return {
    id: 'prov-1',
    name: 'Provider',
    description: '',
    providerType: 'anthropic',
    authMethod: 'api_key',
    apiKey: 'test-key',
    baseUrl: null,
    enabled: true,
    isDefault: true,
    config: {},
    createdAt: now,
    updatedAt: now,
  };
}

function makeProject(): Project {
  return {
    id: 'project-1',
    name: 'Project',
    description: '',
    instructions: '',
    directoryPath: '/tmp/project-1',
    providerId: 'prov-1',
    status: 'active',
    agentIds: [],
    mcpServerIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

function makeAgent(): Agent {
  return {
    id: 'agent-1',
    name: 'Agent',
    description: '',
    providerId: 'prov-1',
    modelId: 'claude-sonnet-4.6',
    systemPrompt: '',
    reasoningLevel: 'none',
    workerCount: 1,
    mcpServerIds: [],
    skillIds: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function makeMcpServer(id: string): McpServer {
  return {
    id,
    name: id,
    description: '',
    transportType: 'stdio',
    command: 'node',
    args: ['server.js'],
    url: null,
    headers: {},
    env: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

class RecordingTerminalService implements ITerminalService {
  deletedSessionChecks: Array<{ sessionId: string; rowExistsAtCleanup: boolean }> = [];

  async getOrCreateSession(_projectId: string, _agentId: string, _mcpServerIds?: string[]): Promise<TerminalSession> {
    throw new Error('not implemented');
  }

  async getSession(_sessionId: string): Promise<TerminalSession | null> {
    return null;
  }

  async getSessionByProjectAgent(_projectId: string, _agentId: string): Promise<TerminalSession | null> {
    return null;
  }

  async listSessions(_query: SessionQuery): Promise<TerminalSession[]> {
    return [];
  }

  async restartSession(_sessionId: string): Promise<TerminalSession | null> {
    return null;
  }

  async markSessionsForMcpServerChange(_mcpServerId: string, _reason: string): Promise<string[]> {
    return [];
  }

  async markSessionsForProviderChange(_providerId: string, _reason: string): Promise<string[]> {
    return [];
  }

  async markSessionsForAgentChange(_agentId: string, _reason: string): Promise<string[]> {
    return [];
  }

  async markSessionsForProjectChange(_projectId: string, _reason: string): Promise<string[]> {
    return [];
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    this.deletedSessionChecks.push({
      sessionId,
      rowExistsAtCleanup: getSessionById(sessionId) !== null,
    });
    return false;
  }

  async getMessages(_query: MessageQuery): Promise<TerminalMessage[]> {
    return [];
  }

  async clearMessages(_sessionId: string): Promise<void> {}
}

describe('ProjectService update validation', () => {
  beforeAll(() => {
    process.env.MARS_DB_PATH = ':memory:';
    initDatabase();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM terminal_messages');
    db.exec('DELETE FROM terminal_sessions');
    db.exec('DELETE FROM task_dependencies');
    db.exec('DELETE FROM task_executions');
    db.exec('DELETE FROM tasks');
    db.exec('DELETE FROM runs');
    db.exec('DELETE FROM projects');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM mcp_servers');
    db.exec('DELETE FROM providers');

    insertProvider(makeProvider());
    insertAgent(makeAgent());
    insertProject(makeProject());
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('rejects unknown mcpServerIds on update', async () => {
    const service = new ProjectService();
    await expect(service.update('project-1', { mcpServerIds: ['missing-mcp'] })).rejects.toThrow('MCP server not found: missing-mcp');
  });

  it('accepts existing mcpServerIds on update', async () => {
    insertMcpServer(makeMcpServer('known-mcp'));
    const service = new ProjectService();

    const updated = await service.update('project-1', { mcpServerIds: ['known-mcp'] });
    expect(updated?.mcpServerIds).toEqual(['known-mcp']);
  });

  it('cleans up terminal runtime only after project-scoped DB rows are deleted', async () => {
    const directoryPath = createTempProjectDir();
    mkdirSync(join(directoryPath, '.mars', 'orchestration'), { recursive: true });

    const db = getDb();
    db.prepare('UPDATE projects SET directory_path = $directoryPath WHERE id = $id').run({
      $directoryPath: directoryPath,
      $id: 'project-1',
    });

    insertSession({
      id: 'session-1',
      projectId: 'project-1',
      agentId: 'agent-1',
      mcpServerIds: [],
      workingDirectory: directoryPath,
      status: 'idle',
      cliSessionId: null,
      accessToken: 'token',
      runtimeFingerprint: null,
      runtimeVersion: 1,
      restartRequired: false,
      restartReason: null,
      restartMarkedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const terminalService = new RecordingTerminalService();
    const service = new ProjectService({ terminalService });

    await expect(service.delete('project-1')).resolves.toBe(true);

    expect(terminalService.deletedSessionChecks).toEqual([
      { sessionId: 'session-1', rowExistsAtCleanup: false },
    ]);
    expect(getSessionById('session-1')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) as count FROM projects WHERE id = $id').get({ $id: 'project-1' })).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) as count FROM terminal_sessions').get()).toEqual({ count: 0 });
  });
});
