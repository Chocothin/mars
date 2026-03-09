export type SessionStatus = 'idle' | 'executing';

export const SESSION_STATUSES: readonly SessionStatus[] = ['idle', 'executing'] as const;

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageType =
  | 'text'
  | 'reasoning'
  | 'tool_use'
  | 'tool_result'
  | 'command'
  | 'command_result'
  | 'error';

export interface TerminalSession {
  id: string;
  projectId: string;
  agentId: string;
  mcpServerIds: string[];
  workingDirectory: string;
  status: SessionStatus;
  cliSessionId: string | null;
  accessToken?: string;
  runtimeFingerprint?: string | null;
  runtimeVersion?: number;
  restartRequired: boolean;
  restartReason: string | null;
  restartMarkedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TerminalMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  type: MessageType;
  content: string;
  metadata: MessageMetadata | null;
  createdAt: number;
}

export interface MessageMetadata {
  toolName?: string;
  toolInput?: string;
  toolId?: string;
  durationMs?: number;
  costUsd?: number;
  model?: string;
  exitCode?: number;
  numTurns?: number;
}

export interface CreateSessionInput {
  projectId: string;
  agentId: string;
  mcpServerIds?: string[];
}

export interface TerminalSessionAccess {
  session: TerminalSession;
  accessToken: string;
}

export interface TerminalSessionActivity {
  sessionId: string;
  runId: string | null;
  runStatus: import('../orchestrator/types').RunStatus | null;
  heartbeatStatus: 'idle' | 'working' | 'offline' | null;
  heartbeatLastSeenAt: number | null;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  latestExecutionStatus: import('../orchestrator/types').TaskExecutionStatus | null;
  latestExecutionTimestamp: number | null;
}

export type PtyLaunchMode = 'provider_cli' | 'shell_fallback';

export interface PtySessionInfo {
  mode: PtyLaunchMode;
  providerName: string;
  cwd: string;
  command: string;
  note: string | null;
}

export interface SessionQuery {
  projectId?: string;
  agentId?: string;
  status?: SessionStatus;
  limit?: number;
  offset?: number;
}

export interface MessageQuery {
  sessionId: string;
  role?: MessageRole;
  type?: MessageType;
  limit?: number;
  offset?: number;
  before?: number;
}

export type WsClientMessage =
  | { type: 'subscribe'; sessionId: string; accessToken: string }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'send'; sessionId: string; content: string; accessToken: string }
  | { type: 'abort'; sessionId: string; accessToken: string }
  | { type: 'pty_attach'; sessionId: string; cols: number; rows: number; accessToken: string }
  | { type: 'pty_input'; sessionId: string; data: string; accessToken: string }
  | { type: 'pty_resize'; sessionId: string; cols: number; rows: number; accessToken: string }
  | { type: 'pty_detach'; sessionId: string; accessToken: string };

export type WsServerMessage =
  | { type: 'connected'; connectionId: string }
  | { type: 'subscribed'; sessionId: string }
  | { type: 'unsubscribed'; sessionId: string }
  | { type: 'pty_ready'; sessionId: string; info: PtySessionInfo }
  | { type: 'pty_output'; sessionId: string; data: string }
  | { type: 'pty_exit'; sessionId: string; exitCode: number | null; signalCode: number | string | null }
  | { type: 'pty_error'; sessionId: string; error: string }
  | { type: 'session_created'; session: TerminalSession }
  | { type: 'message_stored'; message: TerminalMessage }
  | { type: 'stream_start'; sessionId: string; messageId: string }
  | { type: 'content_delta'; sessionId: string; delta: string }
  | { type: 'reasoning_delta'; sessionId: string; delta: string }
  | { type: 'tool_use_start'; sessionId: string; toolName: string; toolId: string }
  | { type: 'tool_use_delta'; sessionId: string; toolId: string; delta: string }
  | { type: 'tool_result'; sessionId: string; toolId: string; result: string }
  | { type: 'stream_end'; sessionId: string; message: TerminalMessage }
  | { type: 'command_result'; sessionId: string; result: CommandResult }
  | { type: 'error'; sessionId: string | null; error: string }
  | { type: 'status_changed'; sessionId: string; status: SessionStatus }
  | { type: 'aborted'; sessionId: string };

export interface CommandContext {
  sessionId: string;
  workingDirectory: string;
  projectId: string;
  agentId: string;
}

export interface CommandResult {
  output: string;
  success: boolean;
  sideEffects?: {
    workingDirectoryChanged?: string;
    clearTerminal?: boolean;
  };
}

export interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  execute: (args: string[], context: CommandContext) => Promise<CommandResult>;
}

export type CliStreamEvent =
  | CliStreamSystemInit
  | CliStreamMessageStart
  | CliStreamContentBlockStart
  | CliStreamContentBlockDelta
  | CliStreamContentBlockStop
  | CliStreamMessageStop
  | CliStreamResult;

export interface CliStreamSystemInit {
  type: 'system';
  subtype: 'init';
  session_id: string;
  tools?: unknown[];
  mcp_servers?: unknown[];
}

export interface CliStreamMessageStart {
  type: 'assistant';
  subtype: 'message_start';
  message: Record<string, unknown>;
}

export interface CliStreamContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: CliContentBlock;
}

export interface CliStreamContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta: CliContentDelta;
}

export interface CliStreamContentBlockStop {
  type: 'content_block_stop';
  index: number;
}

export interface CliStreamMessageStop {
  type: 'assistant';
  subtype: 'message_stop';
  message?: Record<string, unknown>;
  duration_ms?: number;
  cost_usd?: number;
}

export interface CliStreamResult {
  type: 'result';
  subtype: 'success' | 'error';
  result?: string;
  session_id?: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
}

export type CliContentBlock =
  | { type: 'thinking'; thinking: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: string };

export type CliContentDelta =
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string };

export interface ITerminalService {
  getOrCreateSession(projectId: string, agentId: string, mcpServerIds?: string[]): Promise<TerminalSession>;
  getSession(sessionId: string): Promise<TerminalSession | null>;
  getSessionByProjectAgent(projectId: string, agentId: string): Promise<TerminalSession | null>;
  listSessions(query: SessionQuery): Promise<TerminalSession[]>;
  restartSession(sessionId: string): Promise<TerminalSession | null>;
  markSessionsForMcpServerChange(mcpServerId: string, reason: string): Promise<string[]>;
  markSessionsForProviderChange(providerId: string, reason: string): Promise<string[]>;
  markSessionsForAgentChange(agentId: string, reason: string): Promise<string[]>;
  markSessionsForProjectChange(projectId: string, reason: string): Promise<string[]>;
  deleteSession(sessionId: string): Promise<boolean>;
  getMessages(query: MessageQuery): Promise<TerminalMessage[]>;
  clearMessages(sessionId: string): Promise<void>;
}

export interface ISessionExecutor {
  execute(
    session: TerminalSession,
    content: string,
    onEvent: (event: WsServerMessage) => void,
  ): Promise<void>;
  abort(sessionId: string): void;
  isExecuting(sessionId: string): boolean;
}

export const DEFAULT_MAX_MESSAGES_PER_SESSION = 200;
