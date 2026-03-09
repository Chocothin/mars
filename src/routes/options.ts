import { ProviderService } from '../providers/service';
import { McpServerService } from '../mcp-servers/service';
import { SkillService } from '../skills/service';
import type { ApiResponse } from '../types/common';
import type { ProviderModel } from '../types/provider';
import { REASONING_LEVELS } from '../types/agent';

const providerService = new ProviderService();
const mcpServerService = new McpServerService();
const skillService = new SkillService();

type AgentCreateOptionProvider = {
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
};

type AgentCreateOptionsPayload = {
  providers: AgentCreateOptionProvider[];
  mcpServers: Array<{ id: string; name: string }>;
  skills: Array<{ id: string; name: string }>;
  defaults: {
    providerId: string;
    modelId: string;
    reasoningLevel: (typeof REASONING_LEVELS)[number];
  };
};

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { success: false, error: message } satisfies ApiResponse,
    { status },
  );
}

function mapProviderModels(models: ProviderModel[]): Array<{ id: string; name: string }> {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
  }));
}

export async function handleOptionsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (req.method !== 'GET') {
    return null;
  }

  if (url.pathname !== '/api/options/agent-create') {
    return null;
  }

  try {
    const [providers, mcpServers, skills] = await Promise.all([
      providerService.list({ enabled: true, sortBy: 'name', sortOrder: 'asc', limit: 100, offset: 0 }),
      mcpServerService.list({ enabled: true, sortBy: 'name', sortOrder: 'asc', limit: 100, offset: 0 }),
      skillService.list({ sortBy: 'name', sortOrder: 'asc', limit: 100, offset: 0 }),
    ]);

    const providerModelPairs = await Promise.all(
      providers.map(async (provider) => {
        const models = await providerService.getModels(provider.id);
        return {
          id: provider.id,
          name: provider.name,
          models: mapProviderModels(models),
          isDefault: provider.isDefault,
        };
      }),
    );

    const providersWithModels: AgentCreateOptionProvider[] = providerModelPairs.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models,
    }));

    const defaultProvider = providerModelPairs.find((provider) => provider.isDefault)
      ?? providerModelPairs[0];
    const defaultModel = defaultProvider?.models[0];

    const payload: AgentCreateOptionsPayload = {
      providers: providersWithModels,
      mcpServers: mcpServers.map((server) => ({
        id: server.id,
        name: server.name,
      })),
      skills: skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
      })),
      defaults: {
        providerId: defaultProvider?.id ?? '',
        modelId: defaultModel?.id ?? '',
        reasoningLevel: 'medium',
      },
    };

    return Response.json({ success: true, data: payload } satisfies ApiResponse<AgentCreateOptionsPayload>);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return errorResponse(message, 500);
  }
}
