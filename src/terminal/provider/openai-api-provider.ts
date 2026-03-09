import type { LLMProvider, ProviderRequest, ProviderEvent } from './types';
import { getProviderById } from '../../db/provider-repo';
import { getMessagesBySession } from '../../db/terminal-repo';

type OpenAiResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
};

function extractOutputText(body: OpenAiResponse): string {
  if (body.output_text && body.output_text.trim().length > 0) {
    return body.output_text;
  }

  for (const item of body.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && content.text) {
        return content.text;
      }
    }
  }

  return '';
}

export class OpenAiApiProvider implements LLMProvider {
  readonly id: string;
  readonly name: string = 'OpenAI API';
  private abortControllers: Map<string, AbortController> = new Map();

  constructor(providerId: string) {
    this.id = providerId;
  }

  async *sendMessage(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const provider = getProviderById(this.id);
    if (!provider) {
      yield { type: 'error', message: 'Provider not found' };
      return;
    }

    if (!provider.apiKey) {
      yield { type: 'error', message: 'API key not configured for provider' };
      return;
    }

    const abortController = new AbortController();
    this.abortControllers.set(request.sessionId, abortController);
    const startTime = Date.now();

    try {
      const history = getMessagesBySession({ sessionId: request.sessionId, limit: 100 });
      const input = [
        ...(request.systemContext ? [{ role: 'system', content: request.systemContext }] : []),
        ...history.map((message) => ({ role: message.role, content: message.content })),
        { role: 'user', content: request.message },
      ];

      const response = await fetch(`${provider.baseUrl ?? 'https://api.openai.com/v1'}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model ?? provider.config.defaultModel ?? 'gpt-5.4',
          input,
          stream: false,
        }),
        signal: abortController.signal,
      });

      const body = await response.json() as OpenAiResponse;
      if (!response.ok) {
        yield { type: 'error', message: body.error?.message ?? `OpenAI request failed (${response.status})` };
        yield { type: 'complete', metadata: { durationMs: Date.now() - startTime, isError: true } };
        return;
      }

      const output = extractOutputText(body);
      if (output) {
        yield { type: 'text_delta', content: output };
      }

      yield {
        type: 'complete',
        metadata: {
          durationMs: Date.now() - startTime,
          isError: false,
          numTurns: 1,
          sessionId: request.sessionId,
        },
      };
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        yield { type: 'complete', metadata: { durationMs: Date.now() - startTime, isError: false } };
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message };
      yield { type: 'complete', metadata: { durationMs: Date.now() - startTime, isError: true } };
    } finally {
      this.abortControllers.delete(request.sessionId);
    }
  }

  abort(sessionId: string): void {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
  }

  async isAvailable(): Promise<boolean> {
    const provider = getProviderById(this.id);
    return provider !== null && provider.apiKey !== null;
  }
}
