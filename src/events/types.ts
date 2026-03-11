import type { TaskExecutionOutput } from '../orchestrator/types';
import type {
  AutonomyLevel,
  FallbackAction,
  InteractionQuestion,
  InteractionResponse,
  QuestionType,
} from '../hitl/types';

// ─── ProposedSubtask: 분해기가 제안하는 서브태스크 ───

export interface ProposedSubtask {
  title: string;
  description: string;
  requiredCapabilities: string[];
  dependsOn: string[];
  estimatedDurationMin: number;
  acceptanceCriteria?: string[];
  expectedOutputs?: string[];
  assignedAgentId?: string;
}

// ─── MarsEvent: 오케스트레이션 엔진 이벤트 ───

export type MarsEvent =
  // Run lifecycle
  | { type: 'run:created'; runId: string; projectId: string }
  | { type: 'run:started'; runId: string }
  | { type: 'run:completed'; runId: string; result: import('../orchestrator/types').RunResult }
  | { type: 'run:failed'; runId: string; error: string }
  | { type: 'run:cancelled'; runId: string }
  | { type: 'run:paused'; runId: string }
  | { type: 'run:stalled'; runId: string; reason: string; stalledTaskIds: string[] }

  // Task execution lifecycle
  | { type: 'task:assigned'; taskId: string; agentId: string; runId: string }
  | { type: 'task:started'; taskId: string; agentId: string; sessionId: string }
  | { type: 'task:progress'; taskId: string; chunk: string }
  | { type: 'task:tool_use'; taskId: string; tool: string }
  | { type: 'task:completed'; taskId: string; output: TaskExecutionOutput }
  | { type: 'task:failed'; taskId: string; error: string; attempt: number }
  | { type: 'task:retrying'; taskId: string; attempt: number }

  // Batch execution
  | { type: 'batch:started'; batchIndex: number; taskIds: string[] }
  | { type: 'batch:completed'; batchIndex: number }

  // Decomposition
  | { type: 'decompose:started'; taskId: string }
  | { type: 'decompose:proposed'; taskId: string; subtasks: ProposedSubtask[] }
  | { type: 'decompose:approved'; taskId: string; subtaskIds: string[] }

  // Self-claim
  | { type: 'task:claimed'; taskId: string; agentId: string; runId: string }
  | { type: 'task:unclaimed'; taskId: string; reason: 'timeout' | 'crash' | 'manual'; runId: string }

  // Review lifecycle
  | { type: 'review:started'; taskId: string; runId: string; attempt: number }
  | { type: 'review:passed'; taskId: string; runId: string }
  | { type: 'review:failed'; taskId: string; runId: string; feedback: string }

  // Agent lifecycle
  | { type: 'agent:heartbeat'; agentId: string; runId: string; timestamp: number }
  | { type: 'agent:idle'; agentId: string; runId: string }
  | { type: 'agent:timeout'; agentId: string; runId: string; lastSeen: number }

  // Messaging
  | { type: 'message:sent'; messageId: string; from: string; to: string; msgType: string }
  | { type: 'message:read'; messageId: string; agentId: string }
  | { type: 'message:broadcast'; messageId: string; from: string; msgType: string }
  | { type: 'message:summary_ready'; messageId: string; summary: string }

  // Agent status
  | { type: 'agent:status_changed'; agentId: string; from: string; to: string };

// ─── HitlEvent: 인간-에이전트 상호작용 이벤트 ───

export type HitlEvent =
  // 상호작용 생성
  | {
      type: 'hitl:created';
      interactionId: string;
      runId: string;
      taskId: string | null;
      questionType: QuestionType;
      level: AutonomyLevel;
      question: InteractionQuestion;
      timeoutMs: number | null;
      expiresAt: number | null;
      priority: 'low' | 'normal' | 'high' | 'critical';
    }

  // 인간 응답 수신
  | {
      type: 'hitl:responded';
      interactionId: string;
      runId: string;
      taskId: string | null;
      response: InteractionResponse;
      durationMs: number;
    }

  // 타임아웃 발생
  | {
      type: 'hitl:timeout';
      interactionId: string;
      runId: string;
      taskId: string | null;
      fallbackAction: FallbackAction;
      timeoutMs: number;
    }

  // 상호작용 취소 (Run 취소 시)
  | {
      type: 'hitl:cancelled';
      interactionId: string;
      runId: string;
      reason: string;
    };

// ─── AllEvents: EventBus가 처리하는 모든 이벤트 유니온 ───

export type AllEvents = MarsEvent | HitlEvent;

// ─── 이벤트 타입 문자열 유니온 (타입 안전한 on/off 용) ───

export type MarsEventType = MarsEvent['type'];
export type HitlEventType = HitlEvent['type'];
export type AllEventType = AllEvents['type'];

// ─── 이벤트 타입으로 이벤트 객체 추출하는 유틸리티 타입 ───

export type ExtractEvent<T extends AllEventType> = Extract<AllEvents, { type: T }>;
