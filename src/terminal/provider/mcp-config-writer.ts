import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServer } from '../../types/mcp-server';

interface CliMcpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface CliMcpConfig {
  mcpServers: Record<string, CliMcpServerEntry>;
}

const configDir = mkdtempSync(join(tmpdir(), 'mars-mcp-'));

export function writeMcpConfig(
  servers: McpServer[],
  extraEntries?: Record<string, CliMcpServerEntry>,
): string {
  const config: CliMcpConfig = { mcpServers: {} };

  for (const server of servers) {
    if (!server.enabled) continue;

    if (server.transportType === 'stdio' && server.command) {
      config.mcpServers[server.name] = {
        command: server.command,
        args: server.args,
        env: Object.keys(server.env).length > 0 ? server.env : undefined,
      };
    } else if (server.url) {
      config.mcpServers[server.name] = {
        command: '',
        args: [],
        url: server.url,
        headers: Object.keys(server.headers).length > 0 ? server.headers : undefined,
      };
    }
  }

  if (extraEntries) {
    Object.assign(config.mcpServers, extraEntries);
  }

  const filePath = join(configDir, `mcp-${Date.now()}.json`);
  writeFileSync(filePath, JSON.stringify(config, null, 2));
  return filePath;
}

export type { CliMcpServerEntry };

export function buildCodexMcpFlags(mcpConfigPath: string): string[] {
  try {
    const raw = readFileSync(mcpConfigPath, 'utf-8');
    const config = JSON.parse(raw) as CliMcpConfig;
    const flags: string[] = [];

    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (server.command) {
        flags.push('-c', `mcp_servers.${name}.type="stdio"`);
        flags.push('-c', `mcp_servers.${name}.command="${server.command}"`);
        if (server.args && server.args.length > 0) {
          const argsToml = JSON.stringify(server.args);
          flags.push('-c', `mcp_servers.${name}.args=${argsToml}`);
        }
        if (server.env) {
          for (const [key, value] of Object.entries(server.env)) {
            flags.push('-c', `mcp_servers.${name}.env.${key}="${value}"`);
          }
        }
      } else if (server.url) {
        flags.push('-c', `mcp_servers.${name}.type="sse"`);
        flags.push('-c', `mcp_servers.${name}.url="${server.url}"`);
      }
    }

    return flags;
  } catch {
    return [];
  }
}
