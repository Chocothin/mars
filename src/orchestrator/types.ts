import type { HitlRunConfig } from '../hitl/types';

// ─── Run: 한 번의 전체 오케스트레이션 실행 단위 ───

export type RunStatus =
  | 'pending'        // 생성됨, 실행 전
  | 'decomposing'    // 서브태스크 분해 중
  | 'scheduling'     // 실행 순서 결정 중
  | 'running'        // 에이전트들 실행 중
  | 'reviewing'      // 결과 검증 중
  | 'paused'         // 사용자에 의해 일시 중지
  | 'completed'      // 전체 완료
  | 'failed'         // 실패 (복구 불가)
  | 'cancelled';     // 사용자 취소

export interface Run {
  id: string;
  projectId: string;
  rootTaskIds: string[];          // 실행 대상 최상위 태스크들
  status: RunStatus;
  config: RunConfig;
  executionPlan: ExecutionPlan | null;
  result: RunResult | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface RunConfig {
  maxConcurrency: number;         // 병렬 에이전트 수 상한 (default: 3)
  maxRetries: number;             // 태스크 실패 시 재시도 횟수 (default: 1)
  timeoutMs: number;              // 전체 실행 타임아웃 (default: 30분)
  taskTimeoutMs: number;          // 개별 태스크 타임아웃 (default: 15분)
  autoReview: boolean;            // Reviewer 자동 실행 여부
  requireHumanApproval: boolean;  // 분해/할당에 사용자 승인 필요 여부
  hitl: HitlRunConfig | null;
}

export interface RunResult {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  skippedTasks: number;
  totalDurationMs: number;
  taskResults: TaskExecution[];
}

// ─── ExecutionPlan: Scheduler가 만드는 실행 계획 ───

export interface ExecutionPlan {
  batches: ExecutionBatch[];      // 순서대로 실행할 배치 목록
  dependencyGraph: DependencyEdge[];
}

export interface ExecutionBatch {
  batchIndex: number;             // 0부터 시작
  taskIds: string[];              // 이 배치에서 병렬 실행할 태스크들
}

export interface DependencyEdge {
  fromTaskId: string;             // 선행 태스크
  toTaskId: string;               // 후행 태스크 (from이 완료되어야 실행 가능)
  type: 'blocks' | 'informs';    // blocks: 필수 선행, informs: 결과 참조
}

// ─── TaskExecution: 개별 태스크 실행 기록 ───

export type TaskExecutionStatus =
  | 'pending'
  | 'assigned'       // 에이전트 배정됨
  | 'running'        // 에이전트가 실행 중
  | 'completed'      // 성공
  | 'failed'         // 실패
  | 'retrying'       // 재시도 중
  | 'skipped'        // 선행 태스크 실패로 건너뜀
  | 'cancelled';

export interface TaskExecution {
  id: string;
  runId: string;
  taskId: string;
  agentId: string;
  sessionId: string | null;       // CLI 세션 ID (resume 용)
  status: TaskExecutionStatus;
  attempt: number;                // 현재 시도 횟수 (1부터)
  input: TaskExecutionInput;
  output: TaskExecutionOutput | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  error: string | null;
}

export interface TaskExecutionInput {
  prompt: string;                 // 에이전트에게 전달할 프롬프트
  systemPrompt: string;           // 조립된 시스템 프롬프트
  tools: string[];                // 사용 가능한 도구 목록
  context: string;                // 이전 태스크 결과 등 컨텍스트
  workingDirectory: string;       // 프로젝트 디렉토리
  orchestrationBrief: OrchestrationBrief | null;
}

export interface TaskExecutionOutput {
  result: string;                 // 에이전트 출력
  filesModified: string[];        // 수정된 파일 목록 (가능한 경우)
  tokensUsed: number | null;
  costUsd: number | null;
}

// ─── Capability Matching ───

export interface CapabilityScore {
  agentId: string;
  taskId: string;
  score: number;                  // 0.0 ~ 1.0
  matchedCapabilities: string[];
  missingCapabilities: string[];
}

// ─── OrchestrationBrief: 엔진이 에이전트에게 전달하는 실행 컨텍스트 ───

/** Summarized result of a previously completed task in the same run. */
export interface PriorTaskResult {
  taskId: string;
  taskTitle: string;
  result: string;
  filesModified: string[];
}

/**
 * Ephemeral, per-run context that the orchestration engine attaches to each
 * task execution. Tells the agent WHY this task exists, WHAT happened before,
 * WHERE it sits in the overall plan, and WHAT comes after.
 *
 * This is architecturally distinct from agent memory (persistent knowledge)
 * and agent context (systemPrompt, tools, projectDirectory — filled by backend).
 */
export interface OrchestrationBrief {
  /** High-level objective of the entire run (derived from root task titles). */
  runGoal: string;
  /** Specific objective for THIS task. */
  taskObjective: string;
  /** Results from upstream tasks that this task depends on. */
  priorResults: PriorTaskResult[];
  /** Human-readable position string, e.g. "Batch 2 of 4". */
  positionInPlan: string;
  /** Hint about what downstream tasks depend on this task's output. */
  downstreamHint: string | null;
}

export type { ReviewResult, IResultReviewer } from './reviewer';
