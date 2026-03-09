import { existsSync, readFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { McpServerService } from './service';
import { getMcpServerByName } from '../db/mcp-server-repo';
import { mcpConnectionPool } from '../mcp/pool';
import type { CreateMcpServerInput, McpServer, UpdateMcpServerInput } from '../types/mcp-server';

type ConfigSource = 'claude' | 'opencode' | 'toolbox';

interface ImportedServerDefinition {
  name: string;
  source: ConfigSource;
  input: CreateMcpServerInput;
}

interface ConnectivityResult {
  name: string;
  ok: boolean;
  toolCount?: number;
  error?: string;
}

interface ConnectivityWorkerData {
  server: McpServer;
}

export interface SyncOpenCodeMcpOptions {
  testConnectivity?: boolean;
  paths?: Partial<Record<ConfigSource, string>>;
}

export interface SyncOpenCodeMcpResult {
  created: number;
  updated: number;
  unchanged: number;
  syncedServers: McpServer[];
  connectivity: ConnectivityResult[];
}

const DEFAULT_PATHS: Record<ConfigSource, string> = {
  claude: '/Users/mk-mac-391/.claude/.mcp.json',
  opencode: '/Users/mk-mac-391/.config/opencode/opencode.json',
  toolbox: '/Users/mk-mac-391/.config/opencode/toolbox.jsonc',
};

const TARGET_NAMES: Record<ConfigSource, ReadonlySet<string>> = {
  claude: new Set(['intellij', 'context7', 'exa', 'filesystem', 'github', 'opencode-session', 'db-readonly']),
  opencode: new Set(['stitch', 'pencil']),
  toolbox: new Set([
    'intellij',
    'mcp-obsidian',
    'atlassian',
    'db-readonly',
    'playwriter',
    'google-sheets',
    'slack',
    'stitch',
    'jira-lite',
    'penpot-community',
    'penpot-official',
    'swarm-claw',
    'pencil',
  ]),
};

const SOURCE_PRIORITY: Record<ConfigSource, number> = {
  claude: 1,
  opencode: 2,
  toolbox: 3,
};

const CONNECTIVITY_TIMEOUT_MS = 3000;

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function parseStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const entries = Object.entries(value).filter(([, entry]) => typeof entry === 'string');
  return Object.fromEntries(entries);
}

function inferRemoteTransport(url: string): 'sse' | 'streamable-http' {
  return url.endsWith('/sse') ? 'sse' : 'streamable-http';
}

function stripJsonComments(input: string): string {
  let result = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? '';
    const next = input[index + 1] ?? '';

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
    }

    result += char;
  }

  return result;
}

function parseClaudeServer(name: string, value: unknown): ImportedServerDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (typeof raw.url === 'string') {
    return {
      name,
      source: 'claude',
      input: {
        name,
        description: 'Imported from local Claude MCP config.',
        transportType: raw.type === 'sse' ? 'sse' : inferRemoteTransport(raw.url),
        url: raw.url,
        headers: parseStringRecord(raw.headers),
        enabled: raw.enabled !== false,
      },
    };
  }

  if (typeof raw.command !== 'string') {
    return null;
  }

  return {
    name,
    source: 'claude',
    input: {
      name,
      description: 'Imported from local Claude MCP config.',
      transportType: 'stdio',
      command: raw.command,
      args: parseStringArray(raw.args),
      env: parseStringRecord(raw.env),
      enabled: raw.enabled !== false,
    },
  };
}

function parseOpenCodeServer(name: string, value: unknown, source: 'opencode' | 'toolbox'): ImportedServerDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const type = raw.type;

  if (type === 'remote' && typeof raw.url === 'string') {
    return {
      name,
      source,
      input: {
        name,
        description: 'Imported from local OpenCode MCP config.',
        transportType: inferRemoteTransport(raw.url),
        url: raw.url,
        headers: parseStringRecord(raw.headers),
        enabled: raw.enabled !== false,
      },
    };
  }

  const command = parseStringArray(raw.command);
  if (command.length === 0) {
    return null;
  }

  const [binary, ...args] = command;
  if (!binary) {
    return null;
  }

  return {
    name,
    source,
    input: {
      name,
      description: 'Imported from local OpenCode MCP config.',
      transportType: 'stdio',
      command: binary,
      args,
      env: parseStringRecord(raw.environment),
      enabled: raw.enabled !== false,
    },
  };
}

function parseConfigFile(source: ConfigSource, filePath: string): ImportedServerDefinition[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const rawText = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(source === 'toolbox' ? stripJsonComments(rawText) : rawText) as Record<string, unknown>;
  const sectionKey = source === 'claude' ? 'mcpServers' : 'mcp';
  const section = parsed[sectionKey];

  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    return [];
  }

  const results: ImportedServerDefinition[] = [];
  for (const [name, value] of Object.entries(section)) {
    if (!TARGET_NAMES[source].has(name)) {
      continue;
    }

    const parsedEntry = source === 'claude'
      ? parseClaudeServer(name, value)
      : parseOpenCodeServer(name, value, source);

    if (parsedEntry) {
      results.push(parsedEntry);
    }
  }

  return results;
}

function definitionsEqual(existing: McpServer, input: CreateMcpServerInput): boolean {
  return existing.transportType === input.transportType
    && existing.command === (input.command ?? null)
    && JSON.stringify(existing.args) === JSON.stringify(input.args ?? [])
    && existing.url === (input.url ?? null)
    && JSON.stringify(existing.headers) === JSON.stringify(input.headers ?? {})
    && JSON.stringify(existing.env) === JSON.stringify(input.env ?? {})
    && existing.enabled === (input.enabled ?? true);
}

function toUpdateInput(input: CreateMcpServerInput): UpdateMcpServerInput {
  return {
    name: input.name,
    transportType: input.transportType,
    command: input.transportType === 'stdio' ? (input.command ?? null) : null,
    args: input.transportType === 'stdio' ? (input.args ?? []) : [],
    url: input.transportType === 'stdio' ? null : (input.url ?? null),
    headers: input.transportType === 'stdio' ? {} : (input.headers ?? {}),
    env: input.transportType === 'stdio' ? (input.env ?? {}) : {},
    enabled: input.enabled ?? true,
  };
}

async function testConnectivity(servers: McpServer[]): Promise<ConnectivityResult[]> {
  const results: ConnectivityResult[] = [];

  for (const server of servers) {
    results.push(await testConnectivityWithTimeout(server));
  }

  return results;
}

async function testConnectivityWithTimeout(server: McpServer): Promise<ConnectivityResult> {
  return await new Promise<ConnectivityResult>((resolve) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { server } satisfies ConnectivityWorkerData,
    });

    let settled = false;

    const finish = (result: ConnectivityResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      void worker.terminate();
      resolve(result);
    };

    worker.once('message', (message: Omit<ConnectivityResult, 'name'>) => {
      finish({ name: server.name, ...message });
    });

    worker.once('error', (error) => {
      finish({
        name: server.name,
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown connectivity error',
      });
    });

    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        finish({
          name: server.name,
          ok: false,
          error: `Connectivity worker exited with code ${code}`,
        });
      }
    });

    const timeoutId = setTimeout(() => {
      finish({
        name: server.name,
        ok: false,
        error: `Timed out after ${CONNECTIVITY_TIMEOUT_MS}ms`,
      });
    }, CONNECTIVITY_TIMEOUT_MS);
  });
}

async function runConnectivityWorker(server: McpServer): Promise<void> {
  try {
    const client = await mcpConnectionPool.connect(server);
    const tools = await client.tools();
    parentPort?.postMessage({ ok: true, toolCount: Object.keys(tools).length } satisfies Omit<ConnectivityResult, 'name'>);
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown connectivity error',
    } satisfies Omit<ConnectivityResult, 'name'>);
  } finally {
    await mcpConnectionPool.invalidate(server.id);
  }
}

if (!isMainThread && parentPort) {
  void runConnectivityWorker((workerData as ConnectivityWorkerData).server);
}

export async function syncOpenCodeMcp(options: SyncOpenCodeMcpOptions = {}): Promise<SyncOpenCodeMcpResult> {
  const service = new McpServerService();
  const paths = { ...DEFAULT_PATHS, ...options.paths };
  const deduped = new Map<string, ImportedServerDefinition>();

  for (const source of ['claude', 'opencode', 'toolbox'] as const) {
    const definitions = parseConfigFile(source, paths[source]);

    for (const definition of definitions) {
      const existing = deduped.get(definition.name);
      if (!existing || SOURCE_PRIORITY[definition.source] >= SOURCE_PRIORITY[existing.source]) {
        deduped.set(definition.name, definition);
      }
    }
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const syncedServers: McpServer[] = [];

  for (const definition of deduped.values()) {
    const existing = getMcpServerByName(definition.name);
    if (!existing) {
      const createdServer = await service.create(definition.input);
      syncedServers.push(createdServer);
      created += 1;
      continue;
    }

    if (definitionsEqual(existing, definition.input)) {
      syncedServers.push(existing);
      unchanged += 1;
      continue;
    }

    const updatedServer = await service.update(existing.id, toUpdateInput(definition.input));
    if (!updatedServer) {
      throw new Error(`Failed to update MCP server: ${existing.name}`);
    }

    syncedServers.push(updatedServer);
    updated += 1;
  }

  return {
    created,
    updated,
    unchanged,
    syncedServers,
    connectivity: options.testConnectivity ? await testConnectivity(syncedServers) : [],
  };
}
