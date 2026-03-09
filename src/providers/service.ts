import type { Provider, CreateProviderInput, UpdateProviderInput, ProviderQuery, IProviderService, ProviderConnectionResult, ProviderModel } from '../types/provider';
import { ANTHROPIC_MODELS, OPENAI_MODELS, PROVIDER_TYPES, AUTH_METHODS } from '../types/provider';
import { insertProvider, getProviderById, getProviderByName, getDefaultProvider, updateProvider, clearDefaultProvider, deleteProvider, queryProviders } from '../db/provider-repo';
import { randomUUID } from 'node:crypto';
import { ClaudeCliExecutor } from './claude-cli';
import { CodexCliExecutor } from './codex-cli';
import { countAgentsByProviderId } from '../db/agent-repo';

const cliExecutor = new ClaudeCliExecutor();
const codexCliExecutor = new CodexCliExecutor();

export class ProviderDeletionConflictError extends Error {
  readonly status = 409;
  readonly affectedAgentCount: number;

  constructor(providerName: string, affectedAgentCount: number) {
    super(`Cannot delete provider "${providerName}" while ${affectedAgentCount} agent${affectedAgentCount === 1 ? '' : 's'} still reference it. Reassign or delete those agents first.`);
    this.name = 'ProviderDeletionConflictError';
    this.affectedAgentCount = affectedAgentCount;
  }
}

export class ProviderService implements IProviderService {
  async create(input: CreateProviderInput): Promise<Provider> {
    if (!PROVIDER_TYPES.includes(input.providerType)) {
      throw new Error(`Invalid provider type: ${input.providerType}`);
    }
    if (!AUTH_METHODS.includes(input.authMethod)) {
      throw new Error(`Invalid auth method: ${input.authMethod}`);
    }

    const existing = getProviderByName(input.name);
    if (existing) {
      throw new Error(`Provider with name "${input.name}" already exists`);
    }

    if (input.isDefault) {
      clearDefaultProvider();
    }

    const resolvedConfig = {
      ...input.config,
      useDirectApi: input.config?.useDirectApi ?? (input.authMethod === 'api_key'),
    };

    const now = Date.now();
    const provider: Provider = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? '',
      providerType: input.providerType,
      authMethod: input.authMethod,
      apiKey: input.apiKey ?? null,
      baseUrl: input.baseUrl ?? null,
      enabled: input.enabled ?? true,
      isDefault: input.isDefault ?? false,
      config: resolvedConfig,
      createdAt: now,
      updatedAt: now,
    };

    insertProvider(provider);
    return provider;
  }

  async getById(id: string): Promise<Provider | null> {
    return getProviderById(id);
  }

  async getDefault(): Promise<Provider | null> {
    return getDefaultProvider();
  }

  async update(id: string, input: UpdateProviderInput): Promise<Provider | null> {
    const existing = getProviderById(id);
    if (!existing) {
      return null;
    }

    if (input.name && input.name !== existing.name) {
      const byName = getProviderByName(input.name);
      if (byName && byName.id !== id) {
        throw new Error(`Provider with name "${input.name}" already exists`);
      }
    }

    if (input.isDefault) {
      clearDefaultProvider();
    }

    const updates: Partial<Provider> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.providerType !== undefined) updates.providerType = input.providerType;
    if (input.authMethod !== undefined) updates.authMethod = input.authMethod;
    if (input.apiKey !== undefined) updates.apiKey = input.apiKey;
    if (input.baseUrl !== undefined) updates.baseUrl = input.baseUrl;
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.isDefault !== undefined) updates.isDefault = input.isDefault;
    if (input.authMethod !== undefined || input.config !== undefined) {
      updates.config = {
        ...existing.config,
        ...(input.config ?? {}),
      };

      if (input.authMethod === 'api_key' && input.config?.useDirectApi === undefined) {
        updates.config.useDirectApi = true;
      }
      if (input.authMethod === 'oauth' && input.config?.useDirectApi === undefined) {
        updates.config.useDirectApi = false;
      }
    }

    const changed = updateProvider(id, updates);
    if (!changed) {
      return existing;
    }

    const updated = getProviderById(id);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const existing = getProviderById(id);
    if (!existing) {
      return false;
    }

    const affectedAgentCount = countAgentsByProviderId(id);
    if (affectedAgentCount > 0) {
      throw new ProviderDeletionConflictError(existing.name, affectedAgentCount);
    }

    return deleteProvider(id);
  }

  async list(query: ProviderQuery): Promise<Provider[]> {
    return queryProviders(query);
  }

  async testConnection(id: string): Promise<ProviderConnectionResult> {
    return this.checkHealth(id);
  }

  async getModels(id: string): Promise<ProviderModel[]> {
    const provider = getProviderById(id);
    if (!provider) {
      throw new Error('Provider not found');
    }

    if (provider.providerType === 'anthropic') {
      return [...ANTHROPIC_MODELS];
    }

    if (provider.providerType === 'openai') {
      return [...OPENAI_MODELS];
    }

    return [];
  }

  async getModelById(providerId: string, modelId: string): Promise<ProviderModel | null> {
    const models = await this.getModels(providerId);
    return models.find((model) => model.id === modelId) ?? null;
  }

  async checkHealth(id: string): Promise<ProviderConnectionResult> {
    const provider = getProviderById(id);
    if (!provider) {
      throw new Error('Provider not found');
    }

    if (provider.providerType === 'anthropic' && provider.authMethod === 'oauth') {
      return cliExecutor.checkHealth(id);
    }

    if (provider.providerType === 'openai' && provider.authMethod === 'oauth') {
      return codexCliExecutor.checkHealth(id);
    }

    if (!provider.apiKey) {
      return {
        success: false,
        latencyMs: 0,
        error: 'API key not configured for provider',
      };
    }

    const startTime = Date.now();
    const baseUrl = provider.baseUrl ?? (provider.providerType === 'openai'
      ? 'https://api.openai.com/v1'
      : 'https://api.anthropic.com/v1');

    const endpoint = provider.providerType === 'openai' ? '/models' : '/messages';
    const method = provider.providerType === 'openai' ? 'GET' : 'POST';
    const headers: Record<string, string> = provider.providerType === 'openai'
      ? { Authorization: `Bearer ${provider.apiKey}` }
      : {
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        };

    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      ...(provider.providerType === 'anthropic'
        ? { body: JSON.stringify({ model: provider.config.defaultModel ?? 'claude-sonnet-4.6', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }) }
        : {}),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        latencyMs: Date.now() - startTime,
        error: errorText || `Health check failed (${response.status})`,
      };
    }

    return {
      success: true,
      latencyMs: Date.now() - startTime,
      authStatus: {
        loggedIn: true,
        authMethod: provider.authMethod,
      },
    };
  }
}
