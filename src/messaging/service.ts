import { eventBus } from '../events/bus';
import type { Message, SendMessageInput, MessageQuery, MessageType } from './types';
import * as messageRepo from './repo';
import * as agentRepo from '../db/agent-repo';

export interface IMessageService {
  send(input: SendMessageInput): Message;
  broadcast(runId: string, from: string, type: MessageType, payload: Record<string, unknown>): Message[];
  getUnread(agentId: string, runId?: string): Message[];
  getAll(query: MessageQuery): Message[];
  markRead(messageId: string, agentId: string): boolean;
  markAllRead(agentId: string, runId?: string): number;
  deleteOlderThan(ageMs: number): number;
}

export class MessageService implements IMessageService {
  send(input: SendMessageInput): Message {
    const msg: Message = {
      id: crypto.randomUUID(),
      ...input,
      summary: null,
      read: false,
      createdAt: Date.now(),
      readAt: null,
    };

    messageRepo.insertMessage(msg);

    eventBus.emit({
      type: 'message:sent',
      messageId: msg.id,
      from: msg.from,
      to: msg.to,
      msgType: msg.type,
    });

    return msg;
  }

  broadcast(runId: string, from: string, type: MessageType, payload: Record<string, unknown>): Message[] {
    const allAgents = agentRepo.queryAgents({});
    const enabledAgents = allAgents.filter(agent => agent.enabled && agent.id !== from);

    const messages: Message[] = [];
    for (const agent of enabledAgents) {
      const msg = this.send({ runId, from, to: agent.id, type, payload });
      messages.push(msg);
    }

    const firstMsg = messages[0];
    if (firstMsg !== undefined) {
      eventBus.emit({
        type: 'message:broadcast',
        messageId: firstMsg.id,
        from,
        msgType: type,
      });
    }

    return messages;
  }

  getUnread(agentId: string, runId?: string): Message[] {
    return messageRepo.getUnreadMessages(agentId, runId);
  }

  getAll(query: MessageQuery): Message[] {
    return messageRepo.queryMessages(query);
  }

  markRead(messageId: string, agentId: string): boolean {
    const result = messageRepo.markAsRead(messageId);

    if (result) {
      eventBus.emit({
        type: 'message:read',
        messageId,
        agentId,
      });
    }

    return result;
  }

  markAllRead(agentId: string, runId?: string): number {
    return messageRepo.markAllAsRead(agentId, runId);
  }

  deleteOlderThan(ageMs: number): number {
    return messageRepo.deleteOlderThan(ageMs);
  }
}
