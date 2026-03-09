import { countProjects } from '../db/project-repo';
import { countTasks, getTaskStatusBreakdown } from '../db/task-repo';
import { countAgents } from '../db/agent-repo';
import { queryRuns } from '../db/run-repo';
import { getProviderHealthSummary } from '../db/provider-repo';
import { getMcpServerHealthSummary } from '../db/mcp-server-repo';
import type { ApiResponse } from '../types/common';

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { success: false, error: message } satisfies ApiResponse,
    { status },
  );
}

function aggregateHealthStatus(
  providerStatus: 'healthy' | 'degraded' | 'offline',
  mcpStatus: 'healthy' | 'degraded' | 'offline',
): 'healthy' | 'degraded' | 'offline' {
  if (providerStatus === 'offline' || mcpStatus === 'offline') return 'offline';
  if (providerStatus === 'degraded' || mcpStatus === 'degraded') return 'degraded';
  return 'healthy';
}

export async function handleDashboardRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== '/api/dashboard/summary') {
    return null;
  }

  if (req.method !== 'GET') {
    return null;
  }

  try {
    const recentRuns = queryRuns({ limit: 5, sortBy: 'createdAt', sortOrder: 'desc' });
    const providerHealth = getProviderHealthSummary();
    const mcpHealth = getMcpServerHealthSummary();

    const data = {
      counts: {
        projects: countProjects(),
        tasks: countTasks(),
        agents: countAgents(),
      },
      taskStatusBreakdown: getTaskStatusBreakdown(),
      recentRuns,
      health: {
        providers: providerHealth,
        mcpServers: mcpHealth,
        status: aggregateHealthStatus(providerHealth.status, mcpHealth.status),
      },
    };

    return Response.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return errorResponse(message, 500);
  }
}
