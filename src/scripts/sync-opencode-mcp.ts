import { initDatabase } from '../db/index';
import { syncOpenCodeMcp } from '../mcp-servers/opencode-sync';

const testConnectivity = Bun.argv.includes('--test');

initDatabase();

const result = await syncOpenCodeMcp({ testConnectivity });

const summary = {
  created: result.created,
  updated: result.updated,
  unchanged: result.unchanged,
  servers: result.syncedServers.map((server) => ({
    name: server.name,
    transportType: server.transportType,
    enabled: server.enabled,
  })),
  connectivity: result.connectivity,
};

console.log(JSON.stringify(summary, null, 2));
