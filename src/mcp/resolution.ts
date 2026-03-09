import { getAgentById } from '../db/agent-repo';
import { getMcpServerById } from '../db/mcp-server-repo';
import { getProjectById } from '../db/project-repo';
import type { McpServer } from '../types/mcp-server';

export interface ResolveMcpScopeParams {
  projectId?: string;
  agentId?: string;
  overrideMcpServerIds?: readonly string[];
}

export interface ResolvedMcpScope {
  mcpServerIds: string[];
  mcpServers: McpServer[];
}

export function mergeMcpServerIds(...sources: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    for (const id of source) {
      if (seen.has(id)) {
        continue;
      }

      seen.add(id);
      merged.push(id);
    }
  }

  return merged;
}

export function resolveMcpServersById(mcpServerIds: readonly string[]): ResolvedMcpScope {
  const resolvedIds: string[] = [];
  const resolvedServers: McpServer[] = [];
  const seen = new Set<string>();

  for (const serverId of mcpServerIds) {
    if (seen.has(serverId)) {
      continue;
    }

    seen.add(serverId);

    const server = getMcpServerById(serverId);
    if (!server || !server.enabled) {
      continue;
    }

    resolvedIds.push(server.id);
    resolvedServers.push(server);
  }

  return {
    mcpServerIds: resolvedIds,
    mcpServers: resolvedServers,
  };
}

export function resolveMcpScope(params: ResolveMcpScopeParams): ResolvedMcpScope {
  const projectMcpServerIds = params.projectId
    ? (getProjectById(params.projectId)?.mcpServerIds ?? [])
    : [];
  const agentMcpServerIds = params.agentId
    ? (getAgentById(params.agentId)?.mcpServerIds ?? [])
    : [];
  const mergedMcpServerIds = mergeMcpServerIds(
    projectMcpServerIds,
    agentMcpServerIds,
    params.overrideMcpServerIds ?? [],
  );

  return resolveMcpServersById(mergedMcpServerIds);
}
