import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../../db/index';
import { queryMcpServers, getMcpServerByName } from '../../db/mcp-server-repo';
import { syncOpenCodeMcp } from '../../mcp-servers/opencode-sync';

let tempDir = '';

beforeAll(() => {
  process.env.MARS_DB_PATH = ':memory:';
  initDatabase();
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mars-opencode-sync-'));
  getDb().exec('DELETE FROM mcp_servers');
});

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('syncOpenCodeMcp', () => {
  it('imports target servers and prefers OpenCode definitions for duplicates', async () => {
    const claudePath = join(tempDir, 'claude.json');
    const opencodePath = join(tempDir, 'opencode.json');
    const toolboxPath = join(tempDir, 'toolbox.jsonc');

    writeFileSync(claudePath, JSON.stringify({
      mcpServers: {
        intellij: { type: 'sse', url: 'http://127.0.0.1:9999/sse' },
        context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
        ignored: { command: 'node', args: ['ignore.js'] },
      },
    }, null, 2));

    writeFileSync(opencodePath, JSON.stringify({
      mcp: {
        stitch: {
          type: 'local',
          command: ['npx', '-y', '@_davideast/stitch-mcp', 'proxy'],
          environment: { STITCH_USE_SYSTEM_GCLOUD: '1' },
        },
      },
    }, null, 2));

    writeFileSync(toolboxPath, `{
      // toolbox definitions should win for duplicate names
      "mcp": {
        "intellij": {
          "type": "remote",
          "url": "http://127.0.0.1:64342/sse"
        },
        "pencil": {
          "type": "local",
          "command": ["/Applications/Pencil.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64", "--app", "desktop"]
        }
      }
    }`);

    const result = await syncOpenCodeMcp({
      paths: {
        claude: claudePath,
        opencode: opencodePath,
        toolbox: toolboxPath,
      },
    });

    expect(result.created).toBe(4);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);

    const servers = queryMcpServers({ limit: 10, offset: 0, sortBy: 'name', sortOrder: 'asc' });
    expect(servers.map((server) => server.name)).toEqual(['context7', 'intellij', 'pencil', 'stitch']);

    const intellij = getMcpServerByName('intellij');
    expect(intellij?.url).toBe('http://127.0.0.1:64342/sse');

    const stitch = getMcpServerByName('stitch');
    expect(stitch?.command).toBe('npx');
    expect(stitch?.args).toEqual(['-y', '@_davideast/stitch-mcp', 'proxy']);
    expect(stitch?.env).toEqual({ STITCH_USE_SYSTEM_GCLOUD: '1' });
  });

  it('updates existing records without creating duplicates on re-sync', async () => {
    const claudePath = join(tempDir, 'claude.json');
    const opencodePath = join(tempDir, 'opencode.json');
    const toolboxPath = join(tempDir, 'toolbox.jsonc');

    writeFileSync(claudePath, JSON.stringify({ mcpServers: {} }, null, 2));
    writeFileSync(opencodePath, JSON.stringify({ mcp: {} }, null, 2));
    writeFileSync(toolboxPath, `{
      "mcp": {
        "intellij": {
          "type": "remote",
          "url": "http://127.0.0.1:64342/sse"
        }
      }
    }`);

    const first = await syncOpenCodeMcp({
      paths: {
        claude: claudePath,
        opencode: opencodePath,
        toolbox: toolboxPath,
      },
    });
    expect(first.created).toBe(1);

    writeFileSync(toolboxPath, `{
      "mcp": {
        "intellij": {
          "type": "remote",
          "url": "http://127.0.0.1:64343/sse"
        }
      }
    }`);

    const second = await syncOpenCodeMcp({
      paths: {
        claude: claudePath,
        opencode: opencodePath,
        toolbox: toolboxPath,
      },
    });

    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(0);
    expect(queryMcpServers({ limit: 10, offset: 0 }).length).toBe(1);
    expect(getMcpServerByName('intellij')?.url).toBe('http://127.0.0.1:64343/sse');
  });
});
