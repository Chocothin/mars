import { createMCPClient } from '@ai-sdk/mcp';
import type { MCPClient } from '@ai-sdk/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolSet } from 'ai';
import type { McpServer, TransportType } from '../types/mcp-server';

interface PoolEntry {
  client: MCPClient;
  serverId: string;
  serverName: string;
}

function buildTransport(server: McpServer): StdioClientTransport | { type: 'sse' | 'http'; url: string; headers?: Record<string, string> } {
  if (server.transportType === 'stdio') {
    if (!server.command) {
      throw new Error(`MCP server "${server.name}" (stdio) requires a command`);
    }
    return new StdioClientTransport({
      command: server.command,
      args: server.args.length > 0 ? server.args : undefined,
      env: Object.keys(server.env).length > 0
        ? { ...process.env, ...server.env } as Record<string, string>
        : undefined,
    });
  }

  if (server.transportType === 'sse' || server.transportType === 'streamable-http') {
    if (!server.url) {
      throw new Error(`MCP server "${server.name}" (${server.transportType}) requires a url`);
    }
    const transportType: 'sse' | 'http' = server.transportType === 'sse' ? 'sse' : 'http';
    return {
      type: transportType,
      url: server.url,
      ...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
    };
  }

  throw new Error(`Unsupported transport type: ${server.transportType satisfies never}`);
}

export class McpConnectionPool {
  private entries: Map<string, PoolEntry> = new Map();
  private connecting: Map<string, Promise<MCPClient>> = new Map();

  async connect(server: McpServer): Promise<MCPClient> {
    const existing = this.entries.get(server.id);
    if (existing) {
      return existing.client;
    }

    const inflight = this.connecting.get(server.id);
    if (inflight) {
      return inflight;
    }

    const promise = this.createClient(server);
    this.connecting.set(server.id, promise);

    try {
      const client = await promise;
      this.entries.set(server.id, {
        client,
        serverId: server.id,
        serverName: server.name,
      });
      return client;
    } finally {
      this.connecting.delete(server.id);
    }
  }

  async getTools(servers: McpServer[]): Promise<ToolSet> {
    if (servers.length === 0) return {};

    const results = await Promise.allSettled(
      servers.map(async (server) => {
        const client = await this.connect(server);
        return client.tools();
      }),
    );

    let merged: ToolSet = {};
    for (const result of results) {
      if (result.status === 'fulfilled') {
        merged = { ...merged, ...result.value };
      }
    }
    return merged;
  }

  async invalidate(serverId: string): Promise<void> {
    const entry = this.entries.get(serverId);
    if (!entry) return;

    this.entries.delete(serverId);

    try {
      await entry.client.close();
    } catch {
      // ignore close errors
    }
  }

  async invalidateAll(): Promise<void> {
    const ids = Array.from(this.entries.keys());
    await Promise.allSettled(ids.map((id) => this.invalidate(id)));
  }

  async closeAll(): Promise<void> {
    await this.invalidateAll();
  }

  has(serverId: string): boolean {
    return this.entries.has(serverId);
  }

  get size(): number {
    return this.entries.size;
  }

  private async createClient(server: McpServer): Promise<MCPClient> {
    const transport = buildTransport(server);
    return createMCPClient({
      transport,
      name: `mars-mcp-${server.name}`,
      version: '1.0.0',
      onUncaughtError: (error) => {
        console.error(`[MCP Pool] Uncaught error from "${server.name}":`, error);
      },
    });
  }
}

export const mcpConnectionPool = new McpConnectionPool();
