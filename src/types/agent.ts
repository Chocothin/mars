export type ReasoningLevel = 'none' | 'low' | 'medium' | 'high' | 'max';

export const REASONING_LEVELS: readonly ReasoningLevel[] = [
  'none',
  'low',
  'medium',
  'high',
  'max',
] as const;

export interface Agent {
  id: string;
  name: string;
  description: string;
  providerId: string;
  modelId: string;
  systemPrompt: string;
  reasoningLevel: ReasoningLevel;
  workerCount: number;
  mcpServerIds: string[];
  skillIds?: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  providerId: string;
  modelId: string;
  systemPrompt?: string;
  reasoningLevel?: ReasoningLevel;
  workerCount?: number;
  mcpServerIds?: string[];
  skillIds?: string[];
  enabled?: boolean;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  providerId?: string;
  modelId?: string;
  systemPrompt?: string;
  reasoningLevel?: ReasoningLevel;
  workerCount?: number;
  mcpServerIds?: string[];
  skillIds?: string[];
  enabled?: boolean;
}

export interface AgentQuery {
  providerId?: string;
  modelId?: string;
  reasoningLevel?: ReasoningLevel;
  enabled?: boolean;
  search?: string;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface IAgentService {
  create(input: CreateAgentInput): Promise<Agent>;
  getById(id: string): Promise<Agent | null>;
  update(id: string, input: UpdateAgentInput): Promise<Agent | null>;
  delete(id: string): Promise<boolean>;
  list(query: AgentQuery): Promise<Agent[]>;
}
