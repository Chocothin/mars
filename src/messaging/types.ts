export type MessageType =
  | 'dm'
  | 'broadcast'
  | 'task_assignment'
  | 'shutdown'
  | 'plan_approval'
  | 'idle_notification'
  | 'review_feedback'
  | 'task_report'
  | 'escalation';

export interface Message {
  id: string;
  runId: string;
  from: string;
  to: string;
  type: MessageType;
  payload: Record<string, unknown>;
  summary: string | null;
  read: boolean;
  createdAt: number;
  readAt: number | null;
}

export interface SendMessageInput {
  runId: string;
  from: string;
  to: string;
  type: MessageType;
  payload: Record<string, unknown>;
}

export interface MessageQuery {
  runId?: string;
  from?: string;
  to?: string;
  type?: MessageType;
  read?: boolean;
  limit?: number;
  offset?: number;
}
