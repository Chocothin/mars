import type { ReasoningLevel } from '../../types/agent';
import type { McpServer } from '../../types/mcp-server';
import type { ProviderConfig } from '../../types/provider';

export interface EnrichmentContext {
  agent: {
    id: string;
    systemPrompt: string;
    modelId: string;
    reasoningLevel: ReasoningLevel;
  };
  mcpServerIds: string[];
  mcpServers: McpServer[];
  providerConfig: ProviderConfig;
}
