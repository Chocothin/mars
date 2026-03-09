import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { McpServer } from '../../types/mcp-server';

interface MockMCPClient {
  tools: () => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}

const mockClose = mock((): Promise<void> => Promise.resolve());
const mockTools = mock((): Promise<Record<string, unknown>> =>
  Promise.resolve({ toolA: { description: 'A' } }),
);
const mockCreateMCPClient = mock((): Promise<MockMCPClient> =>
  Promise.resolve({ tools: mockTools, close: mockClose }),
);
const MockStdioTransport = mock(function (this: unknown): object {
  return {};
});

mock.module('@ai-sdk/mcp', () => ({
  createMCPClient: mockCreateMCPClient,
}));

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: MockStdioTransport,
}));

const { McpConnectionPool } = await import('../../mcp/pool');

const now = Date.now();

function makeServer(id: string, overrides?: Partial<McpServer>): McpServer {
  return {
    id,
    name: `server-${id}`,
    description: '',
    transportType: 'sse',
    command: null,
    args: [],
    url: 'http://localhost:3000/mcp',
    headers: {},
    env: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

let pool: InstanceType<typeof McpConnectionPool>;

beforeEach(() => {
  pool = new McpConnectionPool();
  mockClose.mockClear();
  mockTools.mockClear();
  mockCreateMCPClient.mockClear();
  MockStdioTransport.mockClear();
});

describe('McpConnectionPool', () => {
  describe('connect()', () => {
    it('creates a new MCPClient for a stdio server', async () => {
      const server = makeServer('s1', {
        transportType: 'stdio',
        command: '/usr/bin/node',
        args: ['server.js'],
      });
      await pool.connect(server);
      expect(MockStdioTransport).toHaveBeenCalledWith(
        expect.objectContaining({ command: '/usr/bin/node', args: ['server.js'] }),
      );
      expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
    });

    it('returns cached client on second call (same server id)', async () => {
      const server = makeServer('s1');
      const c1 = await pool.connect(server);
      const c2 = await pool.connect(server);
      expect(c1).toBe(c2);
      expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
    });

    it('deduplicates inflight connections (concurrent calls same server)', async () => {
      const server = makeServer('s1');
      const results = await Promise.all([pool.connect(server), pool.connect(server)]);
      expect(results[0]).toBe(results[1]);
      expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
    });

    it('creates SSE transport for sse type', async () => {
      const server = makeServer('s1', {
        transportType: 'sse',
        url: 'http://localhost:3000/sse',
      });
      await pool.connect(server);
      expect(mockCreateMCPClient).toHaveBeenCalledWith(
        expect.objectContaining({
          transport: { type: 'sse', url: 'http://localhost:3000/sse' },
        }),
      );
    });

    it('creates HTTP transport for streamable-http type', async () => {
      const server = makeServer('s1', {
        transportType: 'streamable-http',
        url: 'http://localhost:3000/http',
      });
      await pool.connect(server);
      expect(mockCreateMCPClient).toHaveBeenCalledWith(
        expect.objectContaining({
          transport: { type: 'http', url: 'http://localhost:3000/http' },
        }),
      );
    });

    it('throws when stdio server has no command', async () => {
      const server = makeServer('s1', { transportType: 'stdio', command: null });
      await expect(pool.connect(server)).rejects.toThrow('requires a command');
    });

    it('throws when SSE server has no url', async () => {
      const server = makeServer('s1', { transportType: 'sse', url: null });
      await expect(pool.connect(server)).rejects.toThrow('requires a url');
    });
  });

  describe('getTools()', () => {
    it('returns empty object for empty servers array', async () => {
      const result = await pool.getTools([]);
      expect(result).toEqual({});
    });

    it('merges tools from multiple servers', async () => {
      const s1 = makeServer('s1');
      const s2 = makeServer('s2');
      const tools1 = mock((): Promise<Record<string, unknown>> =>
        Promise.resolve({ toolA: { description: 'A' } }),
      );
      const tools2 = mock((): Promise<Record<string, unknown>> =>
        Promise.resolve({ toolB: { description: 'B' } }),
      );
      mockCreateMCPClient
        .mockImplementationOnce((): Promise<MockMCPClient> =>
          Promise.resolve({ tools: tools1, close: mockClose }),
        )
        .mockImplementationOnce((): Promise<MockMCPClient> =>
          Promise.resolve({ tools: tools2, close: mockClose }),
        );
      const result = await pool.getTools([s1, s2]);
      expect(result).toHaveProperty('toolA');
      expect(result).toHaveProperty('toolB');
    });

    it('ignores failed servers (settled rejection)', async () => {
      const s1 = makeServer('s1');
      const s2 = makeServer('s2');
      mockCreateMCPClient
        .mockImplementationOnce((): Promise<MockMCPClient> =>
          Promise.resolve({ tools: mockTools, close: mockClose }),
        )
        .mockImplementationOnce((): Promise<MockMCPClient> =>
          Promise.reject(new Error('connection failed')),
        );
      const result = await pool.getTools([s1, s2]);
      expect(result).toHaveProperty('toolA');
    });
  });

  describe('invalidate()', () => {
    it('closes client and removes from pool', async () => {
      const server = makeServer('s1');
      await pool.connect(server);
      expect(pool.has('s1')).toBe(true);
      await pool.invalidate('s1');
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(pool.has('s1')).toBe(false);
    });

    it('is no-op for unknown server id', async () => {
      await pool.invalidate('unknown');
      expect(mockClose).not.toHaveBeenCalled();
    });

    it('ignores close errors', async () => {
      const server = makeServer('s1');
      await pool.connect(server);
      mockClose.mockRejectedValueOnce(new Error('close failed'));
      await expect(pool.invalidate('s1')).resolves.toBeUndefined();
      expect(pool.has('s1')).toBe(false);
    });
  });

  describe('invalidateAll() / closeAll()', () => {
    it('invalidateAll() closes all entries', async () => {
      await pool.connect(makeServer('s1'));
      await pool.connect(makeServer('s2'));
      expect(pool.size).toBe(2);
      await pool.invalidateAll();
      expect(pool.size).toBe(0);
      expect(mockClose).toHaveBeenCalledTimes(2);
    });

    it('closeAll() delegates to invalidateAll()', async () => {
      await pool.connect(makeServer('s1'));
      await pool.connect(makeServer('s2'));
      await pool.closeAll();
      expect(pool.size).toBe(0);
    });
  });

  describe('has() / size', () => {
    it('reflects pool state', async () => {
      const server = makeServer('s1');
      expect(pool.has('s1')).toBe(false);
      expect(pool.size).toBe(0);
      await pool.connect(server);
      expect(pool.has('s1')).toBe(true);
      expect(pool.size).toBe(1);
      await pool.invalidate('s1');
      expect(pool.has('s1')).toBe(false);
      expect(pool.size).toBe(0);
    });
  });
});
