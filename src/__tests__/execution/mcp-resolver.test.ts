import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { initDatabase, getDb } from '../../db/index';
import { insertAgent } from '../../db/agent-repo';
import { insertMcpServer } from '../../db/mcp-server-repo';
import { insertProject } from '../../db/project-repo';
import { mergeMcpServerIds, resolveMcpScope, resolveMcpServersById } from '../../mcp/resolution';
import type { Agent } from '../../types/agent';
import type { McpServer } from '../../types/mcp-server';
import type { Project } from '../../types/project';

const now = Date.now();

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: overrides.id ?? 'agent-1',
    name: overrides.name ?? 'Agent',
    description: overrides.description ?? '',
    providerId: overrides.providerId ?? 'prov-1',
    modelId: overrides.modelId ?? 'model-1',
    systemPrompt: overrides.systemPrompt ?? '',
    reasoningLevel: overrides.reasoningLevel ?? 'none',
    workerCount: overrides.workerCount ?? 1,
    skillIds: overrides.skillIds ?? [],
    mcpServerIds: overrides.mcpServerIds ?? [],
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'project-1',
    name: overrides.name ?? 'Project',
    description: overrides.description ?? '',
    instructions: overrides.instructions ?? '',
    directoryPath: overrides.directoryPath ?? '/tmp/project',
    providerId: overrides.providerId,
    status: overrides.status ?? 'active',
    agentIds: overrides.agentIds ?? ['agent-1'],
    mcpServerIds: overrides.mcpServerIds ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function makeServer(overrides: Partial<McpServer> & { id: string; name: string }): McpServer {
  return {
    id: overrides.id,
    name: overrides.name,
    description: overrides.description ?? '',
    transportType: overrides.transportType ?? 'stdio',
    command: overrides.command ?? 'node',
    args: overrides.args ?? ['server.js'],
    url: overrides.url ?? null,
    headers: overrides.headers ?? {},
    env: overrides.env ?? {},
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

describe('mcp resolution', () => {
  beforeAll(() => {
    process.env.MARS_DB_PATH = ':memory:';
    initDatabase();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM mcp_servers');
    db.exec('DELETE FROM agents');
    db.exec('DELETE FROM projects');
  });

  it('preserves project-agent-override order while removing duplicates', () => {
    expect(
      mergeMcpServerIds(['project-1', 'shared'], ['agent-1', 'shared'], ['override-1', 'project-1']),
    ).toEqual(['project-1', 'shared', 'agent-1', 'override-1']);
  });

  it('resolves deduped enabled ids and server records from project, agent, and override scope', () => {
    insertMcpServer(makeServer({ id: 'project-mcp', name: 'project-mcp' }));
    insertMcpServer(makeServer({ id: 'shared-mcp', name: 'shared-mcp' }));
    insertMcpServer(makeServer({ id: 'agent-mcp', name: 'agent-mcp' }));
    insertMcpServer(makeServer({ id: 'override-mcp', name: 'override-mcp' }));

    insertProject(makeProject({ mcpServerIds: ['project-mcp', 'shared-mcp'] }));
    insertAgent(makeAgent({ mcpServerIds: ['agent-mcp', 'shared-mcp'] }));

    const resolved = resolveMcpScope({
      projectId: 'project-1',
      agentId: 'agent-1',
      overrideMcpServerIds: ['override-mcp', 'project-mcp'],
    });

    expect(resolved.mcpServerIds).toEqual(['project-mcp', 'shared-mcp', 'agent-mcp', 'override-mcp']);
    expect(resolved.mcpServers.map((server) => server.id)).toEqual(resolved.mcpServerIds);
  });

  it('filters disabled and missing servers while keeping valid order', () => {
    insertMcpServer(makeServer({ id: 'enabled-a', name: 'enabled-a' }));
    insertMcpServer(makeServer({ id: 'disabled-a', name: 'disabled-a', enabled: false }));
    insertMcpServer(makeServer({ id: 'enabled-b', name: 'enabled-b' }));

    const resolved = resolveMcpServersById(['enabled-a', 'missing-a', 'disabled-a', 'enabled-b', 'enabled-a']);

    expect(resolved.mcpServerIds).toEqual(['enabled-a', 'enabled-b']);
    expect(resolved.mcpServers.map((server) => server.id)).toEqual(['enabled-a', 'enabled-b']);
  });

  it('returns empty results when scoped project or agent records are missing', () => {
    const resolved = resolveMcpScope({
      projectId: 'missing-project',
      agentId: 'missing-agent',
      overrideMcpServerIds: ['missing-server'],
    });

    expect(resolved.mcpServerIds).toEqual([]);
    expect(resolved.mcpServers).toEqual([]);
  });
});
