export type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'custom';

export const PROVIDER_TYPES: readonly ProviderType[] = [
  'anthropic',
  'openai',
  'ollama',
  'custom',
] as const;

export type AuthMethod = 'api_key' | 'oauth';

export const AUTH_METHODS: readonly AuthMethod[] = [
  'api_key',
  'oauth',
] as const;

export interface ProviderModel {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  supportsStreaming: boolean;
  supportsVision: boolean;
}

export const ANTHROPIC_MODELS: readonly ProviderModel[] = [
  {
    id: 'claude-opus-4.6',
    name: 'Claude Opus 4.6',
    contextWindow: 200000,
    maxOutput: 32000,
    supportsStreaming: true,
    supportsVision: true,
  },
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    contextWindow: 200000,
    maxOutput: 16000,
    supportsStreaming: true,
    supportsVision: true,
  },
  {
    id: 'claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    contextWindow: 200000,
    maxOutput: 8192,
    supportsStreaming: true,
    supportsVision: true,
  },
] as const;

export const OPENAI_MODELS: readonly ProviderModel[] = [
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    contextWindow: 1050000,
    maxOutput: 128000,
    supportsStreaming: true,
    supportsVision: true,
  },
  {
    id: 'gpt-5.3-codex',
    name: 'Codex 5.3',
    contextWindow: 400000,
    maxOutput: 128000,
    supportsStreaming: true,
    supportsVision: true,
  },
  {
    id: 'gpt-5.1-codex-mini',
    name: 'Codex 5.1 Mini',
    contextWindow: 200000,
    maxOutput: 100000,
    supportsStreaming: true,
    supportsVision: true,
  },
] as const;

export interface Provider {
  id: string;
  name: string;
  description: string;
  providerType: ProviderType;
  authMethod: AuthMethod;
  apiKey: string | null;
  baseUrl: string | null;
  enabled: boolean;
  isDefault: boolean;
  config: ProviderConfig;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderConfig {
  cliPath?: string;
  useDirectApi?: boolean;
  maxBudgetUsd?: number;
  defaultModel?: string;
  permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
  customArgs?: string[];
}

export interface CreateProviderInput {
  name: string;
  description?: string;
  providerType: ProviderType;
  authMethod: AuthMethod;
  apiKey?: string;
  baseUrl?: string;
  enabled?: boolean;
  isDefault?: boolean;
  config?: Partial<ProviderConfig>;
}

export interface UpdateProviderInput {
  name?: string;
  description?: string;
  providerType?: ProviderType;
  authMethod?: AuthMethod;
  apiKey?: string | null;
  baseUrl?: string | null;
  enabled?: boolean;
  isDefault?: boolean;
  config?: Partial<ProviderConfig>;
}

export interface ProviderQuery {
  providerType?: ProviderType;
  authMethod?: AuthMethod;
  enabled?: boolean;
  search?: string;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface IProviderService {
  create(input: CreateProviderInput): Promise<Provider>;
  getById(id: string): Promise<Provider | null>;
  getDefault(): Promise<Provider | null>;
  update(id: string, input: UpdateProviderInput): Promise<Provider | null>;
  delete(id: string): Promise<boolean>;
  list(query: ProviderQuery): Promise<Provider[]>;
  testConnection(id: string): Promise<ProviderConnectionResult>;
  getModels(id: string): Promise<ProviderModel[]>;
  checkHealth(id: string): Promise<ProviderConnectionResult>;
}

export interface ProviderConnectionResult {
  success: boolean;
  latencyMs: number;
  error?: string;
  authStatus?: {
    loggedIn: boolean;
    authMethod: string;
    email?: string;
    orgName?: string;
  };
}

export interface CliExecuteOptions {
  prompt: string;
  model?: string;
  systemPrompt?: string;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: ProviderConfig['permissionMode'];
  outputFormat?: 'text' | 'json' | 'stream-json';
  workingDirectory?: string;
  mcpConfig?: string;
  continueSession?: boolean;
  resumeSessionId?: string;
  additionalArgs?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface CliExecuteResult {
  success: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
  error?: string;
  sessionId?: string;
}

export interface ICliExecutor {
  execute(providerId: string, options: CliExecuteOptions): Promise<CliExecuteResult>;
  executeStreaming(
    providerId: string,
    options: CliExecuteOptions,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<CliExecuteResult>;
  checkHealth(providerId: string): Promise<ProviderConnectionResult>;
  getAuthStatus(): Promise<ProviderConnectionResult['authStatus']>;
}
