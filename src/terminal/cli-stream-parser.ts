import type { CliStreamEvent, WsServerMessage } from '../types/terminal';

export class CliStreamParser {
  private lineBuffer: string = '';
  private currentBlockType: string | null = null;
  private currentToolId: string | null = null;
  private currentToolName: string | null = null;
  private accumulatedContent: string = '';
  private accumulatedReasoning: string = '';
  private sessionCliId: string | null = null;

  constructor(
    private sessionId: string,
    private onEvent: (event: WsServerMessage) => void,
  ) {}

  processChunk(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split('\n');
    const lastLine = lines.pop();
    this.lineBuffer = lastLine ?? '';

    lines.forEach((line) => {
      this.processLine(line);
    });
  }

  flush(): void {
    if (this.lineBuffer.trim()) {
      this.processLine(this.lineBuffer);
      this.lineBuffer = '';
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: CliStreamEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (event.type === 'system' && 'subtype' in event && event.subtype === 'init') {
      if ('session_id' in event && typeof event.session_id === 'string') {
        this.sessionCliId = event.session_id;
      }
      return;
    }

    if (event.type === 'assistant' && 'subtype' in event && event.subtype === 'message_start') {
      return;
    }

    if (event.type === 'content_block_start' && 'content_block' in event) {
      const contentBlock = event.content_block;
      if (contentBlock.type === 'thinking') {
        this.currentBlockType = 'thinking';
      } else if (contentBlock.type === 'text') {
        this.currentBlockType = 'text';
      } else if (contentBlock.type === 'tool_use' && 'id' in contentBlock && 'name' in contentBlock) {
        this.currentBlockType = 'tool_use';
        this.currentToolId = contentBlock.id;
        this.currentToolName = contentBlock.name;
        this.onEvent({
          type: 'tool_use_start',
          sessionId: this.sessionId,
          toolName: contentBlock.name,
          toolId: contentBlock.id,
        });
      }
      return;
    }

    if (event.type === 'content_block_delta' && 'delta' in event) {
      const delta = event.delta;
      if (delta.type === 'thinking_delta' && 'thinking' in delta) {
        this.accumulatedReasoning += delta.thinking;
        this.onEvent({
          type: 'reasoning_delta',
          sessionId: this.sessionId,
          delta: delta.thinking,
        });
      } else if (delta.type === 'text_delta' && 'text' in delta) {
        this.accumulatedContent += delta.text;
        this.onEvent({
          type: 'content_delta',
          sessionId: this.sessionId,
          delta: delta.text,
        });
      } else if (delta.type === 'input_json_delta' && 'partial_json' in delta) {
        if (this.currentToolId) {
          this.onEvent({
            type: 'tool_use_delta',
            sessionId: this.sessionId,
            toolId: this.currentToolId,
            delta: delta.partial_json,
          });
        }
      }
      return;
    }

    if (event.type === 'content_block_stop') {
      this.currentBlockType = null;
      this.currentToolId = null;
      this.currentToolName = null;
      return;
    }

    if (event.type === 'assistant' && 'subtype' in event && event.subtype === 'message_stop') {
      return;
    }

    if (event.type === 'result') {
      return;
    }
  }

  getAccumulatedContent(): string {
    return this.accumulatedContent;
  }

  getAccumulatedReasoning(): string {
    return this.accumulatedReasoning;
  }

  getCliSessionId(): string | null {
    return this.sessionCliId;
  }
}
