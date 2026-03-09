import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, getDb } from '../../db/index';
import { insertProvider } from '../../db/provider-repo';
import { CodexCliExecutor } from '../../providers/codex-cli';
import { writeMcpConfig } from '../../terminal/provider/mcp-config-writer';
import type { Provider } from '../../types/provider';
import type { McpServer } from '../../types/mcp-server';

const now = Date.now();

function makeProvider(cliPath: string): Provider {
  return {
    id: 'prov-codex',
    name: 'Codex',
    description: '',
    providerType: 'openai',
    authMethod: 'oauth',
    apiKey: null,
    baseUrl: null,
    enabled: true,
    isDefault: false,
    config: { cliPath },
    createdAt: now,
    updatedAt: now,
  };
}

describe('CodexCliExecutor', () => {
  let tempDir = '';

  beforeAll(() => {
    process.env.MARS_DB_PATH = ':memory:';
    initDatabase();
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM providers');
    tempDir = mkdtempSync(join(tmpdir(), 'mars-codex-test-'));
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('passes MCP wiring flags through to Codex CLI execution as -c TOML flags', async () => {
    const cliPath = join(tempDir, 'codex-mock.sh');
    writeFileSync(
      cliPath,
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: process.argv.slice(2).join(" ") } }));\n',
    );
    chmodSync(cliPath, 0o755);

    insertProvider(makeProvider(cliPath));

    const now = Date.now();
    const mcpServer: McpServer = {
      id: 'mcp-test',
      name: 'test-server',
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
    const mcpConfigPath = writeMcpConfig([mcpServer]);

    const executor = new CodexCliExecutor();
    const result = await executor.execute('prov-codex', {
      prompt: 'do work',
      allowedTools: ['mars-orchestrator', 'shared-mcp'],
      mcpConfig: mcpConfigPath,
      workingDirectory: '/tmp/project',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('--allowedTools mars-orchestrator');
    expect(result.output).toContain('--allowedTools shared-mcp');
    expect(result.output).not.toContain('--mcp-config');
    expect(result.output).toContain('-c mcp_servers.test-server.type="stdio"');
    expect(result.output).toContain('-c mcp_servers.test-server.command="node"');
    expect(result.output).toContain('--cd /tmp/project');
  });
});
