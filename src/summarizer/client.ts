import type { SummarizeRequest, SummarizeResult, ISummarizer } from './types';

const SUMMARIZER_URL = process.env.SUMMARIZER_URL ?? 'http://127.0.0.1:19540';
const TIMEOUT_MS = 10_000;

export class SummarizerClient implements ISummarizer {
  private baseUrl: string;

  constructor(baseUrl: string = SUMMARIZER_URL) {
    this.baseUrl = baseUrl;
  }

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: request.text,
          max_length: request.maxLength ?? 128,
          min_length: request.minLength ?? 12,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(`Summarizer error ${response.status}: ${(err as Record<string, string>).error ?? 'unknown'}`);
      }

      const raw = (await response.json()) as Record<string, unknown>;

      return {
        summary: raw.summary as string,
        inputChars: raw.input_chars as number,
        inputTokens: raw.input_tokens as number,
        outputChars: raw.output_chars as number,
        elapsedMs: raw.elapsed_ms as number,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      const response = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  }
}
