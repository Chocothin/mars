import type {
  McpServer,
  CreateMcpServerInput,
  UpdateMcpServerInput,
  McpServerQuery,
  IMcpServerService,
} from '../types/mcp-server';
import {
  insertMcpServer,
  getMcpServerById,
  getMcpServerByName,
  updateMcpServer,
  deleteMcpServer,
  queryMcpServers,
} from '../db/mcp-server-repo';
import { randomUUID } from 'node:crypto';

export class McpServerService implements IMcpServerService {
  async create(input: CreateMcpServerInput): Promise<McpServer> {
    this.validateTransport(input.transportType, input.command ?? null, input.url ?? null);

    const existing = getMcpServerByName(input.name);
    if (existing) {
      throw new Error(`MCP server with name "${input.name}" already exists`);
    }

    const now = Date.now();
    const server: McpServer = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? '',
      transportType: input.transportType,
      command: input.command ?? null,
      args: input.args ?? [],
      url: input.url ?? null,
      headers: input.headers ?? {},
      env: input.env ?? {},
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };

    insertMcpServer(server);
    return server;
  }

  async getById(id: string): Promise<McpServer | null> {
    return getMcpServerById(id);
  }

  async update(id: string, input: UpdateMcpServerInput): Promise<McpServer | null> {
    const existing = getMcpServerById(id);
    if (!existing) return null;

    if (input.name !== undefined) {
      const byName = getMcpServerByName(input.name);
      if (byName && byName.id !== id) {
        throw new Error(`MCP server with name "${input.name}" already exists`);
      }
    }

    const effectiveTransport = input.transportType ?? existing.transportType;
    const effectiveCommand = input.command !== undefined ? input.command : existing.command;
    const effectiveUrl = input.url !== undefined ? input.url : existing.url;
    this.validateTransport(effectiveTransport, effectiveCommand, effectiveUrl);

    const updates: Partial<McpServer> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.transportType !== undefined) updates.transportType = input.transportType;
    if (input.command !== undefined) updates.command = input.command;
    if (input.args !== undefined) updates.args = input.args;
    if (input.url !== undefined) updates.url = input.url;
    if (input.headers !== undefined) updates.headers = input.headers;
    if (input.env !== undefined) updates.env = input.env;
    if (input.enabled !== undefined) updates.enabled = input.enabled;

    const changed = updateMcpServer(id, updates);
    if (!changed) return existing;

    return getMcpServerById(id);
  }

  async delete(id: string): Promise<boolean> {
    return deleteMcpServer(id);
  }

  async list(query: McpServerQuery): Promise<McpServer[]> {
    return queryMcpServers(query);
  }

  private validateTransport(
    transportType: string,
    command: string | null,
    url: string | null,
  ): void {
    if (transportType === 'stdio') {
      if (!command) {
        throw new Error('command is required for stdio transport');
      }
    } else {
      if (!url) {
        throw new Error(`url is required for ${transportType} transport`);
      }
    }
  }
}
