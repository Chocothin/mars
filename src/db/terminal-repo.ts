import { getDb } from './index';
import type { TerminalSession, TerminalMessage, SessionStatus, MessageRole, MessageType, SessionQuery, MessageQuery, MessageMetadata } from '../types/terminal';

interface SessionRow {
  id: string;
  project_id: string;
  agent_id: string;
  mcp_server_ids: string;
  working_directory: string;
  status: string;
  cli_session_id: string | null;
  access_token: string;
  runtime_fingerprint: string;
  runtime_version: number;
  restart_required: number;
  restart_reason: string;
  restart_marked_at: number;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  type: string;
  content: string;
  metadata: string | null;
  created_at: number;
}

function rowToSession(row: SessionRow): TerminalSession {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    mcpServerIds: JSON.parse(row.mcp_server_ids) as string[],
    workingDirectory: row.working_directory,
    status: row.status as SessionStatus,
    cliSessionId: row.cli_session_id,
    accessToken: row.access_token || undefined,
    runtimeFingerprint: row.runtime_fingerprint || null,
    runtimeVersion: row.runtime_version,
    restartRequired: row.restart_required === 1,
    restartReason: row.restart_reason || null,
    restartMarkedAt: row.restart_marked_at > 0 ? row.restart_marked_at : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: MessageRow): TerminalMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as MessageRole,
    type: row.type as MessageType,
    content: row.content,
    metadata: row.metadata ? (JSON.parse(row.metadata) as MessageMetadata) : null,
    createdAt: row.created_at,
  };
}

export function insertSession(session: TerminalSession): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO terminal_sessions (id, project_id, agent_id, mcp_server_ids, working_directory, status, cli_session_id, access_token, runtime_fingerprint, runtime_version, restart_required, restart_reason, restart_marked_at, created_at, updated_at)
    VALUES ($id, $projectId, $agentId, $mcpServerIds, $workingDirectory, $status, $cliSessionId, $accessToken, $runtimeFingerprint, $runtimeVersion, $restartRequired, $restartReason, $restartMarkedAt, $createdAt, $updatedAt)
  `);
  stmt.run({
    $id: session.id,
    $projectId: session.projectId,
    $agentId: session.agentId,
    $mcpServerIds: JSON.stringify(session.mcpServerIds),
    $workingDirectory: session.workingDirectory,
    $status: session.status,
    $cliSessionId: session.cliSessionId,
    $accessToken: session.accessToken ?? '',
    $runtimeFingerprint: session.runtimeFingerprint ?? '',
    $runtimeVersion: session.runtimeVersion ?? 1,
    $restartRequired: session.restartRequired ? 1 : 0,
    $restartReason: session.restartReason ?? '',
    $restartMarkedAt: session.restartMarkedAt ?? 0,
    $createdAt: session.createdAt,
    $updatedAt: session.updatedAt,
  });
}

export function getSessionById(id: string): TerminalSession | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM terminal_sessions WHERE id = $id LIMIT 1');
  const row = stmt.get({ $id: id }) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function getSessionByProjectAgent(projectId: string, agentId: string): TerminalSession | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM terminal_sessions WHERE project_id = $projectId AND agent_id = $agentId ORDER BY updated_at DESC LIMIT 1');
  const row = stmt.get({ $projectId: projectId, $agentId: agentId }) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function getMatchingSession(projectId: string, agentId: string, mcpServerIds: string[]): TerminalSession | null {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM terminal_sessions
    WHERE project_id = $projectId AND agent_id = $agentId AND mcp_server_ids = $mcpServerIds
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  const row = stmt.get({
    $projectId: projectId,
    $agentId: agentId,
    $mcpServerIds: JSON.stringify(mcpServerIds),
  }) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function updateSessionStatus(id: string, status: SessionStatus): boolean {
  const db = getDb();
  const stmt = db.prepare('UPDATE terminal_sessions SET status = $status, updated_at = $updatedAt WHERE id = $id');
  const result = stmt.run({
    $status: status,
    $updatedAt: Date.now(),
    $id: id,
  });
  return result.changes > 0;
}

export function updateSessionWorkingDirectory(id: string, dir: string): boolean {
  const db = getDb();
  const stmt = db.prepare('UPDATE terminal_sessions SET working_directory = $dir, updated_at = $updatedAt WHERE id = $id');
  const result = stmt.run({
    $dir: dir,
    $updatedAt: Date.now(),
    $id: id,
  });
  return result.changes > 0;
}

export function updateSessionCliSessionId(id: string, cliSessionId: string | null): boolean {
  const db = getDb();
  const stmt = db.prepare('UPDATE terminal_sessions SET cli_session_id = $cliSessionId, updated_at = $updatedAt WHERE id = $id');
  const result = stmt.run({
    $cliSessionId: cliSessionId,
    $updatedAt: Date.now(),
    $id: id,
  });
  return result.changes > 0;
}

export interface SessionLifecycleUpdate {
  workingDirectory?: string;
  status?: SessionStatus;
  cliSessionId?: string | null;
  accessToken?: string;
  runtimeFingerprint?: string;
  runtimeVersion?: number;
  restartRequired?: boolean;
  restartReason?: string | null;
  restartMarkedAt?: number | null;
}

export function updateSessionLifecycle(id: string, updates: SessionLifecycleUpdate): boolean {
  const db = getDb();
  const setClauses: string[] = [];
  const params: Record<string, string | number | null> = {
    $id: id,
    $updatedAt: Date.now(),
  };

  if (updates.workingDirectory !== undefined) {
    setClauses.push('working_directory = $workingDirectory');
    params.$workingDirectory = updates.workingDirectory;
  }
  if (updates.status !== undefined) {
    setClauses.push('status = $status');
    params.$status = updates.status;
  }
  if (updates.cliSessionId !== undefined) {
    setClauses.push('cli_session_id = $cliSessionId');
    params.$cliSessionId = updates.cliSessionId;
  }
  if (updates.accessToken !== undefined) {
    setClauses.push('access_token = $accessToken');
    params.$accessToken = updates.accessToken;
  }
  if (updates.runtimeFingerprint !== undefined) {
    setClauses.push('runtime_fingerprint = $runtimeFingerprint');
    params.$runtimeFingerprint = updates.runtimeFingerprint;
  }
  if (updates.runtimeVersion !== undefined) {
    setClauses.push('runtime_version = $runtimeVersion');
    params.$runtimeVersion = updates.runtimeVersion;
  }
  if (updates.restartRequired !== undefined) {
    setClauses.push('restart_required = $restartRequired');
    params.$restartRequired = updates.restartRequired ? 1 : 0;
  }
  if (updates.restartReason !== undefined) {
    setClauses.push('restart_reason = $restartReason');
    params.$restartReason = updates.restartReason ?? '';
  }
  if (updates.restartMarkedAt !== undefined) {
    setClauses.push('restart_marked_at = $restartMarkedAt');
    params.$restartMarkedAt = updates.restartMarkedAt ?? 0;
  }

  if (setClauses.length === 0) {
    return false;
  }

  setClauses.push('updated_at = $updatedAt');

  const stmt = db.prepare(`UPDATE terminal_sessions SET ${setClauses.join(', ')} WHERE id = $id`);
  const result = stmt.run(params);
  return result.changes > 0;
}

export function updateSessionRestartState(
  id: string,
  restartRequired: boolean,
  restartReason: string | null,
  restartMarkedAt: number | null,
): boolean {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE terminal_sessions
    SET restart_required = $restartRequired,
        restart_reason = $restartReason,
        restart_marked_at = $restartMarkedAt,
        updated_at = $updatedAt
    WHERE id = $id
  `);
  const result = stmt.run({
    $restartRequired: restartRequired ? 1 : 0,
    $restartReason: restartReason ?? '',
    $restartMarkedAt: restartMarkedAt ?? 0,
    $updatedAt: Date.now(),
    $id: id,
  });
  return result.changes > 0;
}

export function updateSessionMcpServerIds(id: string, mcpServerIds: string[]): boolean {
  const db = getDb();
  const stmt = db.prepare('UPDATE terminal_sessions SET mcp_server_ids = $mcpServerIds, updated_at = $updatedAt WHERE id = $id');
  const result = stmt.run({
    $mcpServerIds: JSON.stringify(mcpServerIds),
    $updatedAt: Date.now(),
    $id: id,
  });
  return result.changes > 0;
}

export function deleteSession(id: string): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM terminal_sessions WHERE id = $id');
  const result = stmt.run({ $id: id });
  return result.changes > 0;
}

export function querySessions(q: SessionQuery): TerminalSession[] {
  const db = getDb();
  let sql = 'SELECT * FROM terminal_sessions WHERE 1=1';
  const params: Record<string, string | number | null> = {};

  if (q.projectId) {
    sql += ' AND project_id = $projectId';
    params.$projectId = q.projectId;
  }
  if (q.agentId) {
    sql += ' AND agent_id = $agentId';
    params.$agentId = q.agentId;
  }
  if (q.status) {
    sql += ' AND status = $status';
    params.$status = q.status;
  }

  sql += ' ORDER BY updated_at DESC';

  if (q.limit) {
    sql += ' LIMIT $limit';
    params.$limit = q.limit;
  }
  if (q.offset) {
    sql += ' OFFSET $offset';
    params.$offset = q.offset;
  }

  const stmt = db.prepare(sql);
  const rows = stmt.all(params) as SessionRow[];
  return rows.map(rowToSession);
}

export function insertMessage(msg: TerminalMessage): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO terminal_messages (id, session_id, role, type, content, metadata, created_at)
    VALUES ($id, $sessionId, $role, $type, $content, $metadata, $createdAt)
  `);
  stmt.run({
    $id: msg.id,
    $sessionId: msg.sessionId,
    $role: msg.role,
    $type: msg.type,
    $content: msg.content,
    $metadata: msg.metadata ? JSON.stringify(msg.metadata) : null,
    $createdAt: msg.createdAt,
  });
}

export function getMessagesBySession(query: MessageQuery): TerminalMessage[] {
  const db = getDb();
  let sql = 'SELECT * FROM terminal_messages WHERE session_id = $sessionId';
  const params: Record<string, string | number | null> = { $sessionId: query.sessionId };

  if (query.role) {
    sql += ' AND role = $role';
    params.$role = query.role;
  }
  if (query.type) {
    sql += ' AND type = $type';
    params.$type = query.type;
  }
  if (query.before) {
    sql += ' AND created_at < $before';
    params.$before = query.before;
  }

  sql += ' ORDER BY created_at ASC';

  const limit = query.limit ?? 50;
  sql += ' LIMIT $limit';
  params.$limit = limit;

  if (query.offset) {
    sql += ' OFFSET $offset';
    params.$offset = query.offset;
  }

  const stmt = db.prepare(sql);
  const rows = stmt.all(params) as MessageRow[];
  return rows.map(rowToMessage);
}

export function getMessageCountBySession(sessionId: string): number {
  const db = getDb();
  const stmt = db.prepare('SELECT COUNT(*) as count FROM terminal_messages WHERE session_id = $sessionId');
  const row = stmt.get({ $sessionId: sessionId }) as { count: number } | undefined;
  return row ? row.count : 0;
}

export function deleteMessagesBySession(sessionId: string): void {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM terminal_messages WHERE session_id = $sessionId');
  stmt.run({ $sessionId: sessionId });
}

export function enforceMessageRetention(sessionId: string, maxMessages: number): void {
  const db = getDb();
  const stmt = db.prepare(`
    DELETE FROM terminal_messages
    WHERE session_id = $sessionId
    AND id NOT IN (
      SELECT id FROM terminal_messages
      WHERE session_id = $sessionId
      ORDER BY created_at DESC
      LIMIT $maxMessages
    )
  `);
  stmt.run({
    $sessionId: sessionId,
    $maxMessages: maxMessages,
  });
}
