export type TransportType = 'stdio' | 'sse' | 'streamable-http';

export const TRANSPORT_TYPES: readonly TransportType[] = [
  'stdio',
  'sse',
  'streamable-http',
] as const;

export interface McpServer {
  id: string;
  name: string;
  description: string;
  transportType: TransportType;
  command: string | null;
  args: string[];
  url: string | null;
  headers: Record<string, string>;
  env: Record<string, string>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateMcpServerInput {
  name: string;
  description?: string;
  transportType: TransportType;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface UpdateMcpServerInput {
  name?: string;
  description?: string;
  transportType?: TransportType;
  command?: string | null;
  args?: string[];
  url?: string | null;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface McpServerQuery {
  transportType?: TransportType;
  enabled?: boolean;
  search?: string;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface IMcpServerService {
  create(input: CreateMcpServerInput): Promise<McpServer>;
  getById(id: string): Promise<McpServer | null>;
  update(id: string, input: UpdateMcpServerInput): Promise<McpServer | null>;
  delete(id: string): Promise<boolean>;
  list(query: McpServerQuery): Promise<McpServer[]>;
}
