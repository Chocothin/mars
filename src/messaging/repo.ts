import { getDb } from '../db/index';
import type { Message, MessageQuery } from './types';

interface MessageRow {
  id: string;
  run_id: string;
  from_agent_id: string;
  to_agent_id: string;
  type: string;
  payload: string;
  summary: string | null;
  read: number;
  created_at: number;
  read_at: number | null;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    runId: row.run_id,
    from: row.from_agent_id,
    to: row.to_agent_id,
    type: row.type as Message['type'],
    payload: JSON.parse(row.payload),
    summary: row.summary,
    read: row.read === 1,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export function insertMessage(msg: Message): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO messages (id, run_id, from_agent_id, to_agent_id, type, payload, summary, read, created_at, read_at)
    VALUES ($id, $runId, $from, $to, $type, $payload, $summary, $read, $createdAt, $readAt)
  `);
  stmt.run({
    $id: msg.id,
    $runId: msg.runId,
    $from: msg.from,
    $to: msg.to,
    $type: msg.type,
    $payload: JSON.stringify(msg.payload),
    $summary: msg.summary,
    $read: msg.read ? 1 : 0,
    $createdAt: msg.createdAt,
    $readAt: msg.readAt,
  });
}

export function updateSummary(messageId: string, summary: string): boolean {
  const db = getDb();
  const stmt = db.prepare('UPDATE messages SET summary = $summary WHERE id = $id');
  const result = stmt.run({ $id: messageId, $summary: summary });
  return result.changes > 0;
}

export function getMessageById(id: string): Message | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM messages WHERE id = $id');
  const row = stmt.get({ $id: id }) as MessageRow | null;
  return row ? rowToMessage(row) : null;
}

export function getUnreadMessages(agentId: string, runId?: string): Message[] {
  const db = getDb();
  let sql = 'SELECT * FROM messages WHERE to_agent_id = $agentId AND read = 0';
  const params: Record<string, string> = { $agentId: agentId };

  if (runId !== undefined) {
    sql += ' AND run_id = $runId';
    params.$runId = runId;
  }

  const stmt = db.prepare(sql);
  const rows = stmt.all(params) as MessageRow[];
  return rows.map(rowToMessage);
}

export function queryMessages(query: MessageQuery): Message[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, string | number | boolean> = {};

  if (query.runId !== undefined) {
    conditions.push('run_id = $runId');
    params.$runId = query.runId;
  }
  if (query.from !== undefined) {
    conditions.push('from_agent_id = $from');
    params.$from = query.from;
  }
  if (query.to !== undefined) {
    conditions.push('to_agent_id = $to');
    params.$to = query.to;
  }
  if (query.type !== undefined) {
    conditions.push('type = $type');
    params.$type = query.type;
  }
  if (query.read !== undefined) {
    conditions.push('read = $read');
    params.$read = query.read ? 1 : 0;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;

  const sql = `SELECT * FROM messages ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const stmt = db.prepare(sql);
  const rows = stmt.all(params) as MessageRow[];
  return rows.map(rowToMessage);
}

export function markAsRead(messageId: string): boolean {
  const db = getDb();
  const stmt = db.prepare('UPDATE messages SET read = 1, read_at = $readAt WHERE id = $id');
  const result = stmt.run({ $id: messageId, $readAt: Date.now() });
  return result.changes > 0;
}

export function markAllAsRead(agentId: string, runId?: string): number {
  const db = getDb();
  let sql = 'UPDATE messages SET read = 1, read_at = $readAt WHERE to_agent_id = $agentId AND read = 0';
  const params: Record<string, string | number> = { $agentId: agentId, $readAt: Date.now() };

  if (runId !== undefined) {
    sql += ' AND run_id = $runId';
    params.$runId = runId;
  }

  const stmt = db.prepare(sql);
  const result = stmt.run(params);
  return result.changes;
}

export function deleteOlderThan(ageMs: number): number {
  const db = getDb();
  const cutoffTime = Date.now() - ageMs;
  const stmt = db.prepare('DELETE FROM messages WHERE created_at < $cutoffTime');
  const result = stmt.run({ $cutoffTime: cutoffTime });
  return result.changes;
}
