import type { SummarizeRequest, SummarizeResult, ISummarizer } from './types';
import { SummarizerClient } from './client';

const BUBBLE_MAX_LENGTH = 80;
const BUBBLE_MIN_LENGTH = 12;

export class SummarizerService {
  private client: ISummarizer;

  constructor(client?: ISummarizer) {
    this.client = client ?? new SummarizerClient();
  }

  async summarizeForBubble(text: string): Promise<string> {
    if (text.length <= BUBBLE_MAX_LENGTH) return text;

    const available = await this.client.isAvailable();
    if (!available) return this.fallbackTruncate(text);

    try {
      const result = await this.client.summarize({
        text,
        maxLength: 64,
        minLength: 10,
      });
      return result.summary;
    } catch {
      return this.fallbackTruncate(text);
    }
  }

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    return this.client.summarize(request);
  }

  async isAvailable(): Promise<boolean> {
    return this.client.isAvailable();
  }

  private fallbackTruncate(text: string): string {
    const cutoff = text.lastIndexOf('.', BUBBLE_MAX_LENGTH);
    if (cutoff > 20) return text.slice(0, cutoff + 1);
    return text.slice(0, BUBBLE_MAX_LENGTH) + '...';
  }
}
