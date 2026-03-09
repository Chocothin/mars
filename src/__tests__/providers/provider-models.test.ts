import { beforeAll, describe, expect, it } from 'bun:test';
import { initDatabase } from '../../db/index';
import { insertProvider } from '../../db/provider-repo';
import { ProviderService } from '../../providers/service';
import type { Provider } from '../../types/provider';

const service = new ProviderService();
const now = Date.now();

beforeAll(() => {
  process.env.MARS_DB_PATH = ':memory:';
  initDatabase();

  const provider: Provider = {
    id: 'openai-provider',
    name: 'OpenAI',
    description: '',
    providerType: 'openai',
    authMethod: 'api_key',
    apiKey: 'test-key',
    baseUrl: null,
    enabled: true,
    isDefault: true,
    config: {},
    createdAt: now,
    updatedAt: now,
  };

  insertProvider(provider);
});

describe('ProviderService OpenAI models', () => {
  it('returns the supported GPT and Codex model catalog', async () => {
    const models = await service.getModels('openai-provider');

    expect(models.map((model) => ({ id: model.id, name: model.name }))).toEqual([
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.3-codex', name: 'Codex 5.3' },
      { id: 'gpt-5.1-codex-mini', name: 'Codex 5.1 Mini' },
    ]);
  });
});
