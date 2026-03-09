// ─── Interaction: 하나의 인간-에이전트 상호작용 단위 ───

export type InteractionStatus =
  | 'pending'          // 인간 응답 대기 중
  | 'responded'        // 인간이 응답함
  | 'timeout'          // 타임아웃으로 fallback 실행됨
  | 'cancelled';       // Run 취소로 함께 취소됨

export type QuestionType =
  | 'clarification'            // 요구사항 명확화 필요
  | 'destructive_action'       // 파괴적 작업 확인 (파일 삭제, DB 변경 등)
  | 'ambiguity_resolution'     // 모호한 지시 해석 확인
  | 'permission_request'       // 권한 요청 (외부 API 호출 등)
  | 'agent_stuck'              // 에이전트가 진행 불가 상태
  | 'task_review';             // 태스크 결과 리뷰 요청

export type AutonomyLevel =
  | 1    // Autonomous: 에이전트가 자율 결정, 로그만 기록
  | 2    // Inform: 자동 결정 + 사용자 알림 (비차단, 추후 override 가능)
  | 3;   // Approval: 실행 일시 중지, 인간 응답 필수

export type FallbackAction =
  | 'fail'             // 타임아웃 시 태스크 실패 처리
  | 'auto_approve'     // 타임아웃 시 자동 승인
  | 'auto_answer'      // 타임아웃 시 에이전트의 제안을 자동 채택
  | 'skip';            // 타임아웃 시 해당 단계 건너뛰기

export type ResponseAction =
  | 'approve'          // 승인
  | 'reject'           // 반려
  | 'modify'           // 수정된 내용으로 승인
  | 'answer'           // 질문에 대한 답변
  | 'skip'             // 건너뛰기
  | 'cancel';          // Run 전체 취소

export interface Interaction {
  id: string;                           // UUID v4
  runId: string;                        // 소속 Run ID
  taskId: string | null;                // 관련 Task ID (orchestrator-level이면 null 가능)
  agentId: string | null;               // 관련 Agent ID (agent-level일 때)
  sessionId: string | null;             // 관련 Agent Session ID

  type: QuestionType;                   // 질문 유형
  level: AutonomyLevel;                 // 적용된 autonomy level
  status: InteractionStatus;            // 현재 상태

  question: InteractionQuestion;        // 표시할 질문 내용
  autoDecision: AutoDecision | null;    // 하위 호환용 (항상 null)
  response: InteractionResponse | null; // 인간 응답

  timeoutMs: number | null;             // 타임아웃 (ms), null이면 무제한 대기
  fallbackAction: FallbackAction;       // 타임아웃 시 행동
  expiresAt: number | null;             // 만료 시각 (epoch ms)

  metadata: InteractionMetadata;        // 추가 메타데이터

  createdAt: number;                    // 생성 시각 (epoch ms)
  respondedAt: number | null;           // 응답 시각 (epoch ms)
}

export interface InteractionQuestion {
  title: string;                        // 질문 제목 (UI 헤더)
  description: string;                  // 상세 설명 (마크다운 지원)
  payload: Record<string, unknown>;     // 질문 유형별 구조화된 데이터
  suggestedAction: ResponseAction;      // 에이전트/시스템이 제안하는 행동
  suggestedMessage: string | null;      // 제안 응답 내용
  options: InteractionOption[] | null;  // 선택지 목록 (있을 경우)
}

export interface InteractionOption {
  value: string;                        // 옵션 식별자
  label: string;                        // 표시 텍스트
  description: string | null;           // 옵션 설명
  isDefault: boolean;                   // 기본 선택 여부
}

export interface AutoDecision {
  action: ResponseAction;               // 자동으로 선택된 행동
  reason: string;                       // 자동 결정 사유
  decidedAt: number;                    // 결정 시각
}

export interface InteractionResponse {
  action: ResponseAction;               // 사용자가 선택한 행동
  message: string | null;               // 사용자 메시지 (자유 텍스트)
  modifiedPayload: Record<string, unknown> | null;  // 수정된 페이로드 (action='modify'일 때)
  respondedBy: 'human' | 'timeout' | 'system';       // 응답 주체
}

export interface InteractionMetadata {
  source: 'orchestrator' | 'agent' | 'reviewer';     // 발생 원점
  batchIndex: number | null;                          // 실행 배치 인덱스
  attempt: number | null;                             // 현재 재시도 횟수
  priority: 'low' | 'normal' | 'high' | 'critical';  // 우선순위
  tags: string[];                                     // 분류 태그
}

// ─── Deferred: Promise를 외부에서 resolve/reject 가능한 래퍼 ───

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  createdAt: number;
}

// ─── InteractionGate.request()에 전달하는 요청 객체 ───

export interface InteractionRequest {
  type: QuestionType;
  runId: string;
  taskId?: string;
  agentId?: string;
  sessionId?: string;
  question: InteractionQuestion;
  metadata?: Partial<InteractionMetadata>;
  /** Per-request fallback override. When set, takes precedence over global config. */
  fallbackAction?: FallbackAction;
  /** Per-request timeout override in ms. When set, takes precedence over global config. */
  timeoutMs?: number | null;
}

// ─── 파일 영속화 형식 (pending/*.json) ───

export interface PendingInteractionSnapshot {
  interaction: Interaction;
  createdAt: number;            // 스냅샷 생성 시각
  schemaVersion: 1;             // 향후 마이그레이션용
}

// ─── Simple Approval Config: 이진 승인 모드 ───

export interface SimpleApprovalConfig {
  approvalRequired: boolean;
  timeoutMs: number;
  fallbackAction: FallbackAction;
}

// ─── Legacy types (하위 호환 — default-config.ts, test 파일에서 참조) ───

export interface AutonomyRule {
  level: AutonomyLevel;
  timeoutMs: number | null;
  fallbackAction: FallbackAction;
}

export interface AutonomyConfig {
  global: AutonomyLevel;
  byQuestionType: Record<QuestionType, AutonomyRule>;
  byRun: Record<QuestionType, AutonomyRule> | null;
  byTask: Record<string, Partial<Record<QuestionType, AutonomyRule>>> | null;
}

export interface ResolvedAutonomy {
  level: AutonomyLevel;
  timeoutMs: number | null;
  fallbackAction: FallbackAction;
  resolvedFrom: 'byTask' | 'byRun' | 'byQuestionType' | 'global';
}

export interface HitlRunConfig {
  autonomyOverrides: Partial<Record<QuestionType, AutonomyRule>> | null;
  taskAutonomyOverrides: Record<string, Partial<Record<QuestionType, AutonomyRule>>> | null;
}
