import type { LLMProvider } from './types';
import type { EnrichmentContext } from './enrichment';
import { ClaudeCliProvider } from './claude-cli-provider';
import { CodexCliProvider } from './codex-cli-provider';
import { AnthropicApiProvider } from './anthropic-api-provider';
import { OpenAiApiProvider } from './openai-api-provider';
import type { HitlDeps } from './anthropic-api-provider';
import { ProviderEnricher } from './enricher';
import { getProviderById } from '../../db/provider-repo';
import { getAgentById } from '../../db/agent-repo';
import { getProjectById } from '../../db/project-repo';
import type { TerminalSession } from '../../types/terminal';
import { mergeMcpServerIds, resolveMcpScope } from '../../mcp/resolution';

export { mergeMcpServerIds } from '../../mcp/resolution';

export function createEnrichmentContext(
  agentId: string,
  scope?: { projectId?: string; overrideMcpServerIds?: readonly string[] },
): EnrichmentContext {
  const agent = getAgentById(agentId);
  if (!agent) {
    throw new Error('Agent not found: ' + agentId);
  }

  const providerRecord = getProviderById(agent.providerId);
  if (!providerRecord) {
    throw new Error('Provider not found: ' + agent.providerId);
  }

  return {
    agent: {
      id: agent.id,
      systemPrompt: agent.systemPrompt,
      modelId: agent.modelId,
      reasoningLevel: agent.reasoningLevel,
    },
    ...resolveMcpScope({
      projectId: scope?.projectId,
      agentId: agent.id,
      overrideMcpServerIds: scope?.overrideMcpServerIds,
    }),
    providerConfig: providerRecord.config,
  };
}

export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();

  get(providerId: string, hitlDeps?: HitlDeps): LLMProvider {
    if (!hitlDeps && this.providers.has(providerId)) {
      return this.providers.get(providerId)!;
    }

    const provider = getProviderById(providerId);
    if (!provider) {
      throw new Error('Provider not found: ' + providerId);
    }

    if (provider.providerType === 'anthropic') {
      const instance = provider.config.useDirectApi
        ? new AnthropicApiProvider(providerId, hitlDeps)
        : new ClaudeCliProvider(providerId);
      if (!hitlDeps) {
        this.providers.set(providerId, instance);
      }
      return instance;
    }

    if (provider.providerType === 'openai') {
      const instance = provider.config.useDirectApi
        ? new OpenAiApiProvider(providerId)
        : new CodexCliProvider(providerId);
      if (!hitlDeps) {
        this.providers.set(providerId, instance);
      }
      return instance;
    }

    throw new Error('Unsupported provider type: ' + provider.providerType);
  }

  getForAgent(agentId: string, hitlDeps?: HitlDeps): LLMProvider {
    const agent = getAgentById(agentId);
    if (!agent) {
      throw new Error('Agent not found: ' + agentId);
    }

    const baseProvider = this.getBase(agent.providerId, hitlDeps);
    const context = createEnrichmentContext(agent.id);

    return new ProviderEnricher(baseProvider, context);
  }

  getForSession(session: TerminalSession, hitlDeps?: HitlDeps): LLMProvider {
    const agent = getAgentById(session.agentId);
    if (!agent) {
      throw new Error('Agent not found: ' + session.agentId);
    }

    const project = getProjectById(session.projectId);
    if (!project) {
      throw new Error('Project not found: ' + session.projectId);
    }

    const context = createEnrichmentContext(agent.id, {
      projectId: project.id,
      overrideMcpServerIds: session.mcpServerIds,
    });

    return new ProviderEnricher(this.getBase(agent.providerId, hitlDeps), context);
  }

  private getBase(providerId: string, hitlDeps?: HitlDeps): LLMProvider {
    if (!hitlDeps) {
      const cached = this.providers.get(providerId);
      if (cached) return cached;
    }

    const provider = getProviderById(providerId);
    if (!provider) {
      throw new Error('Provider not found: ' + providerId);
    }

    if (provider.providerType === 'anthropic') {
      const instance = provider.config.useDirectApi
        ? new AnthropicApiProvider(providerId, hitlDeps)
        : new ClaudeCliProvider(providerId);
      if (!hitlDeps) {
        this.providers.set(providerId, instance);
      }
      return instance;
    }

    if (provider.providerType === 'openai') {
      const instance = provider.config.useDirectApi
        ? new OpenAiApiProvider(providerId)
        : new CodexCliProvider(providerId);
      if (!hitlDeps) {
        this.providers.set(providerId, instance);
      }
      return instance;
    }

    throw new Error('Unsupported provider type: ' + provider.providerType);
  }

  clear(): void {
    this.providers.clear();
  }

  invalidateProvider(providerId: string): void {
    this.providers.delete(providerId);
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }
}

export const providerRegistry = new ProviderRegistry();
