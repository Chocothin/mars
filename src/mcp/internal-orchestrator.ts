import { fileURLToPath } from 'node:url';
import type { McpServer } from '../types/mcp-server';

export const MARS_ORCHESTRATOR_MCP_ID = 'builtin:mars-orchestrator';
export const MARS_ORCHESTRATOR_MCP_NAME = 'mars-orchestrator';

export function createInternalOrchestratorMcpServer(projectId: string): McpServer {
  const env: Record<string, string> = {};

  if (process.env.MARS_DB_PATH) {
    env.MARS_DB_PATH = process.env.MARS_DB_PATH;
  }

  env.MARS_PROJECT_ID = projectId;

  return {
    id: MARS_ORCHESTRATOR_MCP_ID,
    name: MARS_ORCHESTRATOR_MCP_NAME,
    description: 'Built-in orchestrator tool server for project-scoped agent execution.',
    transportType: 'stdio',
    command: process.execPath,
    args: [fileURLToPath(new URL('./mars-orchestrator-server.ts', import.meta.url))],
    url: null,
    headers: {},
    env,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}
