import type { IEventBus } from '../events/bus';
import type { ExtractEvent } from '../events/types';
import type { SummarizerService } from './service';
import * as messageRepo from '../messaging/repo';

const CONCURRENCY = 2;
const MIN_TEXT_LENGTH = 80;

type MessageSentEvent = ExtractEvent<'message:sent'>;

function extractTextFromPayload(payload: Record<string, unknown>): string {
  for (const key of ['content', 'text', 'description', 'message', 'output', 'feedback']) {
    const val = payload[key];
    if (typeof val === 'string' && val.length > 0) return val;
  }
  return JSON.stringify(payload);
}

function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function <T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

export class SummaryListener {
  private limiter = createLimiter(CONCURRENCY);
  private unsubscribe: (() => void) | null = null;

  constructor(
    private eventBus: IEventBus,
    private summarizer: SummarizerService,
  ) {
    this.unsubscribe = this.eventBus.on('message:sent', (event: MessageSentEvent) => {
      this.limiter(() => this.handleMessageSent(event)).catch(() => {});
    });
  }

  private async handleMessageSent(event: MessageSentEvent): Promise<void> {
    const msg = messageRepo.getMessageById(event.messageId);
    if (!msg) return;

    const text = extractTextFromPayload(msg.payload);
    if (text.length < MIN_TEXT_LENGTH) return;

    try {
      const summary = await this.summarizer.summarizeForBubble(text);
      if (summary === text) return;

      messageRepo.updateSummary(msg.id, summary);

      this.eventBus.emit({
        type: 'message:summary_ready',
        messageId: msg.id,
        summary,
      });
    } catch {
      // summarizer unavailable — summary stays null
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
