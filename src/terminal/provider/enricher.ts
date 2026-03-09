import type { LLMProvider, ProviderRequest, ProviderEvent } from './types';
import type { EnrichmentContext } from './enrichment';
import { writeMcpConfig } from './mcp-config-writer';

export class ProviderEnricher implements LLMProvider {
  readonly id: string;
  readonly name: string;

  constructor(
    private base: LLMProvider,
    private context: EnrichmentContext,
  ) {
    this.id = base.id;
    this.name = base.name;
  }

  async *sendMessage(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const enriched = this.enrich(request);
    yield* this.base.sendMessage(enriched);
  }

  abort(sessionId: string): void {
    this.base.abort(sessionId);
  }

  isAvailable(): Promise<boolean> {
    return this.base.isAvailable();
  }

  private enrich(request: ProviderRequest): ProviderRequest {
    return {
      ...request,
      systemContext: this.mergeSystemPrompt(request.systemContext),
      model: request.model ?? (this.context.agent.modelId || undefined),
      mcpConfigPath: request.mcpConfigPath ?? this.resolveMcpConfigPath(),
      mcpServerIds: request.mcpServerIds ?? this.resolveMcpServerIds(),
      maxBudgetUsd: request.maxBudgetUsd ?? this.context.providerConfig.maxBudgetUsd,
      permissionMode: request.permissionMode ?? this.context.providerConfig.permissionMode,
    };
  }

  private mergeSystemPrompt(existing?: string): string | undefined {
    const agentPrompt = this.context.agent.systemPrompt;

    if (!agentPrompt && !existing) return undefined;

    if (agentPrompt && existing) {
      return agentPrompt + '\n\n---\n\n' + existing;
    }

    return agentPrompt || existing;
  }

  private resolveMcpConfigPath(): string | undefined {
    if (this.context.mcpServers.length === 0) return undefined;
    return writeMcpConfig(this.context.mcpServers);
  }

  private resolveMcpServerIds(): string[] | undefined {
    if (this.context.mcpServerIds.length === 0) return undefined;
    return this.context.mcpServerIds;
  }
}
