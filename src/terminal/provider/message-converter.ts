import type { ModelMessage } from 'ai';
import type { TerminalMessage } from '../../types/terminal';

export function convertToModelMessages(messages: TerminalMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.type === 'text' || msg.type === 'reasoning') {
        result.push({ role: 'assistant', content: msg.content });
      }
    }
  }

  return result;
}
