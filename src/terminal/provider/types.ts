export interface ProviderRequest {
  message: string;
  systemContext?: string;
  sessionId: string;
  workingDirectory: string;
  model?: string;
  continueSession?: string;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  mcpConfigPath?: string;
  mcpServerIds?: string[];
  env?: Record<string, string>;
}

export interface ProviderCompleteMetadata {
  costUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  sessionId?: string;
  isError?: boolean;
}

export type ProviderEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'thinking_delta'; content: string }
  | { type: 'tool_use_start'; toolName: string; toolId: string }
  | { type: 'tool_use_delta'; toolId: string; content: string }
  | { type: 'tool_result'; toolId: string; output: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'complete'; metadata?: ProviderCompleteMetadata };

export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  sendMessage(request: ProviderRequest): AsyncGenerator<ProviderEvent>;
  abort(sessionId: string): void;
  isAvailable(): Promise<boolean>;
}

export interface ShellOutput {
  type: 'stdout' | 'stderr' | 'exit';
  content: string;
  exitCode?: number;
}
