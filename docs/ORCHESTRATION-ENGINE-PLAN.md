# MARS Orchestration Engine — Implementation Plan

> **⚠️ SUPERSEDED**: 이 문서는 v1 아키텍처 (Bootstrap→Materialize→Decompose→Schedule pipeline) 기준.
> v2 아키텍처는 `PLAN-v2.md` 참조. 주요 변경: Agent Pool 패턴, ReactiveScheduler, 상시활성 오케스트레이터.
> 삭제된 모듈: `scheduler.ts`, `router.ts`, `claim.ts`, `heartbeat.ts`, `bootstrap-service.ts`, `instruction-analyzer.ts`

> Multi-Agent Runtime Studio의 핵심인 멀티 에이전트 오케스트레이션 엔진 구현 계획서.
> 이 문서는 Anthropic의 공식 에이전트 아키텍처 연구를 기반으로 설계되었음.

---

## 0. Executive Summary

MARS는 현재 CRUD 수준의 서비스(Agent, Task, Project, Provider, MCP, Memory)를 갖추고 있지만,
**에이전트가 실제로 태스크를 실행하고 협업하는 런타임 엔진이 없다.**

이 계획서는 다음을 구현하기 위한 청사진이다:

1. **Execution Runtime** — 에이전트가 실제로 LLM을 호출하고 도구를 사용하는 실행 루프
2. **Orchestrator** — 태스크를 분해하고, 에이전트에 할당하고, 실행 흐름을 제어하는 중앙 조정자
3. **Communication Layer** — 에이전트 간 메시지 전달, 결과 핸드오프, 상태 동기화
4. **Lifecycle Management** — 세션 관리, 에러 복구, 타임아웃, 재시도

**핵심 설계 원칙** (Anthropic "Building Effective Agents" 블로그에서 차용):
- Start simple, add complexity only when it demonstrably improves outcomes
- Simplicity, Transparency, ACI (Agent-Computer Interface)

---

## 1. Architecture Overview

### 1.1 Anthropic 패턴 → MARS 매핑

| Anthropic Pattern | MARS Phase | 구현 위치 |
|---|---|---|
| **Prompt Chaining** | Wizard → Task 생성 | `src/wizard/` |
| **Routing** | Capability Matching (Task ↔ Agent) | `src/orchestrator/router.ts` |
| **Parallelization** | 독립 서브태스크 병렬 실행 | `src/orchestrator/scheduler.ts` |
| **Orchestrator-Workers** | 메인 오케스트레이터 + Agent Workers | `src/orchestrator/engine.ts` |
| **Evaluator-Optimizer** | Review 단계 (결과 검증 → 피드백 루프) | `src/orchestrator/reviewer.ts` |
| **Agent Loop** | 개별 에이전트의 tool-calling 루프 | `src/execution/agent-runner.ts` |

### 1.2 High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        MARS Backend (Bun)                       │
│                                                                 │
│  ┌─────────────┐    ┌─────────────────────────────────────┐    │
│  │   Routes     │───▶│         Orchestration Engine         │    │
│  │  (HTTP API)  │    │                                     │    │
│  └─────────────┘    │  ┌───────────┐  ┌──────────────┐   │    │
│                      │  │  Engine    │  │  Scheduler    │   │    │
│                      │  │ (control)  │──│ (dependency   │   │    │
│                      │  │            │  │  + parallel)  │   │    │
│                      │  └─────┬──┬──┘  └──────────────┘   │    │
│                      │        │  │                          │    │
│                      │  ┌─────▼──┘  ┌────────────────┐    │    │
│                      │  │ Router    │  │  Reviewer      │    │    │
│                      │  │ (assign)  │  │  (validate)    │    │    │
│                      │  └───────────┘  └────────────────┘    │    │
│                      └────────────┬────────────────────────┘    │
│                                   │                              │
│                      ┌────────────▼────────────────────────┐    │
│                      │         Execution Layer              │    │
│                      │                                     │    │
│                      │  ┌───────────┐  ┌───────────────┐  │    │
│                      │  │  Agent     │  │  Agent         │  │    │
│                      │  │  Runner 1  │  │  Runner 2      │  │    │
│                      │  │  (session) │  │  (session)     │  │    │
│                      │  └─────┬─────┘  └──────┬────────┘  │    │
│                      └────────┼────────────────┼───────────┘    │
│                               │                │                 │
│                      ┌────────▼────────────────▼───────────┐    │
│                      │       Provider Adapters              │    │
│                      │  ┌──────────┐  ┌──────────────────┐ │    │
│                      │  │ Claude   │  │  Anthropic API    │ │    │
│                      │  │ CLI      │  │  (future)         │ │    │
│                      │  └──────────┘  └──────────────────┘ │    │
│                      └──────────────────────────────────────┘    │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐    │
│  │  Event Bus   │  │  SQLite DB   │  │  MCP Manager        │    │
│  │  (Emitter)   │  │  (state)     │  │  (tool routing)     │    │
│  └─────────────┘  └─────────────┘  └─────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 실행 흐름 (End-to-End)

```
1. User → Wizard에서 컨텍스트 수집
2. Wizard → Task Document 생성 (사용자 리뷰)
3. User 확인 → Engine.startRun(projectId, taskIds)
4. Engine → Decomposer로 서브태스크 분해 (사용자 리뷰)
5. Scheduler → 의존성 분석, 실행 순서 결정
6. Router → 각 서브태스크에 최적 에이전트 매칭
7. Scheduler → 독립 태스크들 병렬 실행 시작
8. AgentRunner → 개별 에이전트 세션 생성, LLM 호출 루프
9. AgentRunner → 결과 반환 (성공/실패/대기)
10. Reviewer → 결과 검증 (자동 또는 사용자 리뷰)
11. Engine → 다음 배치 실행 또는 완료
12. Event Bus → 매 단계 실시간 이벤트 발행 (프론트엔드용)
```

---

## 2. New Directory Structure

```
src/
├── orchestrator/               # 오케스트레이션 엔진
│   ├── engine.ts               # OrchestratorEngine — 전체 실행 흐름 제어
│   ├── scheduler.ts            # TaskScheduler — 의존성 분석, 병렬/순차 실행 결정
│   ├── router.ts               # AgentRouter — capability matching, 에이전트 선택
│   ├── decomposer.ts           # TaskDecomposer — AI 기반 서브태스크 분해
│   ├── reviewer.ts             # ResultReviewer — 실행 결과 검증/피드백 루프
│   └── types.ts                # 오케스트레이션 전용 타입 정의
│
├── execution/                  # 에이전트 실행 런타임
│   ├── agent-runner.ts         # AgentRunner — 개별 에이전트 실행 루프
│   ├── session-manager.ts      # SessionManager — 세션 생성/추적/정리
│   ├── context-builder.ts      # ContextBuilder — 시스템 프롬프트 + 도구 + 메모리 조립
│   └── types.ts                # 실행 전용 타입 정의
│
├── events/                     # 이벤트 시스템
│   ├── bus.ts                  # EventBus — typed event emitter
│   └── types.ts                # 이벤트 타입 정의
│
├── (existing modules...)
```

---

## 3. Type Definitions

### 3.1 Orchestration Types (`src/orchestrator/types.ts`)

```typescript
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
  taskTimeoutMs: number;          // 개별 태스크 타임아웃 (default: 5분)
  autoReview: boolean;            // Reviewer 자동 실행 여부
  requireHumanApproval: boolean;  // 분해/할당에 사용자 승인 필요 여부
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
```

### 3.2 Execution Types (`src/execution/types.ts`)

```typescript
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

export interface SessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool_result';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface AgentContext {
  agent: Agent;                   // 에이전트 설정
  task: Task;                     // 실행할 태스크
  systemPrompt: string;           // 조립된 최종 시스템 프롬프트
  tools: ToolConfig[];            // 사용 가능한 도구
  memory: string;                 // 관련 장기 메모리
  priorResults: string[];         // 선행 태스크 결과들
  workingDirectory: string;
}

export interface ToolConfig {
  name: string;
  source: 'mcp' | 'builtin';
  mcpServerId?: string;
  enabled: boolean;
}

export interface RunnerCallbacks {
  onStart: (session: AgentSession) => void;
  onChunk: (sessionId: string, chunk: string) => void;
  onToolUse: (sessionId: string, tool: string, input: unknown) => void;
  onComplete: (sessionId: string, output: TaskExecutionOutput) => void;
  onError: (sessionId: string, error: Error) => void;
}
```

### 3.3 Event Types (`src/events/types.ts`)

```typescript
export type MarsEvent =
  // Run lifecycle
  | { type: 'run:created'; runId: string; projectId: string }
  | { type: 'run:started'; runId: string }
  | { type: 'run:completed'; runId: string; result: RunResult }
  | { type: 'run:failed'; runId: string; error: string }
  | { type: 'run:cancelled'; runId: string }
  | { type: 'run:paused'; runId: string }

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

  // Review
  | { type: 'review:started'; taskId: string }
  | { type: 'review:passed'; taskId: string }
  | { type: 'review:failed'; taskId: string; feedback: string }

  // Agent status
  | { type: 'agent:status_changed'; agentId: string; from: string; to: string };

export interface ProposedSubtask {
  title: string;
  description: string;
  requiredCapabilities: string[];
  dependsOn: string[];            // 다른 proposed subtask의 임시 ID
  estimatedDurationMin: number;
}
```

---

## 4. DB Schema Additions

기존 스키마에 추가할 테이블들:

```sql
-- Runs: 오케스트레이션 실행 단위
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_task_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array
  status TEXT NOT NULL DEFAULT 'pending',
  config TEXT NOT NULL DEFAULT '{}',          -- JSON: RunConfig
  execution_plan TEXT,                        -- JSON: ExecutionPlan | null
  result TEXT,                                -- JSON: RunResult | null
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_project ON runs (project_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs (created_at);

-- Task Executions: 개별 태스크 실행 기록
CREATE TABLE IF NOT EXISTS task_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 1,
  input TEXT NOT NULL DEFAULT '{}',           -- JSON: TaskExecutionInput
  output TEXT,                                -- JSON: TaskExecutionOutput | null
  started_at INTEGER,
  completed_at INTEGER,
  duration_ms INTEGER,
  error TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_task_exec_run ON task_executions (run_id);
CREATE INDEX IF NOT EXISTS idx_task_exec_task ON task_executions (task_id);
CREATE INDEX IF NOT EXISTS idx_task_exec_agent ON task_executions (agent_id);
CREATE INDEX IF NOT EXISTS idx_task_exec_status ON task_executions (status);

-- Task Dependencies: 태스크 간 의존성
CREATE TABLE IF NOT EXISTS task_dependencies (
  id TEXT PRIMARY KEY,
  from_task_id TEXT NOT NULL,
  to_task_id TEXT NOT NULL,
  dependency_type TEXT NOT NULL DEFAULT 'blocks',  -- 'blocks' | 'informs'
  created_at INTEGER NOT NULL,
  FOREIGN KEY (from_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (to_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE(from_task_id, to_task_id)
);

CREATE INDEX IF NOT EXISTS idx_deps_from ON task_dependencies (from_task_id);
CREATE INDEX IF NOT EXISTS idx_deps_to ON task_dependencies (to_task_id);
```

### 기존 `tasks` 테이블 변경 필요사항

```sql
-- tasks 테이블에 capabilities 컬럼 추가
ALTER TABLE tasks ADD COLUMN required_capabilities TEXT NOT NULL DEFAULT '[]';

-- agents 테이블에 capabilities + status 컬럼 추가
ALTER TABLE agents ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'offline';
-- status: 'offline' | 'ready' | 'busy' | 'error'
```

---

## 5. Module Specifications

### 5.1 EventBus (`src/events/bus.ts`)

**책임**: 타입 안전한 이벤트 발행/구독 시스템. 모든 모듈이 상태 변화를 이벤트로 알림.

```typescript
interface IEventBus {
  emit(event: MarsEvent): void;
  on(type: MarsEvent['type'], handler: (event: MarsEvent) => void): () => void;
  once(type: MarsEvent['type'], handler: (event: MarsEvent) => void): () => void;
  off(type: MarsEvent['type'], handler: (event: MarsEvent) => void): void;
  removeAllListeners(): void;
}
```

**구현 노트**:
- `EventEmitter` 기반 래퍼
- 싱글톤 인스턴스로 export
- 프론트엔드 연결 시 Tauri IPC 이벤트로 브리지 가능
- 모든 이벤트 로깅 (디버그 모드)

**의존성**: 없음 (최하위 레이어)

---

### 5.2 ContextBuilder (`src/execution/context-builder.ts`)

**책임**: 에이전트 실행에 필요한 전체 컨텍스트 조립.

```typescript
interface IContextBuilder {
  build(params: {
    agent: Agent;
    task: Task;
    priorResults?: TaskExecutionOutput[];
    projectDirectory: string;
  }): Promise<AgentContext>;
}
```

**조립 순서**:
1. Agent의 `systemPrompt` 기본 로드
2. Task 설명 + 요구사항 주입
3. 선행 태스크 결과 컨텍스트 추가 (있는 경우)
4. Agent에 연결된 MCP 서버들의 도구 목록 수집
5. 관련 장기 메모리 검색 및 주입
6. 프로젝트 디렉토리 설정

**의존성**: `AgentService`, `MCPServerService`, `MemoryService`

---

### 5.3 SessionManager (`src/execution/session-manager.ts`)

**책임**: 에이전트 실행 세션의 생명주기 관리.

```typescript
interface ISessionManager {
  createSession(agentId: string, taskExecutionId: string): AgentSession;
  getSession(sessionId: string): AgentSession | null;
  updateSession(sessionId: string, updates: Partial<AgentSession>): void;
  endSession(sessionId: string, status: AgentSession['status']): void;
  getActiveSessions(): AgentSession[];
  cleanupStale(maxIdleMs: number): void;
}
```

**구현 노트**:
- 인메모리 Map으로 활성 세션 관리
- DB에는 완료된 세션만 영속화 (task_executions 테이블)
- CLI 세션 ID와 내부 세션 ID 매핑
- 주기적 stale 세션 정리 (타임아웃)

**의존성**: `EventBus`

---

### 5.4 AgentRunner (`src/execution/agent-runner.ts`)

**책임**: 개별 에이전트의 실행 루프. Provider 어댑터를 통해 LLM을 호출하고 결과를 반환.

```typescript
interface IAgentRunner {
  run(context: AgentContext, callbacks: RunnerCallbacks): Promise<TaskExecutionOutput>;
  abort(sessionId: string): Promise<void>;
}
```

**실행 루프** (Anthropic의 Agent Loop 패턴):
```
1. ContextBuilder에서 받은 AgentContext로 프롬프트 구성
2. Provider Adapter(현재 ClaudeCliExecutor)를 통해 LLM 호출
3. 스트리밍 응답 수신 → 실시간 이벤트 발행
4. 결과 파싱:
   a. 정상 완료 → TaskExecutionOutput 반환
   b. 도구 호출 필요 → (Claude CLI가 내부적으로 처리, 우리는 결과만 수신)
   c. 에러 → 에러 이벤트 발행, throw
5. CLI 세션 ID 캡처 (resume 가능하도록)
```

**첫 번째 구현은 Claude CLI 어댑터 전용**:
- `ClaudeCliExecutor.executeStreaming()` 호출
- `--print` 모드로 1회 실행 (tool calling은 CLI 내부에서 처리)
- 향후 Messages API 직접 호출 시 tool-calling 루프 직접 구현 필요

**의존성**: `ClaudeCliExecutor`, `SessionManager`, `EventBus`

---

### 5.5 AgentRouter (`src/orchestrator/router.ts`)

**책임**: 태스크의 요구사항과 에이전트의 역량을 매칭하여 최적의 에이전트를 선택.

```typescript
interface IAgentRouter {
  // 단일 태스크에 대해 에이전트 순위 산출
  rankAgents(taskId: string, availableAgentIds: string[]): Promise<CapabilityScore[]>;

  // 여러 태스크를 에이전트들에 최적 배분
  assignBatch(taskIds: string[], availableAgentIds: string[]): Promise<Map<string, string>>;

  // 특정 태스크에 최적 에이전트 1명 선택
  selectBest(taskId: string, availableAgentIds: string[]): Promise<string | null>;
}
```

**매칭 알고리즘**:
```
score = (matchedCapabilities.length / requiredCapabilities.length) * 0.7
      + (agent.status === 'ready' ? 0.2 : 0.0)
      + (agent.stats.errorRate < 0.1 ? 0.1 : 0.0)
```

**초기 구현**: 단순 capability intersection 기반.
**향후**: ML 기반 매칭, 에이전트 부하 분산, 히스토리 기반 최적화.

**의존성**: `AgentService`, `TaskService`

---

### 5.6 TaskDecomposer (`src/orchestrator/decomposer.ts`)

**책임**: AI를 사용하여 상위 태스크를 실행 가능한 서브태스크들로 분해.

```typescript
interface ITaskDecomposer {
  // AI에게 서브태스크 분해 요청 → ProposedSubtask[] 반환
  propose(taskId: string, projectContext: string): Promise<ProposedSubtask[]>;

  // 사용자 승인 후 실제 태스크로 생성
  confirm(parentTaskId: string, approved: ProposedSubtask[]): Promise<Task[]>;
}
```

**프롬프트 전략**:
- 분해 전용 에이전트(또는 Orchestrator 에이전트)가 태스크 + 프로젝트 컨텍스트를 받음
- Structured output (JSON) 으로 서브태스크 목록 반환
- 각 서브태스크에 `requiredCapabilities`와 `dependsOn` 관계 포함

**반드시 사용자 승인 필요** (SPEC.md §8: "Never auto-execute")

**의존성**: `AgentRunner` (분해 프롬프트 실행용), `TaskService`, `EventBus`

---

### 5.7 TaskScheduler (`src/orchestrator/scheduler.ts`)

**책임**: 태스크 의존성 그래프를 분석하여 실행 계획(배치) 생성.

```typescript
interface ITaskScheduler {
  // 의존성 그래프 분석 → 실행 계획 생성
  createPlan(taskIds: string[], dependencies: DependencyEdge[]): ExecutionPlan;

  // 순환 의존성 검출
  detectCycles(dependencies: DependencyEdge[]): DependencyEdge[][] | null;

  // 다음 실행 가능한 배치 반환 (이미 완료된 태스크 고려)
  getNextBatch(plan: ExecutionPlan, completedTaskIds: Set<string>): ExecutionBatch | null;
}
```

**알고리즘**: Topological Sort (Kahn's Algorithm)
1. `dependsOn` 관계로 DAG 구성
2. in-degree 0인 태스크들 = 첫 번째 배치
3. 배치 실행 완료 후, 완료된 태스크를 그래프에서 제거
4. 새로 in-degree 0이 된 태스크들 = 다음 배치
5. 순환 의존성 감지 시 에러

**의존성**: 없음 (순수 함수)

---

### 5.8 ResultReviewer (`src/orchestrator/reviewer.ts`)

**책임**: 에이전트 실행 결과를 검증하고, 불합격 시 피드백 루프.

```typescript
interface IResultReviewer {
  // 결과 검증 (자동 또는 AI 기반)
  review(execution: TaskExecution): Promise<ReviewResult>;

  // 사용자에게 리뷰 요청
  requestHumanReview(execution: TaskExecution): Promise<ReviewResult>;
}

interface ReviewResult {
  passed: boolean;
  feedback: string;
  suggestedAction: 'approve' | 'retry' | 'reassign' | 'escalate';
}
```

**리뷰 전략 (단계적)**:
1. **Phase 1 (MVP)**: 실행 성공/실패만 확인 + 사용자 최종 승인
2. **Phase 2**: AI Reviewer 에이전트가 결과 품질 평가
3. **Phase 3**: 자동 테스트 실행, 린트 체크 등 프로그래매틱 검증

**의존성**: `AgentRunner` (AI 리뷰 시), `EventBus`

---

### 5.9 OrchestratorEngine (`src/orchestrator/engine.ts`)

**책임**: 모든 모듈을 조합하여 전체 오케스트레이션 흐름을 제어하는 최상위 컨트롤러.

```typescript
interface IOrchestratorEngine {
  // 새 실행 생성
  createRun(projectId: string, taskIds: string[], config?: Partial<RunConfig>): Promise<Run>;

  // 실행 시작 (decompose → schedule → execute → review)
  startRun(runId: string): Promise<void>;

  // 실행 일시 중지
  pauseRun(runId: string): Promise<void>;

  // 실행 재개
  resumeRun(runId: string): Promise<void>;

  // 실행 취소
  cancelRun(runId: string): Promise<void>;

  // 실행 상태 조회
  getRunStatus(runId: string): Promise<Run>;

  // 활성 실행 목록
  listActiveRuns(projectId?: string): Promise<Run[]>;
}
```

**Engine Main Loop (startRun 내부)**:

> **📌 HITL 연동**: 아래 코드에서 `this.gate.request()` 호출은 InteractionGate의 Deferred Promise 패턴을 사용한다.
> Autonomy Level이 `approval`이면 사용자 응답까지 Promise가 대기하고, `autonomous`이면 즉시 resolve된다.
> 전체 HITL 통합 의사 코드는 [HITL-ARCHITECTURE-PLAN.md §7](./HITL-ARCHITECTURE-PLAN.md#7-integration-points) 참조.

```typescript
async startRun(runId: string): Promise<void> {
  const run = await this.getRun(runId);

  // Phase 1: Decomposition
  this.updateStatus(runId, 'decomposing');
  for (const taskId of run.rootTaskIds) {
    const subtasks = await this.decomposer.propose(taskId, projectContext);
    this.bus.emit({ type: 'decompose:proposed', taskId, subtasks });

    // ★ HITL: 분해 결과 승인 요청 (InteractionGate)
    // gate.request()는 autonomy level에 따라 즉시 resolve 또는 사용자 대기
    const response = await this.gate.request({
      type: 'decomposition_approval',
      runId,
      question: {
        title: '서브태스크 분해 결과 확인',
        description: `${subtasks.length}개의 서브태스크로 분해되었습니다.`,
        payload: { originalTaskId: taskId, subtasks },
        suggestedAction: 'approve',
        options: [
          { value: 'approve', label: '승인', isDefault: true },
          { value: 'reject', label: '반려', isDefault: false },
          { value: 'modify', label: '수정 후 진행', isDefault: false },
        ],
      },
      metadata: { source: 'orchestrator', priority: 'high' },
    });

    if (response.action === 'reject') {
      this.updateStatus(runId, 'failed');
      throw new Error(`Decomposition rejected for task ${taskId}`);
    }
    if (response.action === 'modify' && response.modifiedPayload) {
      await this.decomposer.applyModifications(taskId, response.modifiedPayload.subtasks);
    } else {
      await this.decomposer.confirm(taskId, subtasks);
    }
  }

  // Phase 2: Scheduling
  this.updateStatus(runId, 'scheduling');
  const allTaskIds = this.collectAllTaskIds(run);
  const deps = await this.loadDependencies(allTaskIds);
  const plan = this.scheduler.createPlan(allTaskIds, deps);
  this.savePlan(runId, plan);

  // ★ HITL: 실행 계획 승인 요청
  const planResponse = await this.gate.request({
    type: 'plan_approval',
    runId,
    question: {
      title: '실행 계획 확인',
      description: `${plan.batches.length}개 배치, 총 ${allTaskIds.length}개 태스크`,
      payload: { plan },
      suggestedAction: 'approve',
      options: [
        { value: 'approve', label: '실행 시작', isDefault: true },
        { value: 'reject', label: '취소', isDefault: false },
      ],
    },
    metadata: { source: 'orchestrator', priority: 'high' },
  });

  if (planResponse.action === 'reject' || planResponse.action === 'cancel') {
    this.updateStatus(runId, 'cancelled');
    throw new Error('Execution plan rejected by user');
  }

  // Phase 3: Execute batch by batch
  this.updateStatus(runId, 'running');
  const completed = new Set<string>();

  while (true) {
    const batch = this.scheduler.getNextBatch(plan, completed);
    if (!batch) break;

    this.bus.emit({ type: 'batch:started', batchIndex: batch.batchIndex, taskIds: batch.taskIds });

    // 배치 내 태스크들 병렬 실행
    // 주의: 각 executeTask 내부에서도 AgentRunner를 통해 HITL 요청이 발생할 수 있음
    const results = await Promise.allSettled(
      batch.taskIds.map(taskId => this.executeTask(runId, taskId))
    );

    // 결과 처리
    for (const [i, result] of results.entries()) {
      const taskId = batch.taskIds[i];
      if (result.status === 'fulfilled') {
        completed.add(taskId);
      } else {
        // 실패 처리: 재시도 또는 중단
        await this.handleTaskFailure(runId, taskId, result.reason);
      }
    }

    this.bus.emit({ type: 'batch:completed', batchIndex: batch.batchIndex });
  }

  // Phase 4: Review
  if (run.config.autoReview) {
    this.updateStatus(runId, 'reviewing');
    const reviewResult = await this.reviewer.review(run);

    // ★ HITL: 리뷰 결과에 대한 최종 승인 (선택적)
    // ResultReviewer 내부에서 gate.request()를 호출할 수도 있음
    // → HITL-ARCHITECTURE-PLAN.md §7.4 참조
  }

  this.updateStatus(runId, 'completed');
}
```

**의존성**: `TaskDecomposer`, `TaskScheduler`, `AgentRouter`, `AgentRunner`, `ResultReviewer`, `ContextBuilder`, `SessionManager`, `EventBus`, **`InteractionGate`**

> **참고**: `InteractionGate`는 HITL 모듈(`src/hitl/interaction-gate.ts`)에서 제공된다.
> Engine 생성자에서 DI로 주입받으며, 각 Phase에서 사용자 승인이 필요한 시점에 `gate.request()`를 호출한다.
> Autonomy 설정에 따라 자동 승인(`autonomous`) 또는 사용자 대기(`approval`)가 결정된다.
> 상세 설계는 [HITL-ARCHITECTURE-PLAN.md §5.1 InteractionGate](./HITL-ARCHITECTURE-PLAN.md) 참조.

---

## 6. API Routes (추가)

```typescript
// POST /api/projects/:projectId/runs
// → Engine.createRun()
// Body: { taskIds: string[], config?: Partial<RunConfig> }

// POST /api/runs/:runId/start
// → Engine.startRun()

// POST /api/runs/:runId/pause
// → Engine.pauseRun()

// POST /api/runs/:runId/resume
// → Engine.resumeRun()

// POST /api/runs/:runId/cancel
// → Engine.cancelRun()

// GET /api/runs/:runId
// → Engine.getRunStatus()

// GET /api/projects/:projectId/runs
// → Engine.listActiveRuns()

// POST /api/tasks/:taskId/decompose
// → Decomposer.propose()
// Response: { subtasks: ProposedSubtask[] }

// POST /api/tasks/:taskId/decompose/confirm
// → Decomposer.confirm()
// Body: { approved: ProposedSubtask[] }

// GET /api/tasks/:taskId/match-agents
// → Router.rankAgents()
// Response: { scores: CapabilityScore[] }

// GET /api/events/stream
// → SSE (Server-Sent Events) 스트림
// → EventBus의 이벤트를 SSE로 변환하여 프론트엔드에 실시간 전달
```

---

## 7. Implementation Order (구현 순서)

### Phase A: Foundation (기반 레이어)

| # | 모듈 | 파일 | 예상 공수 | 설명 |
|---|---|---|---|---|
| A1 | Event Bus | `src/events/bus.ts`, `types.ts` | Small | 타입 안전 이벤트 시스템 |
| A2 | DB Schema | `src/db/index.ts` 수정 | Small | runs, task_executions, task_dependencies 테이블 추가 |
| A3 | DB Repos | `src/db/run-repo.ts`, `task-exec-repo.ts`, `dep-repo.ts` | Medium | 새 테이블 CRUD |
| A4 | Type Defs | `src/orchestrator/types.ts`, `src/execution/types.ts`, `src/events/types.ts` | Small | 위 섹션 3의 타입들 |
| A5 | Existing Schema Migration | `tasks` + `agents` 테이블 ALTER | Small | capabilities, status 컬럼 추가 |

### Phase B: Execution Layer (실행 레이어)

| # | 모듈 | 파일 | 예상 공수 | 설명 |
|---|---|---|---|---|
| B1 | Session Manager | `src/execution/session-manager.ts` | Small | 세션 생명주기 |
| B2 | Context Builder | `src/execution/context-builder.ts` | Medium | 시스템 프롬프트 + 도구 + 메모리 조립 |
| B3 | Agent Runner | `src/execution/agent-runner.ts` | Large | 에이전트 실행 루프 (Claude CLI 연동) |

### Phase C: Orchestration Layer (오케스트레이션 레이어)

| # | 모듈 | 파일 | 예상 공수 | 설명 |
|---|---|---|---|---|
| C1 | Task Scheduler | `src/orchestrator/scheduler.ts` | Medium | 의존성 분석 + 배치 생성 (순수 알고리즘) |
| C2 | Agent Router | `src/orchestrator/router.ts` | Medium | Capability matching |
| C3 | Task Decomposer | `src/orchestrator/decomposer.ts` | Medium | AI 기반 서브태스크 분해 |
| C4 | Result Reviewer | `src/orchestrator/reviewer.ts` | Small (MVP) | 단순 성공/실패 확인 |
| C5 | Orchestrator Engine | `src/orchestrator/engine.ts` | Large | 전체 흐름 조합 |

### Phase D: Integration (통합)

| # | 모듈 | 파일 | 예상 공수 | 설명 |
|---|---|---|---|---|
| D1 | API Routes | `src/routes/runs.ts`, `src/routes/orchestrator.ts` | Medium | HTTP endpoints |
| D2 | SSE Stream | `src/routes/events.ts` | Small | 실시간 이벤트 스트림 |
| D3 | Existing Service Updates | `agents/service.ts`, `tasks/service.ts` 수정 | Small | capabilities, status 지원 |

### 구현 순서 요약

```
A1 → A4 → A2 → A3 → A5 (Foundation — 병렬 가능)
         ↓
B1 → B2 → B3 (Execution — 순차)
         ↓
C1 (독립) ─┐
C2 (독립) ─┼→ C5 (Engine — C1~C4 완료 후)
C3 (B3 필요)┤
C4 (B3 필요)┘
         ↓
D1 → D2 → D3 (Integration)
```

---

## 8. Key Design Decisions

### 8.1 왜 Claude CLI를 첫 번째 Provider로?

- CLI가 tool-calling 루프를 내부적으로 처리 → 우리가 직접 구현할 필요 없음
- 세션 관리 (`--resume`, `--continue`) 내장
- 권한 모드 (`--permission-mode`) 내장
- MCP 서버 연결 (`--mcp-config`) 내장
- 이미 `ClaudeCliExecutor`가 구현되어 있음

**트레이드오프**: CLI 의존성, 스트리밍 제어 한계, 에이전트 간 메시지 전달 불가.
**향후**: Anthropic Messages API 직접 호출로 전환하면 더 세밀한 제어 가능.

### 8.2 왜 Batch 기반 실행?

- 의존성 없는 태스크들을 배치로 묶어 병렬 실행
- 각 배치는 이전 배치의 모든 태스크가 완료된 후 시작
- 단순하면서도 의존성 존중 + 병렬성 확보
- Anthropic의 "Parallelization (Sectioning)" 패턴 직접 구현

### 8.3 왜 사용자 승인 필수?

- SPEC.md §8: "Never auto-execute — always show proposed plan/subtasks for human review"
- 분해 결과, 에이전트 배정 모두 사용자 확인 후 진행
- `requireHumanApproval: false` 옵션으로 자동 모드도 지원 (파워 유저용)

### 8.4 Context Isolation 전략

Anthropic Claude Code의 핵심 교훈: **각 에이전트는 격리된 컨텍스트에서 실행**.

- 각 AgentRunner 인스턴스는 독립적인 CLI 프로세스
- 에이전트 간 직접 통신 없음 (Phase 1)
- 선행 태스크 결과는 ContextBuilder가 다음 에이전트의 프롬프트에 주입
- 이 방식이 "context pollution" 방지

### 8.5 에러 복구 전략

```
태스크 실패
  ├─ attempt < maxRetries → 재시도 (같은 에이전트)
  ├─ attempt >= maxRetries → 다른 에이전트에 재배정 시도
  ├─ 모든 에이전트 실패 → 사용자에게 에스컬레이션
  └─ 선행 태스크 실패 → 후행 태스크 'skipped' 처리
```

---

## 9. Future Considerations (Phase 2+)

이 계획서의 범위 **밖**이지만, 아키텍처 설계 시 확장 가능하도록 고려해야 할 사항들:

### 9.1 Agent-to-Agent Communication
- Phase 1: 없음 (결과는 Orchestrator를 통해 전달)
- Phase 2: 에이전트 간 직접 메시지 전달 (shared context pool)
- Phase 3: Agent Teams 패턴 (shared task list, atomic claiming)

### 9.2 Anthropic Messages API 직접 호출
- Tool-calling 루프 직접 구현 필요
- 스트리밍 제어 + 토큰 카운팅 + 비용 추적 가능
- MCP 도구 호출을 직접 라우팅

### 9.3 Multi-Provider 병렬 실행
- 하나의 Run에서 Claude, OpenAI, Ollama 에이전트 혼합 실행
- Provider 추상화 레이어 필요 (현재 `ICliExecutor` 인터페이스가 기반)

### 9.4 Wizard → Orchestrator 자동 연결
- Wizard 완료 시 자동으로 Run 생성 제안
- Confidence score 기반 자동화 수준 결정

### 9.5 Cost Optimization
- 연구에서 도출된 모델 캐스케이딩:
  - Orchestrator/Planner → Opus (비싼 모델)
  - Builder/Executor → Haiku (저렴한 모델, 전체 토큰의 60%)
  - Validator/Reviewer → Sonnet (중간 모델)
- Agent 설정 시 role-based 모델 추천 기능

---

## 10. Validation Criteria (구현 완료 기준)

### MVP (Phase A~D 완료 시)

- [ ] `POST /api/projects/:id/runs` — Run 생성 가능
- [ ] `POST /api/runs/:id/start` — 단일 태스크 실행 성공
- [ ] EventBus를 통해 실행 진행 상황 이벤트 수신 가능
- [ ] 에이전트가 Claude CLI를 통해 실제 LLM 호출 수행
- [ ] 세션 ID 캡처 및 저장
- [ ] 2개 이상의 독립 태스크 병렬 실행
- [ ] 의존성 있는 태스크의 순차 실행 (선행 결과 → 후행 컨텍스트)
- [ ] 태스크 분해 제안 → 사용자 확인 → 서브태스크 생성
- [ ] Capability matching으로 에이전트 자동 추천
- [ ] 실행 실패 시 재시도 동작
- [ ] SSE 스트림으로 프론트엔드에 실시간 이벤트 전달

---

*Last updated: 2026-03-03*
*Based on: Anthropic "Building Effective Agents" research + Claude Agent SDK + Claude Code v3 subagent architecture*
