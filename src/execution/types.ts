import type { Agent } from '../types/agent';
import type { McpServer } from '../types/mcp-server';
import type { Task } from '../types/task';
import type { TaskExecutionOutput, OrchestrationBrief } from '../orchestrator/types';

// ─── AgentSession: 에이전트 실행 세션 ───

export interface AgentSession {
  id: string;                     // MARS 내부 세션 ID
  externalSessionId: string | null; // Provider 세션 ID (Claude CLI 등)
  agentId: string;
  taskExecutionId: string;
  status: 'active' | 'completed' | 'failed' | 'timeout';
  messages: SessionMessage[];
  createdAt: number;
  lastActivityAt: number;
}

// ─── SessionMessage: 세션 내 개별 메시지 ───

export interface SessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool_result';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ─── AgentContext: 에이전트 실행에 필요한 전체 컨텍스트 ───

export interface AgentContext {
  agent: Agent;                   // 에이전트 설정
  task: Task;                     // 실행할 태스크
  systemPrompt: string;           // 조립된 최종 시스템 프롬프트
  tools: ToolConfig[];            // 사용 가능한 도구
  memory: string;                 // 관련 장기 메모리
  priorResults: string[];         // 선행 태스크 결과들
  workingDirectory: string;
  orchestrationBrief: OrchestrationBrief | null;
  mcpServerIds: string[];
  mcpServers: McpServer[];
}

// ─── ToolConfig: 도구 설정 ───

export interface ToolConfig {
  name: string;
  source: 'mcp' | 'builtin';
  mcpServerId?: string;
  enabled: boolean;
}

// ─── RunnerCallbacks: AgentRunner 이벤트 콜백 ───

export interface RunnerCallbacks {
  onStart: (session: AgentSession) => void;
  onChunk: (sessionId: string, chunk: string) => void;
  onToolUse: (sessionId: string, tool: string, input: unknown) => void;
  onComplete: (sessionId: string, output: TaskExecutionOutput) => void;
  onError: (sessionId: string, error: Error) => void;
}
