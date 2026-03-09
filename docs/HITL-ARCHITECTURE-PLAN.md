# MARS Human-in-the-Loop (HITL) Architecture — Implementation Plan

> Multi-Agent Runtime Studio에서 인간과 에이전트 간의 상호작용을 관리하는 HITL 시스템 구현 계획서.
> LangGraph, CrewAI, AutoGen v0.4의 설계를 비교 분석하고, MARS 고유의 "Promise-Gated Interaction with Layered Autonomy" 패턴을 제안한다.

---

## 0. Executive Summary

MARS의 SPEC.md §8은 명확하다: **"Never auto-execute — always show proposed plan/subtasks for human review."**
하지만 현재 코드베이스에는 이 원칙을 강제할 메커니즘이 없다.

`TaskStatus`에 `review`가 존재하지만 승인 로직은 없고,
`RunConfig.requireHumanApproval` 플래그는 타입만 있고 구현이 없으며,
`ClaudeCliExecutor`에는 `AbortController`도 없어 실행 중인 에이전트를 중단할 수단조차 없다.

이 계획서는 다음을 구현하기 위한 청사진이다:

1. **InteractionGate** — Deferred Promise 패턴 기반의 단일 진입점. 호출자는 autonomy level과 무관하게 단순히 `await gate.request(...)` 한다.
2. **3-Level Autonomy** — Autonomous(로그만) / Inform(알림+자동) / Approval(대기) 세 단계 자율성
3. **Config Resolution Chain** — `byTask > byRun > byQuestionType > global` 우선순위로 autonomy level 결정
4. **File-Based Crash Recovery** — `data/interactions/pending/*.json`에 미결 상호작용을 직렬화, 앱 재시작 시 복원
5. **MCP Tool Integration** — 에이전트가 `mars_request_input` 도구로 인간에게 질문 (에이전트 입장에서는 느린 tool call일 뿐)
6. **SSE + REST API** — 프론트엔드에 실시간 알림, 인간 응답은 REST로 수신

**핵심 인사이트**: `Promise.allSettled`는 배치 내 한 에이전트가 인간 응답 대기 중이어도 나머지 에이전트의 완료를 기다린다.
InteractionGate의 Deferred Promise가 resolve될 때까지 해당 에이전트의 Promise는 settle되지 않으므로, 배치 레벨의 동기화가 자연스럽게 이루어진다.

---

## 1. Architecture Overview

### 1.1 HITL의 위치 (시스템 내 역할)

HITL 시스템은 Orchestration Engine과 Execution Layer 사이의 **수문(gate)** 역할을 한다.
모든 인간 개입이 필요한 지점에서 `InteractionGate.request()`가 호출되며,
autonomy level에 따라 즉시 통과하거나 인간 응답을 기다린다.

| 시스템 계층 | 역할 | HITL 연동 |
|---|---|---|
| **Frontend (React)** | 상호작용 UI 표시, 사용자 응답 입력 | SSE 수신 → 알림 표시, REST로 응답 전송 |
| **API Routes (Bun)** | SSE 스트림, 응답 수신 | `InteractionAPI`, `InteractionSSE` |
| **Orchestrator Engine** | 분해/할당/리뷰 결정 | 각 단계 진입 전 `InteractionGate.request()` 호출 |
| **Agent Runner** | 에이전트 실행 루프 | MCP tool `mars_request_input`으로 Gate 호출 |
| **InteractionGate** | **중앙 게이트** | Deferred Promise 관리, autonomy 판단, 타임아웃 |
| **InteractionStore** | 영속화 | SQLite + 파일 시스템 (`pending/*.json`) |
| **Recovery Manager** | 크래시 복구 | 앱 시작 시 미결 상호작용 재발행 |

### 1.2 High-Level Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                        MARS Frontend (React)                         │
│                                                                      │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  Notification     │  │  Approval Dialog  │  │  Input Form      │  │
│  │  Toast / Banner   │  │  (Level 3)        │  │  (Clarification) │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘  │
│           │                     │                      │             │
│           └─────────────────────┼──────────────────────┘             │
│                                 │                                    │
│                    ┌────────────▼────────────┐                      │
│                    │   EventSource (SSE)      │                      │
│                    │   POST /respond          │                      │
│                    └────────────┬────────────┘                      │
└─────────────────────────────────┼────────────────────────────────────┘
                                  │ HTTP
┌─────────────────────────────────┼────────────────────────────────────┐
│                        MARS Backend (Bun)                            │
│                                 │                                    │
│  ┌──────────────────────────────▼──────────────────────────────┐    │
│  │                      HITL Layer                              │    │
│  │                                                              │    │
│  │  ┌────────────────┐  ┌────────────────┐  ┌──────────────┐  │    │
│  │  │ InteractionAPI │  │ InteractionSSE │  │ MCP Tool     │  │    │
│  │  │ (REST routes)  │  │ (SSE stream)   │  │ Handler      │  │    │
│  │  └───────┬────────┘  └───────┬────────┘  └──────┬───────┘  │    │
│  │          │                   │                   │           │    │
│  │  ┌───────▼───────────────────▼───────────────────▼───────┐  │    │
│  │  │              InteractionGate (THE CORE)               │  │    │
│  │  │                                                       │  │    │
│  │  │  ┌─────────────────┐  ┌──────────────────────────┐   │  │    │
│  │  │  │ Deferred<R> Map │  │ Autonomy Config Resolver │   │  │    │
│  │  │  │ (pending gates) │  │ (level determination)    │   │  │    │
│  │  │  └─────────────────┘  └──────────────────────────┘   │  │    │
│  │  └───────────────────────────┬───────────────────────────┘  │    │
│  │                              │                               │    │
│  │  ┌───────────────────────────▼───────────────────────────┐  │    │
│  │  │            InteractionStore (Persistence)             │  │    │
│  │  │  ┌──────────────┐  ┌────────────────────────────┐    │  │    │
│  │  │  │ SQLite Table  │  │ File: pending/*.json       │    │  │    │
│  │  │  │ (interactions)│  │ (crash recovery snapshots) │    │  │    │
│  │  │  └──────────────┘  └────────────────────────────┘    │  │    │
│  │  └───────────────────────────────────────────────────────┘  │    │
│  │                                                              │    │
│  │  ┌───────────────────────────────────────────────────────┐  │    │
│  │  │          Recovery Manager (startup restore)           │  │    │
│  │  └───────────────────────────────────────────────────────┘  │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                   Orchestration Engine                        │   │
│  │  Engine ──► Gate.request('decomposition_approval', ...)      │   │
│  │  Router ──► Gate.request('assignment_approval', ...)         │   │
│  │  Runner ──► Gate.request('clarification', ...) via MCP tool  │   │
│  │  Reviewer → Gate.request('result_approval', ...)             │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐      │
│  │  Event Bus    │  │  SQLite DB   │  │  MCP Manager          │      │
│  └──────────────┘  └──────────────┘  └──────────────────────┘      │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.3 Interaction Flow (End-to-End)

```
1. 트리거 발생
   │  (Orchestrator: 분해 결과 생성 완료 / Agent: MCP tool 호출 / Reviewer: 검증 완료)
   ▼
2. InteractionGate.request(type, payload, context) 호출
   │
   ▼
3. Config Resolver가 autonomy level 결정
   │  byTask[taskId][type] > byRun[type] > byQuestionType[type] > global
   │
   ├── Level 1 (Autonomous): 즉시 resolve, 결과를 로그에 기록
   │
   ├── Level 2 (Inform): 즉시 resolve, SSE로 프론트엔드에 알림 발행
   │   │  (사용자가 나중에 override 가능 → 태스크 재실행 플래그)
   │   ▼
   │   EventBus.emit('hitl:created', { level: 'inform', ... })
   │
   └── Level 3 (Approval): Deferred<InteractionResponse> 생성
       │
       ▼
4. InteractionStore에 저장 (SQLite + pending/*.json)
   │
   ▼
5. EventBus.emit('hitl:created', { level: 'approval', ... })
   │  → SSE를 통해 프론트엔드에 전달
   │
   ▼
6. 프론트엔드: Approval Dialog 표시, 사용자 입력 대기
   │
   ▼
7. POST /api/interactions/:id/respond { action, message, modifiedPayload }
   │
   ▼
8. InteractionGate.respond(id, response)
   │  → Deferred.resolve(response)
   │  → pending/*.json 삭제
   │  → SQLite에 응답 기록
   │
   ▼
9. 원래 호출자의 await가 풀림 → 실행 계속
   │
   ▼
10. EventBus.emit('hitl:resolved', { id, action, ... })
```

**타임아웃 흐름 (Level 3):**
```
4. Deferred 생성 + setTimeout(timeoutMs) 등록
   │
   ▼  (시간 초과)
   │
5. 타임아웃 핸들러 실행
   │  → pending.has(id) 확인 (이미 응답됐으면 무시)
   │  → fallbackAction 결정 (fail | auto_approve | auto_answer)
   │  → Deferred.resolve({ action: fallbackAction, ... })
   │  → EventBus.emit('hitl:timeout', { id, fallbackAction })
```

---

## 2. New Directory Structure

```
src/
├── hitl/                            # Human-in-the-Loop 시스템
│   ├── interaction-gate.ts          # InteractionGate — 중앙 게이트 (Deferred Promise)
│   ├── interaction-store.ts         # InteractionStore — SQLite + 파일 영속화
│   ├── interaction-api.ts           # InteractionAPI — REST 라우트 핸들러
│   ├── interaction-sse.ts           # InteractionSSE — SSE 스트림 관리
│   ├── mcp-tool-handler.ts          # MCP Tool Handler — mars_request_input 처리
│   ├── recovery.ts                  # Recovery Manager — 크래시 복구
│   ├── default-config.ts            # 기본 autonomy 설정
│   └── types.ts                     # HITL 전용 타입 정의
│
├── (existing modules...)
│
data/
├── interactions/                    # 상호작용 영속화 (런타임 데이터)
│   ├── pending/                     # 미결 상호작용 JSON 스냅샷 (크래시 복구용)
│   │   ├── {interaction-id}.json
│   │   └── ...
│   └── .gitkeep
```

---

## 3. Type Definitions

### 3.1 Core HITL Types (`src/hitl/types.ts`)

```typescript
// ─── Interaction: 하나의 인간-에이전트 상호작용 단위 ───

export type InteractionStatus =
  | 'pending'          // 인간 응답 대기 중 (Level 3)
  | 'notified'         // 알림 발행됨, 자동 처리 완료 (Level 2)
  | 'auto_resolved'    // 자율 처리됨, 로그만 기록 (Level 1)
  | 'responded'        // 인간이 응답함
  | 'timeout'          // 타임아웃으로 fallback 실행됨
  | 'overridden'       // Level 2에서 사용자가 나중에 override함
  | 'cancelled';       // Run 취소로 함께 취소됨

export type QuestionType =
  // Orchestrator-level: 전체 실행 흐름에 대한 결정
  | 'decomposition_approval'   // 서브태스크 분해 결과 승인
  | 'assignment_approval'      // 에이전트 배정 결과 승인
  | 'plan_approval'            // 실행 계획 전체 승인
  | 'conflict_resolution'      // 에이전트 간 충돌 해결

  // Agent-level: 개별 에이전트가 실행 중 발생시키는 질문
  | 'clarification'            // 요구사항 명확화 필요
  | 'destructive_action'       // 파괴적 작업 확인 (파일 삭제, DB 변경 등)
  | 'ambiguity_resolution'     // 모호한 지시 해석 확인
  | 'permission_request'       // 권한 요청 (외부 API 호출 등)
  | 'agent_stuck'              // 에이전트가 진행 불가 상태

  // Review-level: 실행 결과에 대한 판단
  | 'result_approval'          // 태스크 결과 승인/반려
  | 'quality_override';        // 품질 기준 재정의 (Reviewer 판단 override)

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
  autoDecision: AutoDecision | null;    // Level 1/2에서의 자동 결정 내용
  response: InteractionResponse | null; // 인간 응답 (Level 3) 또는 override (Level 2)

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
}

// ─── 파일 영속화 형식 (pending/*.json) ───

export interface PendingInteractionSnapshot {
  interaction: Interaction;
  createdAt: number;            // 스냅샷 생성 시각
  schemaVersion: 1;             // 향후 마이그레이션용
}
```

### 3.2 Autonomy Config Types

```typescript
// ─── Autonomy Config: 상호작용 유형별 자율성 수준 결정 ───

export interface AutonomyRule {
  level: AutonomyLevel;
  timeoutMs: number | null;            // null = 무제한 대기 (Level 3 only)
  fallbackAction: FallbackAction;      // 타임아웃 시 행동
}

export interface AutonomyConfig {
  global: AutonomyLevel;                                  // 전역 기본값
  byQuestionType: Record<QuestionType, AutonomyRule>;     // 질문 유형별 설정
  byRun: Record<QuestionType, AutonomyRule> | null;       // Run 단위 오버라이드
  byTask: Record<string, Partial<Record<QuestionType, AutonomyRule>>> | null;  // Task 단위 오버라이드
}

// ─── Config Resolution 결과 ───

export interface ResolvedAutonomy {
  level: AutonomyLevel;
  timeoutMs: number | null;
  fallbackAction: FallbackAction;
  resolvedFrom: 'byTask' | 'byRun' | 'byQuestionType' | 'global';  // 어디서 결정됐는지
}

// ─── RunConfig 확장 (기존 RunConfig에 추가) ───

export interface HitlRunConfig {
  autonomyOverrides: Partial<Record<QuestionType, AutonomyRule>> | null;
  taskAutonomyOverrides: Record<string, Partial<Record<QuestionType, AutonomyRule>>> | null;
}
```

### 3.3 HITL Event Types (EventBus 확장)

```typescript
// ─── 기존 MarsEvent 유니온에 추가할 HITL 이벤트들 ───

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
      durationMs: number;          // 생성~응답 소요 시간
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

  // Level 2 알림 (비차단)
  | {
      type: 'hitl:informed';
      interactionId: string;
      runId: string;
      taskId: string | null;
      questionType: QuestionType;
      autoDecision: AutoDecision;
    }

  // Level 2 사후 override
  | {
      type: 'hitl:overridden';
      interactionId: string;
      runId: string;
      taskId: string | null;
      originalDecision: AutoDecision;
      override: InteractionResponse;
    }

  // 상호작용 취소 (Run 취소 시)
  | {
      type: 'hitl:cancelled';
      interactionId: string;
      runId: string;
      reason: string;
    }

  // 크래시 복구로 재발행
  | {
      type: 'hitl:recovered';
      interactionId: string;
      runId: string;
      originalCreatedAt: number;
    };
```

---

## 4. DB Schema Additions

기존 SQLite 데이터베이스에 `interactions` 테이블을 추가한다.

```sql
-- ─── interactions: 모든 인간-에이전트 상호작용 기록 ───

CREATE TABLE IF NOT EXISTS interactions (
  id              TEXT PRIMARY KEY,                              -- UUID v4
  run_id          TEXT NOT NULL,                                 -- 소속 Run
  task_id         TEXT,                                          -- 관련 Task (nullable)
  agent_id        TEXT,                                          -- 관련 Agent (nullable)
  session_id      TEXT,                                          -- 관련 Session (nullable)

  type            TEXT NOT NULL,                                 -- QuestionType enum value
  level           INTEGER NOT NULL CHECK (level IN (1, 2, 3)),   -- AutonomyLevel
  status          TEXT NOT NULL DEFAULT 'pending',               -- InteractionStatus enum value

  -- 질문 내용 (JSON)
  question_title       TEXT NOT NULL,
  question_description TEXT NOT NULL,
  question_payload     TEXT NOT NULL DEFAULT '{}',               -- JSON
  suggested_action     TEXT,                                     -- ResponseAction
  suggested_message    TEXT,
  options              TEXT,                                     -- JSON array or null

  -- 자동 결정 (Level 1/2)
  auto_decision_action  TEXT,
  auto_decision_reason  TEXT,
  auto_decision_at      INTEGER,                                -- epoch ms

  -- 인간 응답
  response_action        TEXT,
  response_message       TEXT,
  response_modified_payload TEXT,                                -- JSON or null
  response_by            TEXT,                                   -- 'human' | 'timeout' | 'system'

  -- 타임아웃 설정
  timeout_ms       INTEGER,                                     -- null = 무제한
  fallback_action  TEXT NOT NULL DEFAULT 'fail',
  expires_at       INTEGER,                                     -- epoch ms

  -- 메타데이터
  source           TEXT NOT NULL DEFAULT 'orchestrator',        -- 'orchestrator' | 'agent' | 'reviewer'
  batch_index      INTEGER,
  attempt          INTEGER,
  priority         TEXT NOT NULL DEFAULT 'normal',
  tags             TEXT NOT NULL DEFAULT '[]',                   -- JSON array

  -- 타임스탬프
  created_at       INTEGER NOT NULL,                            -- epoch ms
  responded_at     INTEGER,                                     -- epoch ms

  -- 외래 키 (논리적 — SQLite에서 런타임에 PRAGMA foreign_keys=ON 필요)
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

-- ─── 인덱스 ───

-- Run별 상호작용 조회 (가장 빈번)
CREATE INDEX IF NOT EXISTS idx_interactions_run_id ON interactions(run_id);

-- 상태별 조회 (대기 중인 것만 빠르게)
CREATE INDEX IF NOT EXISTS idx_interactions_status ON interactions(status);

-- Run + 상태 복합 인덱스 (Run의 pending 상호작용 조회)
CREATE INDEX IF NOT EXISTS idx_interactions_run_status ON interactions(run_id, status);

-- 타임아웃 관리: 만료 시각이 있는 pending 항목 빠르게 조회
CREATE INDEX IF NOT EXISTS idx_interactions_expires ON interactions(expires_at)
  WHERE status = 'pending' AND expires_at IS NOT NULL;

-- Task별 상호작용 이력
CREATE INDEX IF NOT EXISTS idx_interactions_task_id ON interactions(task_id)
  WHERE task_id IS NOT NULL;

-- 유형별 조회
CREATE INDEX IF NOT EXISTS idx_interactions_type ON interactions(type);
```

---

## 5. Module Specifications

### 5.1 InteractionGate (`src/hitl/interaction-gate.ts`) — THE CORE

InteractionGate는 HITL 시스템의 핵심이다.
**단일 진입점**: 모든 인간 개입이 필요한 코드 경로에서 `gate.request()`를 호출한다.
호출자는 autonomy level을 알 필요가 없다 — Gate가 config를 조회해 적절한 level로 처리한다.

```typescript
import { EventBus } from '../events/bus';
import { InteractionStore } from './interaction-store';
import type {
  Interaction,
  InteractionRequest,
  InteractionResponse,
  Deferred,
  ResolvedAutonomy,
  AutonomyConfig,
  AutonomyLevel,
  AutoDecision,
  InteractionStatus,
  PendingInteractionSnapshot,
} from './types';

export class InteractionGate {
  // ─── 내부 상태 ───
  private pending: Map<string, Deferred<InteractionResponse>>;
  private timeouts: Map<string, Timer>;
  private config: AutonomyConfig;

  // ─── 의존성 ───
  private store: InteractionStore;
  private eventBus: EventBus;

  constructor(deps: {
    store: InteractionStore;
    eventBus: EventBus;
    config: AutonomyConfig;
  }) {
    this.pending = new Map();
    this.timeouts = new Map();
    this.store = deps.store;
    this.eventBus = deps.eventBus;
    this.config = deps.config;
  }

  // ─── 핵심 메서드: request() ───
  // 호출자는 이것만 await 하면 된다.
  // Level 1/2: 즉시 resolve, Level 3: 인간 응답까지 블로킹

  async request(req: InteractionRequest): Promise<InteractionResponse> {
    // 1. Autonomy level 결정
    const resolved = this.resolveAutonomy(req.type, req.runId, req.taskId ?? null);

    // 2. Interaction 레코드 생성
    const interaction = this.createInteraction(req, resolved);

    // 3. Level에 따른 분기
    switch (resolved.level) {
      case 1:
        return this.handleAutonomous(interaction);
      case 2:
        return this.handleInform(interaction);
      case 3:
        return this.handleApproval(interaction);
    }
  }

  // ─── Level 1: Autonomous ───
  // 즉시 결정, 로그만 기록

  private async handleAutonomous(interaction: Interaction): Promise<InteractionResponse> {
    const autoDecision: AutoDecision = {
      action: interaction.question.suggestedAction ?? 'approve',
      reason: 'Autonomy Level 1: automatic decision without notification',
      decidedAt: Date.now(),
    };

    interaction.status = 'auto_resolved';
    interaction.autoDecision = autoDecision;
    interaction.respondedAt = Date.now();

    await this.store.save(interaction);
    // pending 파일은 생성하지 않음 (즉시 완료)

    const response: InteractionResponse = {
      action: autoDecision.action,
      message: autoDecision.reason,
      modifiedPayload: null,
      respondedBy: 'system',
    };

    interaction.response = response;
    await this.store.update(interaction);

    return response;
  }

  // ─── Level 2: Inform ───
  // 즉시 결정 + 사용자에게 알림 (비차단)
  // 사용자가 나중에 override 가능

  private async handleInform(interaction: Interaction): Promise<InteractionResponse> {
    const autoDecision: AutoDecision = {
      action: interaction.question.suggestedAction ?? 'approve',
      reason: 'Autonomy Level 2: automatic decision with notification',
      decidedAt: Date.now(),
    };

    interaction.status = 'notified';
    interaction.autoDecision = autoDecision;
    interaction.respondedAt = Date.now();

    const response: InteractionResponse = {
      action: autoDecision.action,
      message: autoDecision.reason,
      modifiedPayload: null,
      respondedBy: 'system',
    };

    interaction.response = response;
    await this.store.save(interaction);

    // SSE로 알림 발행 (비차단)
    this.eventBus.emit({
      type: 'hitl:informed',
      interactionId: interaction.id,
      runId: interaction.runId,
      taskId: interaction.taskId,
      questionType: interaction.type,
      autoDecision,
    });

    return response;
  }

  // ─── Level 3: Approval ───
  // Deferred Promise 생성, 인간 응답까지 블로킹

  private async handleApproval(interaction: Interaction): Promise<InteractionResponse> {
    // Deferred 생성
    const deferred = this.createDeferred<InteractionResponse>();
    this.pending.set(interaction.id, deferred);

    // 영속화 (SQLite + pending 파일)
    interaction.status = 'pending';
    await this.store.save(interaction);
    await this.store.savePendingSnapshot({
      interaction,
      createdAt: Date.now(),
      schemaVersion: 1,
    });

    // 타임아웃 설정
    if (interaction.timeoutMs !== null) {
      const timer = setTimeout(() => {
        this.handleTimeout(interaction.id);
      }, interaction.timeoutMs);
      this.timeouts.set(interaction.id, timer);
    }

    // SSE로 프론트엔드에 알림
    this.eventBus.emit({
      type: 'hitl:created',
      interactionId: interaction.id,
      runId: interaction.runId,
      taskId: interaction.taskId,
      questionType: interaction.type,
      level: interaction.level,
      question: interaction.question,
      timeoutMs: interaction.timeoutMs,
      expiresAt: interaction.expiresAt,
      priority: interaction.metadata.priority,
    });

    // 인간 응답까지 블로킹
    return deferred.promise;
  }

  // ─── 응답 수신: respond() ───
  // REST API에서 호출됨

  async respond(interactionId: string, response: InteractionResponse): Promise<void> {
    const deferred = this.pending.get(interactionId);
    if (!deferred) {
      // 이미 응답됨 또는 타임아웃됨 — race condition 방어
      throw new Error(`No pending interaction found: ${interactionId}`);
    }

    // 타임아웃 타이머 정리
    this.clearTimeout(interactionId);

    // Deferred resolve → 호출자의 await 풀림
    deferred.resolve(response);
    this.pending.delete(interactionId);

    // DB 업데이트
    const interaction = await this.store.getById(interactionId);
    if (interaction) {
      interaction.status = 'responded';
      interaction.response = response;
      interaction.respondedAt = Date.now();
      await this.store.update(interaction);
    }

    // pending 파일 삭제
    await this.store.deletePendingSnapshot(interactionId);

    // 이벤트 발행
    this.eventBus.emit({
      type: 'hitl:responded',
      interactionId,
      runId: interaction?.runId ?? '',
      taskId: interaction?.taskId ?? null,
      response,
      durationMs: interaction ? Date.now() - interaction.createdAt : 0,
    });
  }

  // ─── Level 2 사후 Override ───
  // 이미 자동 처리된 상호작용을 사용자가 나중에 변경

  async override(interactionId: string, response: InteractionResponse): Promise<void> {
    const interaction = await this.store.getById(interactionId);
    if (!interaction || interaction.level !== 2) {
      throw new Error(`Cannot override: interaction ${interactionId} is not Level 2`);
    }
    if (interaction.status !== 'notified') {
      throw new Error(`Cannot override: interaction ${interactionId} is in status ${interaction.status}`);
    }

    const originalDecision = interaction.autoDecision!;

    interaction.status = 'overridden';
    interaction.response = response;
    interaction.respondedAt = Date.now();
    await this.store.update(interaction);

    // 이벤트 발행 — Orchestrator가 이 이벤트를 수신해 태스크 재실행 결정
    this.eventBus.emit({
      type: 'hitl:overridden',
      interactionId,
      runId: interaction.runId,
      taskId: interaction.taskId,
      originalDecision,
      override: response,
    });
  }

  // ─── Run 취소 시 모든 pending 상호작용 취소 ───

  async cancelAllForRun(runId: string, reason: string): Promise<void> {
    for (const [id, deferred] of this.pending.entries()) {
      const interaction = await this.store.getById(id);
      if (interaction && interaction.runId === runId) {
        this.clearTimeout(id);
        deferred.reject(new Error(`Run cancelled: ${reason}`));
        this.pending.delete(id);

        interaction.status = 'cancelled';
        interaction.respondedAt = Date.now();
        await this.store.update(interaction);
        await this.store.deletePendingSnapshot(id);

        this.eventBus.emit({
          type: 'hitl:cancelled',
          interactionId: id,
          runId,
          reason,
        });
      }
    }
  }

  // ─── 타임아웃 처리 ───

  private async handleTimeout(interactionId: string): Promise<void> {
    // Race condition 방어: 이미 응답됐으면 무시
    if (!this.pending.has(interactionId)) {
      return;
    }

    const interaction = await this.store.getById(interactionId);
    if (!interaction) return;

    const fallbackResponse: InteractionResponse = {
      action: this.mapFallbackToAction(interaction.fallbackAction),
      message: `Timeout after ${interaction.timeoutMs}ms — fallback: ${interaction.fallbackAction}`,
      modifiedPayload: null,
      respondedBy: 'timeout',
    };

    const deferred = this.pending.get(interactionId);
    if (deferred) {
      deferred.resolve(fallbackResponse);
      this.pending.delete(interactionId);
    }

    interaction.status = 'timeout';
    interaction.response = fallbackResponse;
    interaction.respondedAt = Date.now();
    await this.store.update(interaction);
    await this.store.deletePendingSnapshot(interactionId);

    this.eventBus.emit({
      type: 'hitl:timeout',
      interactionId,
      runId: interaction.runId,
      taskId: interaction.taskId,
      fallbackAction: interaction.fallbackAction,
      timeoutMs: interaction.timeoutMs!,
    });
  }

  // ─── 유틸리티 ───

  private resolveAutonomy(
    type: QuestionType,
    runId: string,
    taskId: string | null
  ): ResolvedAutonomy {
    // 우선순위: byTask > byRun > byQuestionType > global
    if (taskId && this.config.byTask?.[taskId]?.[type]) {
      const rule = this.config.byTask[taskId][type]!;
      return { ...rule, resolvedFrom: 'byTask' };
    }
    if (this.config.byRun?.[type]) {
      const rule = this.config.byRun[type];
      return { ...rule, resolvedFrom: 'byRun' };
    }
    if (this.config.byQuestionType[type]) {
      const rule = this.config.byQuestionType[type];
      return { ...rule, resolvedFrom: 'byQuestionType' };
    }
    return {
      level: this.config.global,
      timeoutMs: null,
      fallbackAction: 'fail',
      resolvedFrom: 'global',
    };
  }

  private createInteraction(req: InteractionRequest, resolved: ResolvedAutonomy): Interaction {
    const now = Date.now();
    return {
      id: crypto.randomUUID(),
      runId: req.runId,
      taskId: req.taskId ?? null,
      agentId: req.agentId ?? null,
      sessionId: req.sessionId ?? null,
      type: req.type,
      level: resolved.level,
      status: 'pending',
      question: req.question,
      autoDecision: null,
      response: null,
      timeoutMs: resolved.timeoutMs,
      fallbackAction: resolved.fallbackAction,
      expiresAt: resolved.timeoutMs ? now + resolved.timeoutMs : null,
      metadata: {
        source: req.metadata?.source ?? 'orchestrator',
        batchIndex: req.metadata?.batchIndex ?? null,
        attempt: req.metadata?.attempt ?? null,
        priority: req.metadata?.priority ?? 'normal',
        tags: req.metadata?.tags ?? [],
      },
      createdAt: now,
      respondedAt: null,
    };
  }

  private createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject, createdAt: Date.now() };
  }

  private clearTimeout(interactionId: string): void {
    const timer = this.timeouts.get(interactionId);
    if (timer) {
      clearTimeout(timer);
      this.timeouts.delete(interactionId);
    }
  }

  private mapFallbackToAction(fallback: FallbackAction): ResponseAction {
    switch (fallback) {
      case 'fail': return 'reject';
      case 'auto_approve': return 'approve';
      case 'auto_answer': return 'answer';
      case 'skip': return 'skip';
    }
  }

  // ─── 복구용: 외부에서 Deferred 재등록 ───
  // Recovery Manager가 크래시 후 재시작 시 호출

  restorePending(interactionId: string): Promise<InteractionResponse> {
    const deferred = this.createDeferred<InteractionResponse>();
    this.pending.set(interactionId, deferred);
    return deferred.promise;
  }

  // ─── 상태 조회 ───

  getPendingCount(): number {
    return this.pending.size;
  }

  getPendingIds(): string[] {
    return Array.from(this.pending.keys());
  }

  hasPending(interactionId: string): boolean {
    return this.pending.has(interactionId);
  }

  // ─── Config 업데이트 (런타임 변경 가능) ───

  updateConfig(config: Partial<AutonomyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ─── 정리 ───

  dispose(): void {
    for (const timer of this.timeouts.values()) {
      clearTimeout(timer);
    }
    this.timeouts.clear();
    for (const deferred of this.pending.values()) {
      deferred.reject(new Error('InteractionGate disposed'));
    }
    this.pending.clear();
  }
}
```

### 5.2 InteractionStore (`src/hitl/interaction-store.ts`)

SQLite와 파일 시스템 양쪽에 상호작용을 영속화한다.
SQLite는 쿼리/이력용, 파일은 크래시 복구 전용이다.

```typescript
import { Database } from 'bun:sqlite';
import { mkdir, writeFile, readFile, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Interaction, PendingInteractionSnapshot } from './types';

export class InteractionStore {
  private db: Database;
  private pendingDir: string;

  constructor(deps: { db: Database; dataDir: string }) {
    this.db = deps.db;
    this.pendingDir = join(deps.dataDir, 'interactions', 'pending');
  }

  // ─── 초기화 ───

  async initialize(): Promise<void> {
    // pending 디렉토리 생성
    await mkdir(this.pendingDir, { recursive: true });

    // 테이블 생성 (schema는 §4 참조)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT,
        agent_id TEXT,
        session_id TEXT,
        type TEXT NOT NULL,
        level INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
        status TEXT NOT NULL DEFAULT 'pending',
        question_title TEXT NOT NULL,
        question_description TEXT NOT NULL,
        question_payload TEXT NOT NULL DEFAULT '{}',
        suggested_action TEXT,
        suggested_message TEXT,
        options TEXT,
        auto_decision_action TEXT,
        auto_decision_reason TEXT,
        auto_decision_at INTEGER,
        response_action TEXT,
        response_message TEXT,
        response_modified_payload TEXT,
        response_by TEXT,
        timeout_ms INTEGER,
        fallback_action TEXT NOT NULL DEFAULT 'fail',
        expires_at INTEGER,
        source TEXT NOT NULL DEFAULT 'orchestrator',
        batch_index INTEGER,
        attempt INTEGER,
        priority TEXT NOT NULL DEFAULT 'normal',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        responded_at INTEGER
      )
    `);

    // 인덱스 생성
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_interactions_run_id ON interactions(run_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_interactions_status ON interactions(status)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_interactions_run_status ON interactions(run_id, status)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_interactions_expires ON interactions(expires_at) WHERE status = 'pending' AND expires_at IS NOT NULL`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_interactions_task_id ON interactions(task_id) WHERE task_id IS NOT NULL`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_interactions_type ON interactions(type)`);
  }

  // ─── CRUD ───

  async save(interaction: Interaction): Promise<void> {
    this.db.run(
      `INSERT INTO interactions (
        id, run_id, task_id, agent_id, session_id,
        type, level, status,
        question_title, question_description, question_payload,
        suggested_action, suggested_message, options,
        auto_decision_action, auto_decision_reason, auto_decision_at,
        response_action, response_message, response_modified_payload, response_by,
        timeout_ms, fallback_action, expires_at,
        source, batch_index, attempt, priority, tags,
        created_at, responded_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8,
        ?9, ?10, ?11,
        ?12, ?13, ?14,
        ?15, ?16, ?17,
        ?18, ?19, ?20, ?21,
        ?22, ?23, ?24,
        ?25, ?26, ?27, ?28, ?29,
        ?30, ?31
      )`,
      [
        interaction.id, interaction.runId, interaction.taskId, interaction.agentId, interaction.sessionId,
        interaction.type, interaction.level, interaction.status,
        interaction.question.title, interaction.question.description,
        JSON.stringify(interaction.question.payload),
        interaction.question.suggestedAction, interaction.question.suggestedMessage,
        interaction.question.options ? JSON.stringify(interaction.question.options) : null,
        interaction.autoDecision?.action ?? null, interaction.autoDecision?.reason ?? null,
        interaction.autoDecision?.decidedAt ?? null,
        interaction.response?.action ?? null, interaction.response?.message ?? null,
        interaction.response?.modifiedPayload ? JSON.stringify(interaction.response.modifiedPayload) : null,
        interaction.response?.respondedBy ?? null,
        interaction.timeoutMs, interaction.fallbackAction, interaction.expiresAt,
        interaction.metadata.source, interaction.metadata.batchIndex, interaction.metadata.attempt,
        interaction.metadata.priority, JSON.stringify(interaction.metadata.tags),
        interaction.createdAt, interaction.respondedAt,
      ]
    );
  }

  async update(interaction: Interaction): Promise<void> {
    this.db.run(
      `UPDATE interactions SET
        status = ?1,
        auto_decision_action = ?2, auto_decision_reason = ?3, auto_decision_at = ?4,
        response_action = ?5, response_message = ?6, response_modified_payload = ?7, response_by = ?8,
        responded_at = ?9
      WHERE id = ?10`,
      [
        interaction.status,
        interaction.autoDecision?.action ?? null, interaction.autoDecision?.reason ?? null,
        interaction.autoDecision?.decidedAt ?? null,
        interaction.response?.action ?? null, interaction.response?.message ?? null,
        interaction.response?.modifiedPayload ? JSON.stringify(interaction.response.modifiedPayload) : null,
        interaction.response?.respondedBy ?? null,
        interaction.respondedAt,
        interaction.id,
      ]
    );
  }

  async getById(id: string): Promise<Interaction | null> {
    const row = this.db.query(`SELECT * FROM interactions WHERE id = ?`).get(id) as any;
    return row ? this.rowToInteraction(row) : null;
  }

  async getByRunId(runId: string): Promise<Interaction[]> {
    const rows = this.db.query(`SELECT * FROM interactions WHERE run_id = ? ORDER BY created_at ASC`).all(runId) as any[];
    return rows.map(this.rowToInteraction);
  }

  async getPendingByRunId(runId: string): Promise<Interaction[]> {
    const rows = this.db.query(
      `SELECT * FROM interactions WHERE run_id = ? AND status = 'pending' ORDER BY created_at ASC`
    ).all(runId) as any[];
    return rows.map(this.rowToInteraction);
  }

  async getExpired(now: number): Promise<Interaction[]> {
    const rows = this.db.query(
      `SELECT * FROM interactions WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`
    ).all(now) as any[];
    return rows.map(this.rowToInteraction);
  }

  // ─── 파일 영속화 (크래시 복구용) ───

  async savePendingSnapshot(snapshot: PendingInteractionSnapshot): Promise<void> {
    const filePath = join(this.pendingDir, `${snapshot.interaction.id}.json`);
    await writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  }

  async deletePendingSnapshot(interactionId: string): Promise<void> {
    const filePath = join(this.pendingDir, `${interactionId}.json`);
    try {
      await unlink(filePath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
      // 파일이 이미 없으면 무시
    }
  }

  async loadAllPendingSnapshots(): Promise<PendingInteractionSnapshot[]> {
    const files = await readdir(this.pendingDir);
    const snapshots: PendingInteractionSnapshot[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await readFile(join(this.pendingDir, file), 'utf-8');
        const snapshot = JSON.parse(content) as PendingInteractionSnapshot;
        snapshots.push(snapshot);
      } catch (err) {
        console.error(`[HITL Recovery] Failed to parse ${file}:`, err);
      }
    }

    return snapshots;
  }

  // ─── Row → Interaction 변환 ───

  private rowToInteraction(row: any): Interaction {
    return {
      id: row.id,
      runId: row.run_id,
      taskId: row.task_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      type: row.type,
      level: row.level,
      status: row.status,
      question: {
        title: row.question_title,
        description: row.question_description,
        payload: JSON.parse(row.question_payload),
        suggestedAction: row.suggested_action,
        suggestedMessage: row.suggested_message,
        options: row.options ? JSON.parse(row.options) : null,
      },
      autoDecision: row.auto_decision_action
        ? {
            action: row.auto_decision_action,
            reason: row.auto_decision_reason,
            decidedAt: row.auto_decision_at,
          }
        : null,
      response: row.response_action
        ? {
            action: row.response_action,
            message: row.response_message,
            modifiedPayload: row.response_modified_payload
              ? JSON.parse(row.response_modified_payload)
              : null,
            respondedBy: row.response_by,
          }
        : null,
      timeoutMs: row.timeout_ms,
      fallbackAction: row.fallback_action,
      expiresAt: row.expires_at,
      metadata: {
        source: row.source,
        batchIndex: row.batch_index,
        attempt: row.attempt,
        priority: row.priority,
        tags: JSON.parse(row.tags),
      },
      createdAt: row.created_at,
      respondedAt: row.responded_at,
    };
  }
}
```

### 5.3 InteractionAPI (`src/hitl/interaction-api.ts`)

REST API 핸들러. Bun의 라우팅 시스템에 등록된다.

```typescript
import type { InteractionGate } from './interaction-gate';
import type { InteractionStore } from './interaction-store';
import type { InteractionResponse, ResponseAction } from './types';

export class InteractionAPI {
  private gate: InteractionGate;
  private store: InteractionStore;

  constructor(deps: { gate: InteractionGate; store: InteractionStore }) {
    this.gate = deps.gate;
    this.store = deps.store;
  }

  // POST /api/interactions/:id/respond
  async handleRespond(interactionId: string, body: RespondRequestBody): Promise<Response> {
    try {
      this.validateRespondBody(body);

      const response: InteractionResponse = {
        action: body.action,
        message: body.message ?? null,
        modifiedPayload: body.modifiedPayload ?? null,
        respondedBy: 'human',
      };

      await this.gate.respond(interactionId, response);

      return Response.json({ success: true, interactionId });
    } catch (err: any) {
      if (err.message.includes('No pending interaction')) {
        return Response.json({ error: 'Interaction not found or already resolved' }, { status: 404 });
      }
      return Response.json({ error: err.message }, { status: 400 });
    }
  }

  // POST /api/interactions/:id/override
  async handleOverride(interactionId: string, body: RespondRequestBody): Promise<Response> {
    try {
      this.validateRespondBody(body);

      const response: InteractionResponse = {
        action: body.action,
        message: body.message ?? null,
        modifiedPayload: body.modifiedPayload ?? null,
        respondedBy: 'human',
      };

      await this.gate.override(interactionId, response);

      return Response.json({ success: true, interactionId, overridden: true });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 400 });
    }
  }

  // GET /api/interactions?runId=xxx&status=pending
  async handleList(query: InteractionListQuery): Promise<Response> {
    let interactions;

    if (query.runId && query.status === 'pending') {
      interactions = await this.store.getPendingByRunId(query.runId);
    } else if (query.runId) {
      interactions = await this.store.getByRunId(query.runId);
    } else {
      return Response.json({ error: 'runId is required' }, { status: 400 });
    }

    return Response.json({ interactions, total: interactions.length });
  }

  // GET /api/interactions/:id
  async handleGet(interactionId: string): Promise<Response> {
    const interaction = await this.store.getById(interactionId);
    if (!interaction) {
      return Response.json({ error: 'Interaction not found' }, { status: 404 });
    }
    return Response.json(interaction);
  }

  // ─── Validation ───

  private validateRespondBody(body: RespondRequestBody): void {
    const validActions: ResponseAction[] = ['approve', 'reject', 'modify', 'answer', 'skip', 'cancel'];
    if (!body.action || !validActions.includes(body.action)) {
      throw new Error(`Invalid action: ${body.action}. Must be one of: ${validActions.join(', ')}`);
    }
    if (body.action === 'modify' && !body.modifiedPayload) {
      throw new Error('modifiedPayload is required when action is "modify"');
    }
  }
}

// ─── Request/Query Types ───

interface RespondRequestBody {
  action: ResponseAction;
  message?: string;
  modifiedPayload?: Record<string, unknown>;
}

interface InteractionListQuery {
  runId?: string;
  status?: string;
}
```

### 5.4 InteractionSSE (`src/hitl/interaction-sse.ts`)

Server-Sent Events 스트림 관리. EventBus의 HITL 이벤트를 연결된 클라이언트에 실시간 전달한다.

```typescript
import type { EventBus } from '../events/bus';
import type { HitlEvent } from './types';

export class InteractionSSE {
  private clients: Map<string, ReadableStreamDefaultController>;
  private eventBus: EventBus;

  constructor(deps: { eventBus: EventBus }) {
    this.clients = new Map();
    this.eventBus = deps.eventBus;
    this.setupEventListeners();
  }

  // GET /api/interactions/stream — SSE 연결

  createStream(clientId: string): Response {
    const stream = new ReadableStream({
      start: (controller) => {
        this.clients.set(clientId, controller);

        // 연결 확인 이벤트
        this.sendEvent(controller, {
          event: 'connected',
          data: { clientId, timestamp: Date.now() },
        });
      },
      cancel: () => {
        this.clients.delete(clientId);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  // ─── EventBus 이벤트 → SSE 브로드캐스트 ───

  private setupEventListeners(): void {
    const hitlEventTypes = [
      'hitl:created',
      'hitl:responded',
      'hitl:timeout',
      'hitl:informed',
      'hitl:overridden',
      'hitl:cancelled',
      'hitl:recovered',
    ] as const;

    for (const eventType of hitlEventTypes) {
      this.eventBus.on(eventType, (event: HitlEvent) => {
        this.broadcast({
          event: eventType,
          data: event,
        });
      });
    }
  }

  // ─── 모든 클라이언트에 브로드캐스트 ───

  private broadcast(message: SSEMessage): void {
    const encoded = this.encodeSSE(message);
    for (const [clientId, controller] of this.clients.entries()) {
      try {
        controller.enqueue(encoded);
      } catch {
        // 연결 끊어진 클라이언트 정리
        this.clients.delete(clientId);
      }
    }
  }

  // ─── SSE 프로토콜 인코딩 ───

  private encodeSSE(message: SSEMessage): Uint8Array {
    const lines: string[] = [];
    lines.push(`event: ${message.event}`);
    lines.push(`data: ${JSON.stringify(message.data)}`);
    lines.push('');  // 빈 줄로 메시지 종료
    lines.push('');
    return new TextEncoder().encode(lines.join('\n'));
  }

  private sendEvent(controller: ReadableStreamDefaultController, message: SSEMessage): void {
    const encoded = this.encodeSSE(message);
    controller.enqueue(encoded);
  }

  // ─── 정리 ───

  getClientCount(): number {
    return this.clients.size;
  }

  dispose(): void {
    for (const controller of this.clients.values()) {
      try {
        controller.close();
      } catch {
        // 무시
      }
    }
    this.clients.clear();
  }
}

// ─── SSE 메시지 포맷 ───

interface SSEMessage {
  event: string;
  data: Record<string, unknown>;
}
```

**SSE 이벤트 포맷 (프론트엔드 수신 예시):**

```
event: hitl:created
data: {"type":"hitl:created","interactionId":"550e8400-e29b-41d4-a716-446655440000","runId":"run-123","taskId":"task-456","questionType":"decomposition_approval","level":3,"question":{"title":"서브태스크 분해 결과 확인","description":"다음 서브태스크 분해 결과를 승인해주세요.","payload":{"subtasks":[...]},"suggestedAction":"approve","suggestedMessage":null,"options":[{"value":"approve","label":"승인","description":"이 분해 결과로 진행","isDefault":true},{"value":"reject","label":"반려","description":"다시 분해 요청","isDefault":false},{"value":"modify","label":"수정","description":"일부 수정 후 진행","isDefault":false}]},"timeoutMs":600000,"expiresAt":1709500200000,"priority":"high"}

event: hitl:responded
data: {"type":"hitl:responded","interactionId":"550e8400-e29b-41d4-a716-446655440000","runId":"run-123","taskId":"task-456","response":{"action":"approve","message":"LGTM","modifiedPayload":null,"respondedBy":"human"},"durationMs":45230}

event: hitl:timeout
data: {"type":"hitl:timeout","interactionId":"550e8400-e29b-41d4-a716-446655440000","runId":"run-123","taskId":null,"fallbackAction":"fail","timeoutMs":600000}
```

### 5.5 MCP Tool Handler (`src/hitl/mcp-tool-handler.ts`)

에이전트가 실행 중 인간에게 질문할 수 있는 MCP tool `mars_request_input`을 제공한다.
에이전트 입장에서는 단순히 느린 tool call — 응답이 올 때까지 대기할 뿐이다.

```typescript
import type { InteractionGate } from './interaction-gate';
import type { InteractionRequest, QuestionType, ResponseAction, InteractionOption } from './types';

export class McpToolHandler {
  private gate: InteractionGate;

  constructor(deps: { gate: InteractionGate }) {
    this.gate = deps.gate;
  }

  // ─── MCP Tool Definition ───

  getToolDefinition(): McpToolDefinition {
    return {
      name: 'mars_request_input',
      description:
        'Request input or approval from the human user. ' +
        'Use this when you need clarification, confirmation for a destructive action, ' +
        'or when you are stuck and need guidance. ' +
        'The tool call will block until the user responds.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          question_type: {
            type: 'string' as const,
            enum: [
              'clarification',
              'destructive_action',
              'ambiguity_resolution',
              'permission_request',
              'agent_stuck',
            ],
            description: 'The type of question being asked',
          },
          title: {
            type: 'string' as const,
            description: 'Short title summarizing the question (shown as header)',
          },
          description: {
            type: 'string' as const,
            description: 'Detailed description of what you need from the user (supports markdown)',
          },
          suggested_answer: {
            type: 'string' as const,
            description: 'Your suggested answer or proposed action (optional)',
          },
          options: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                value: { type: 'string' as const, description: 'Option identifier' },
                label: { type: 'string' as const, description: 'Display text' },
                description: { type: 'string' as const, description: 'Option description' },
              },
              required: ['value', 'label'],
            },
            description: 'List of options for the user to choose from (optional)',
          },
          context: {
            type: 'object' as const,
            additionalProperties: true,
            description: 'Additional context data relevant to the question (optional)',
          },
        },
        required: ['question_type', 'title', 'description'],
        additionalProperties: false,
      },
    };
  }

  // ─── Tool 호출 핸들러 ───

  async handleToolCall(params: {
    input: McpToolInput;
    runId: string;
    taskId: string;
    agentId: string;
    sessionId: string;
  }): Promise<McpToolOutput> {
    const { input, runId, taskId, agentId, sessionId } = params;

    // 에이전트가 보낸 옵션을 InteractionOption으로 변환
    const options: InteractionOption[] | null = input.options
      ? input.options.map((opt, idx) => ({
          value: opt.value,
          label: opt.label,
          description: opt.description ?? null,
          isDefault: idx === 0,
        }))
      : null;

    // InteractionGate.request() 호출 — Level에 따라 즉시 또는 블로킹
    const request: InteractionRequest = {
      type: input.question_type as QuestionType,
      runId,
      taskId,
      agentId,
      sessionId,
      question: {
        title: input.title,
        description: input.description,
        payload: input.context ?? {},
        suggestedAction: 'answer',
        suggestedMessage: input.suggested_answer ?? null,
        options,
      },
      metadata: {
        source: 'agent',
        priority: input.question_type === 'destructive_action' ? 'critical' : 'high',
      },
    };

    const response = await this.gate.request(request);

    // 에이전트에게 돌려줄 tool result
    return {
      action: response.action,
      message: response.message ?? 'No message provided',
      data: response.modifiedPayload ?? {},
      responded_by: response.respondedBy,
    };
  }
}

// ─── MCP Tool 관련 타입 ───

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
}

interface McpToolInput {
  question_type: string;
  title: string;
  description: string;
  suggested_answer?: string;
  options?: Array<{
    value: string;
    label: string;
    description?: string;
  }>;
  context?: Record<string, unknown>;
}

interface McpToolOutput {
  action: string;
  message: string;
  data: Record<string, unknown>;
  responded_by: string;
}
```

### 5.6 Recovery Manager (`src/hitl/recovery.ts`)

앱 크래시 또는 재시작 후 미결 상호작용을 복원한다.
`pending/*.json` 파일을 읽어 InteractionGate에 Deferred를 재등록하고, SSE로 재발행한다.

```typescript
import type { InteractionGate } from './interaction-gate';
import type { InteractionStore } from './interaction-store';
import type { EventBus } from '../events/bus';
import type { PendingInteractionSnapshot } from './types';

export class RecoveryManager {
  private gate: InteractionGate;
  private store: InteractionStore;
  private eventBus: EventBus;

  constructor(deps: {
    gate: InteractionGate;
    store: InteractionStore;
    eventBus: EventBus;
  }) {
    this.gate = deps.gate;
    this.store = deps.store;
    this.eventBus = deps.eventBus;
  }

  // ─── 앱 시작 시 호출 ───

  async recover(): Promise<RecoveryResult> {
    const snapshots = await this.store.loadAllPendingSnapshots();

    if (snapshots.length === 0) {
      return { recovered: 0, expired: 0, failed: 0, details: [] };
    }

    console.log(`[HITL Recovery] Found ${snapshots.length} pending interaction(s) to recover`);

    const result: RecoveryResult = {
      recovered: 0,
      expired: 0,
      failed: 0,
      details: [],
    };

    const now = Date.now();

    for (const snapshot of snapshots) {
      try {
        const interaction = snapshot.interaction;

        // 만료 확인
        if (interaction.expiresAt && interaction.expiresAt <= now) {
          // 이미 타임아웃 — fallback 처리
          interaction.status = 'timeout';
          interaction.response = {
            action: this.mapFallbackToAction(interaction.fallbackAction),
            message: 'Expired during app downtime',
            modifiedPayload: null,
            respondedBy: 'timeout',
          };
          interaction.respondedAt = now;
          await this.store.update(interaction);
          await this.store.deletePendingSnapshot(interaction.id);

          result.expired++;
          result.details.push({
            interactionId: interaction.id,
            status: 'expired',
            originalCreatedAt: interaction.createdAt,
          });
          continue;
        }

        // 타임아웃이 남아있으면 남은 시간으로 재등록
        // Gate에 Deferred 재등록 (응답 대기 재개)
        // 주의: 이 Promise는 누가 await 하지 않으므로 (원래 호출자의 컨텍스트가 소실됨)
        // Orchestrator가 재시작 시 Run 복구 로직에서 이 Promise를 다시 await 해야 한다
        this.gate.restorePending(interaction.id);

        // SSE로 프론트엔드에 재발행
        this.eventBus.emit({
          type: 'hitl:recovered',
          interactionId: interaction.id,
          runId: interaction.runId,
          originalCreatedAt: interaction.createdAt,
        });

        // 재발행 — 프론트엔드가 다시 표시할 수 있도록
        this.eventBus.emit({
          type: 'hitl:created',
          interactionId: interaction.id,
          runId: interaction.runId,
          taskId: interaction.taskId,
          questionType: interaction.type,
          level: interaction.level,
          question: interaction.question,
          timeoutMs: interaction.expiresAt ? interaction.expiresAt - now : null,
          expiresAt: interaction.expiresAt,
          priority: interaction.metadata.priority,
        });

        result.recovered++;
        result.details.push({
          interactionId: interaction.id,
          status: 'recovered',
          originalCreatedAt: interaction.createdAt,
        });
      } catch (err) {
        console.error(`[HITL Recovery] Failed to recover ${snapshot.interaction.id}:`, err);
        result.failed++;
        result.details.push({
          interactionId: snapshot.interaction.id,
          status: 'failed',
          originalCreatedAt: snapshot.interaction.createdAt,
        });
      }
    }

    console.log(
      `[HITL Recovery] Complete: ${result.recovered} recovered, ${result.expired} expired, ${result.failed} failed`
    );

    return result;
  }

  private mapFallbackToAction(fallback: string): 'reject' | 'approve' | 'answer' | 'skip' {
    switch (fallback) {
      case 'fail': return 'reject';
      case 'auto_approve': return 'approve';
      case 'auto_answer': return 'answer';
      case 'skip': return 'skip';
      default: return 'reject';
    }
  }
}

// ─── Recovery 결과 ───

interface RecoveryResult {
  recovered: number;
  expired: number;
  failed: number;
  details: Array<{
    interactionId: string;
    status: 'recovered' | 'expired' | 'failed';
    originalCreatedAt: number;
  }>;
}
```

### 5.7 Default Config (`src/hitl/default-config.ts`)

기본 autonomy 설정. SPEC.md §8의 "never auto-execute" 원칙을 반영하여,
안전이 중요한 항목은 Level 3 (Approval), 반복적인 항목은 Level 2 (Inform)로 설정한다.

```typescript
import type { AutonomyConfig, AutonomyRule, QuestionType } from './types';

// ─── 질문 유형별 기본 규칙 ───

const DEFAULT_RULES: Record<QuestionType, AutonomyRule> = {
  // ── Orchestrator-level ──

  decomposition_approval: {
    level: 3,                    // Approval — 분해 결과는 반드시 인간 확인
    timeoutMs: 10 * 60 * 1000,  // 10분
    fallbackAction: 'fail',
  },

  assignment_approval: {
    level: 2,                    // Inform — 자동 배정 + 알림 (일반적으로 안전)
    timeoutMs: null,
    fallbackAction: 'auto_approve',
  },

  plan_approval: {
    level: 3,                    // Approval — 실행 계획은 반드시 인간 확인
    timeoutMs: 15 * 60 * 1000,  // 15분
    fallbackAction: 'fail',
  },

  conflict_resolution: {
    level: 3,                    // Approval — 충돌은 인간이 판단
    timeoutMs: 10 * 60 * 1000,  // 10분
    fallbackAction: 'fail',
  },

  // ── Agent-level ──

  clarification: {
    level: 2,                    // Inform — 에이전트가 자체 판단, 알림
    timeoutMs: null,
    fallbackAction: 'auto_answer',
  },

  destructive_action: {
    level: 3,                    // Approval — 파괴적 작업은 절대 자동 승인 금지
    timeoutMs: null,             // 무제한 대기 — 인간이 반드시 결정
    fallbackAction: 'fail',      // fallback도 fail (auto_approve 절대 불가)
  },

  ambiguity_resolution: {
    level: 2,                    // Inform — 에이전트가 최선의 해석으로 진행
    timeoutMs: null,
    fallbackAction: 'auto_answer',
  },

  permission_request: {
    level: 3,                    // Approval — 권한 요청은 인간 확인
    timeoutMs: 5 * 60 * 1000,   // 5분
    fallbackAction: 'fail',
  },

  agent_stuck: {
    level: 2,                    // Inform — 우선 알림, 에이전트는 우회 시도
    timeoutMs: null,
    fallbackAction: 'auto_answer',
  },

  // ── Review-level ──

  result_approval: {
    level: 2,                    // Inform — autoReview=true일 때 (RunConfig에서 override 가능)
    timeoutMs: null,
    fallbackAction: 'auto_approve',
  },

  quality_override: {
    level: 3,                    // Approval — 품질 기준 재정의는 인간만 가능
    timeoutMs: null,             // 무제한 대기
    fallbackAction: 'fail',
  },
};

// ─── 기본 Autonomy Config ───

export const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  global: 3,                    // 기본값: Approval (안전 우선)
  byQuestionType: DEFAULT_RULES,
  byRun: null,                  // Run 단위 오버라이드 없음
  byTask: null,                 // Task 단위 오버라이드 없음
};

// ─── autoReview가 true일 때의 오버라이드 헬퍼 ───

export function getAutoReviewOverrides(): Partial<Record<QuestionType, AutonomyRule>> {
  return {
    result_approval: {
      level: 2,
      timeoutMs: null,
      fallbackAction: 'auto_approve',
    },
  };
}

// ─── autoReview가 false일 때의 오버라이드 헬퍼 ───

export function getManualReviewOverrides(): Partial<Record<QuestionType, AutonomyRule>> {
  return {
    result_approval: {
      level: 3,
      timeoutMs: null,
      fallbackAction: 'fail',
    },
  };
}

// ─── 전체 Level 3 (최대 안전) 프리셋 ───

export function getStrictConfig(): AutonomyConfig {
  const strictRules = Object.fromEntries(
    Object.entries(DEFAULT_RULES).map(([key, rule]) => [
      key,
      { ...rule, level: 3 as const, fallbackAction: 'fail' as const },
    ])
  ) as Record<QuestionType, AutonomyRule>;

  return {
    global: 3,
    byQuestionType: strictRules,
    byRun: null,
    byTask: null,
  };
}

// ─── 전체 Level 1 (최대 자율) 프리셋 — 개발/테스트용 ───

export function getAutonomousConfig(): AutonomyConfig {
  const autoRules = Object.fromEntries(
    Object.entries(DEFAULT_RULES).map(([key, rule]) => {
      // destructive_action은 Level 1이어도 Level 3 유지 (안전 하드코딩)
      if (key === 'destructive_action') {
        return [key, rule];
      }
      return [key, { ...rule, level: 1 as const }];
    })
  ) as Record<QuestionType, AutonomyRule>;

  return {
    global: 1,
    byQuestionType: autoRules,
    byRun: null,
    byTask: null,
  };
}
```

---

## 6. API Routes

기존 API 라우팅에 추가할 HITL 전용 엔드포인트들:

| Method | Path | 설명 | 핸들러 |
|--------|------|------|--------|
| `GET` | `/api/interactions` | 상호작용 목록 조회 (runId 필수, status 선택) | `InteractionAPI.handleList` |
| `GET` | `/api/interactions/:id` | 개별 상호작용 상세 조회 | `InteractionAPI.handleGet` |
| `POST` | `/api/interactions/:id/respond` | 인간 응답 전송 (Level 3 resolve) | `InteractionAPI.handleRespond` |
| `POST` | `/api/interactions/:id/override` | Level 2 사후 override | `InteractionAPI.handleOverride` |
| `GET` | `/api/interactions/stream` | SSE 스트림 연결 | `InteractionSSE.createStream` |

**요청/응답 스키마:**

```typescript
// POST /api/interactions/:id/respond
// Request Body:
{
  "action": "approve" | "reject" | "modify" | "answer" | "skip" | "cancel",
  "message": "optional human message",
  "modifiedPayload": { /* optional, required when action=modify */ }
}

// Response (200):
{
  "success": true,
  "interactionId": "uuid"
}

// Response (404):
{
  "error": "Interaction not found or already resolved"
}

// GET /api/interactions?runId=xxx&status=pending
// Response (200):
{
  "interactions": [ /* Interaction[] */ ],
  "total": 3
}

// GET /api/interactions/stream
// Response: text/event-stream (§5.4 참조)
```

---

## 7. Integration Points

### 7.1 OrchestratorEngine.startRun() — decomposition approval

위치: `src/orchestrator/engine.ts` — `startRun()` 메서드 내부, 분해 완료 직후

```typescript
// engine.ts — startRun() 내부 (의사 코드)

async startRun(projectId: string, taskIds: string[], config: RunConfig): Promise<Run> {
  const run = await this.createRun(projectId, taskIds, config);

  // Phase 1: Decompose
  this.updateRunStatus(run.id, 'decomposing');
  const subtasks = await this.decomposer.decompose(run);

  // ★ HITL: 분해 결과 승인 요청
  const decompositionResponse = await this.interactionGate.request({
    type: 'decomposition_approval',
    runId: run.id,
    question: {
      title: '서브태스크 분해 결과 확인',
      description: `${subtasks.length}개의 서브태스크로 분해되었습니다. 확인 후 진행해주세요.`,
      payload: {
        originalTasks: taskIds,
        subtasks: subtasks.map(t => ({
          id: t.id,
          title: t.title,
          description: t.description,
          dependencies: t.dependencies,
          estimatedComplexity: t.complexity,
        })),
      },
      suggestedAction: 'approve',
      suggestedMessage: null,
      options: [
        { value: 'approve', label: '승인', description: '이 분해 결과로 진행', isDefault: true },
        { value: 'reject', label: '반려', description: '다시 분해 요청', isDefault: false },
        { value: 'modify', label: '수정', description: '일부 수정 후 진행', isDefault: false },
      ],
    },
    metadata: { source: 'orchestrator', priority: 'high' },
  });

  // 응답 처리
  if (decompositionResponse.action === 'reject') {
    this.updateRunStatus(run.id, 'failed');
    throw new Error('Decomposition rejected by user');
  }
  if (decompositionResponse.action === 'cancel') {
    this.updateRunStatus(run.id, 'cancelled');
    throw new Error('Run cancelled by user');
  }
  if (decompositionResponse.action === 'modify' && decompositionResponse.modifiedPayload) {
    // 수정된 서브태스크로 교체
    const modifiedSubtasks = decompositionResponse.modifiedPayload.subtasks;
    // ... 서브태스크 재구성
  }

  // Phase 2: Schedule
  this.updateRunStatus(run.id, 'scheduling');
  const plan = await this.scheduler.schedule(subtasks);

  // ★ HITL: 실행 계획 승인 요청
  const planResponse = await this.interactionGate.request({
    type: 'plan_approval',
    runId: run.id,
    question: {
      title: '실행 계획 확인',
      description: `${plan.batches.length}개 배치, 총 ${subtasks.length}개 태스크. 실행 순서를 확인해주세요.`,
      payload: { plan },
      suggestedAction: 'approve',
      suggestedMessage: null,
      options: [
        { value: 'approve', label: '실행 시작', description: '이 계획으로 실행', isDefault: true },
        { value: 'reject', label: '취소', description: '실행하지 않음', isDefault: false },
      ],
    },
    metadata: { source: 'orchestrator', priority: 'high' },
  });

  if (planResponse.action === 'reject' || planResponse.action === 'cancel') {
    this.updateRunStatus(run.id, 'cancelled');
    throw new Error('Execution plan rejected by user');
  }

  // Phase 3: Execute batches
  this.updateRunStatus(run.id, 'running');
  for (const batch of plan.batches) {
    await this.executeBatch(run, batch);
  }

  // Phase 4: Review
  this.updateRunStatus(run.id, 'reviewing');
  await this.reviewer.review(run);

  this.updateRunStatus(run.id, 'completed');
  return run;
}
```

### 7.2 AgentRouter.assignBatch() — assignment approval

위치: `src/orchestrator/router.ts` — 배치 내 태스크에 에이전트를 배정할 때

```typescript
// router.ts — assignBatch() 내부 (의사 코드)

async assignBatch(
  runId: string,
  batch: ExecutionBatch,
  interactionGate: InteractionGate
): Promise<TaskAssignment[]> {
  const assignments: TaskAssignment[] = [];

  for (const taskId of batch.taskIds) {
    const bestAgent = await this.findBestAgent(taskId);
    assignments.push({ taskId, agentId: bestAgent.id, score: bestAgent.score });
  }

  // ★ HITL: 배정 결과 알림/승인
  const response = await interactionGate.request({
    type: 'assignment_approval',
    runId,
    question: {
      title: `배치 #${batch.batchIndex} 에이전트 배정`,
      description: `${assignments.length}개 태스크에 에이전트가 배정되었습니다.`,
      payload: {
        batchIndex: batch.batchIndex,
        assignments: assignments.map(a => ({
          taskId: a.taskId,
          agentId: a.agentId,
          matchScore: a.score,
        })),
      },
      suggestedAction: 'approve',
      suggestedMessage: null,
      options: [
        { value: 'approve', label: '승인', description: '이 배정으로 진행', isDefault: true },
        { value: 'modify', label: '변경', description: '에이전트 배정 변경', isDefault: false },
      ],
    },
    metadata: {
      source: 'orchestrator',
      batchIndex: batch.batchIndex,
      priority: 'normal',
    },
  });

  if (response.action === 'modify' && response.modifiedPayload) {
    // 사용자가 수정한 배정으로 교체
    return response.modifiedPayload.assignments as TaskAssignment[];
  }

  return assignments;
}
```

### 7.3 AgentRunner — agent-level questions (via MCP tool)

위치: `src/execution/agent-runner.ts` — MCP tool 호출 처리 부분

에이전트는 `mars_request_input` 도구를 사용해 인간에게 질문한다.
AgentRunner는 이 tool call을 감지해 `McpToolHandler`에 위임한다.

```typescript
// agent-runner.ts — tool call 핸들링 (의사 코드)

async handleToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  context: { runId: string; taskId: string; agentId: string; sessionId: string }
): Promise<string> {
  // ★ HITL: mars_request_input 도구 감지
  if (toolName === 'mars_request_input') {
    const result = await this.mcpToolHandler.handleToolCall({
      input: toolInput as McpToolInput,
      runId: context.runId,
      taskId: context.taskId,
      agentId: context.agentId,
      sessionId: context.sessionId,
    });

    // 에이전트에게 tool result로 반환
    return JSON.stringify(result);
  }

  // 기존 MCP tool 처리
  return this.mcpManager.callTool(toolName, toolInput);
}
```

**에이전트의 시스템 프롬프트에 추가할 내용:**

```
## Available Tools

### mars_request_input
When you need human input, use this tool. Common scenarios:
- You need clarification on ambiguous requirements
- You're about to perform a destructive action (file deletion, database changes)
- You're stuck and need guidance
- You need permission to access an external service

The tool will block until the human responds. Plan your question clearly
to minimize back-and-forth.
```

### 7.4 ResultReviewer — result approval

위치: `src/orchestrator/reviewer.ts` — 태스크 실행 결과 검증 후

```typescript
// reviewer.ts — review() 내부 (의사 코드)

async reviewTaskResult(
  run: Run,
  taskExecution: TaskExecution,
  interactionGate: InteractionGate
): Promise<ReviewDecision> {
  // 자동 리뷰 실행 (LLM 기반 품질 검증)
  const autoReviewResult = await this.autoReview(taskExecution);

  // ★ HITL: 결과 승인 요청
  // RunConfig.autoReview에 따라 Level 2 (알림) 또는 Level 3 (승인)
  const response = await interactionGate.request({
    type: 'result_approval',
    runId: run.id,
    taskId: taskExecution.taskId,
    question: {
      title: `태스크 실행 결과 검토`,
      description: [
        `**태스크**: ${taskExecution.taskId}`,
        `**에이전트**: ${taskExecution.agentId}`,
        `**자동 리뷰 결과**: ${autoReviewResult.passed ? '✅ 통과' : '❌ 실패'}`,
        autoReviewResult.feedback ? `**피드백**: ${autoReviewResult.feedback}` : '',
      ].join('\n'),
      payload: {
        taskExecution: {
          id: taskExecution.id,
          taskId: taskExecution.taskId,
          agentId: taskExecution.agentId,
          status: taskExecution.status,
          output: taskExecution.output,
          durationMs: taskExecution.durationMs,
        },
        autoReview: autoReviewResult,
      },
      suggestedAction: autoReviewResult.passed ? 'approve' : 'reject',
      suggestedMessage: autoReviewResult.feedback,
      options: [
        { value: 'approve', label: '승인', description: '결과를 수락', isDefault: autoReviewResult.passed },
        { value: 'reject', label: '반려', description: '재실행 요청', isDefault: !autoReviewResult.passed },
        { value: 'modify', label: '피드백 추가', description: '피드백과 함께 재실행', isDefault: false },
      ],
    },
    metadata: { source: 'reviewer', priority: autoReviewResult.passed ? 'normal' : 'high' },
  });

  // 응답에 따른 결정
  switch (response.action) {
    case 'approve':
      return { decision: 'accepted', feedback: response.message };
    case 'reject':
      return { decision: 'rejected', feedback: response.message ?? 'Rejected by reviewer' };
    case 'modify':
      return {
        decision: 'retry_with_feedback',
        feedback: response.message ?? autoReviewResult.feedback,
      };
    default:
      return { decision: 'accepted', feedback: null };
  }
}
```

---

## 8. Implementation Order

HITL 시스템은 Orchestration Engine과 병렬로 개발하되, 의존성 순서를 따른다.

```
Phase 0: 사전 준비 (Orchestration Engine 의존성)
├── EventBus 구현 완료 필요 (src/events/bus.ts)
└── OrchestratorEngine 기본 골격 완료 필요

Phase 1: HITL Core (의존성 없음 — 독립 개발 가능)
├── 1-A: types.ts — 모든 타입 정의
├── 1-B: interaction-store.ts — SQLite 스키마 + CRUD + 파일 영속화
├── 1-C: default-config.ts — 기본 autonomy 설정
└── 1-D: interaction-gate.ts — 핵심 게이트 (Deferred, config resolution, timeout)
    └── 의존: 1-A, 1-B, 1-C, EventBus

Phase 2: API & SSE (Phase 1 완료 후)
├── 2-A: interaction-api.ts — REST 라우트 핸들러
│   └── 의존: 1-D (InteractionGate)
├── 2-B: interaction-sse.ts — SSE 스트림 관리
│   └── 의존: EventBus
└── 2-C: API 라우트 등록 (기존 라우터에 추가)
    └── 의존: 2-A, 2-B

Phase 3: MCP Tool (Phase 1 완료 후, Phase 2와 병렬 가능)
├── 3-A: mcp-tool-handler.ts — mars_request_input 핸들러
│   └── 의존: 1-D (InteractionGate)
└── 3-B: MCP Manager에 tool 등록
    └── 의존: 3-A

Phase 4: Recovery (Phase 1 완료 후)
├── 4-A: recovery.ts — 크래시 복구 매니저
│   └── 의존: 1-B (Store), 1-D (Gate), EventBus
└── 4-B: 앱 초기화 시퀀스에 recovery.recover() 연결

Phase 5: Orchestration Integration (Phase 1-4 + Engine 완료 후)
├── 5-A: engine.ts에 InteractionGate 주입 + decomposition_approval
├── 5-B: router.ts에 assignment_approval 연동
├── 5-C: agent-runner.ts에 MCP tool 핸들링 연동
├── 5-D: reviewer.ts에 result_approval 연동
└── 5-E: Run 취소 시 cancelAllForRun() 호출

Phase 6: Frontend (Phase 2 완료 후)
├── 6-A: SSE 클라이언트 (EventSource 래퍼)
├── 6-B: 상호작용 알림 컴포넌트 (Toast / Banner)
├── 6-C: 승인 다이얼로그 컴포넌트 (Level 3)
├── 6-D: 입력 폼 컴포넌트 (자유 텍스트 / 선택지)
└── 6-E: 상호작용 이력 뷰 (Run 상세 페이지 내)
```

**예상 소요 시간:**

| Phase | 예상 시간 | 비고 |
|-------|-----------|------|
| Phase 1 | 2-3일 | 핵심 로직, 철저한 테스트 필요 |
| Phase 2 | 1일 | SSE는 비교적 단순 |
| Phase 3 | 1일 | MCP 스키마 정의 + 핸들러 |
| Phase 4 | 0.5일 | 파일 읽기/재발행 로직 |
| Phase 5 | 2일 | 기존 코드와의 통합, 엣지 케이스 |
| Phase 6 | 3-4일 | React 컴포넌트 + UX 설계 |
| **합계** | **약 10-11일** | |

---

## 9. Key Design Decisions

### 9.1 왜 Deferred Promise인가?

**비교한 대안들:**

| 패턴 | 장점 | 단점 | MARS 적합성 |
|------|------|------|------------|
| **Callback** | 단순 | 중첩 복잡, 취소 어려움 | ❌ |
| **Event + polling** | 느슨한 결합 | 응답 연결 복잡, 상태 관리 부담 | ❌ |
| **AsyncIterator** | 스트리밍에 적합 | 단발성 질문에 과도한 추상화 | ❌ |
| **Deferred Promise** | `await` 한 줄, 취소/타임아웃 자연스러움 | Promise 메모리 누수 주의 | ✅ |

Deferred Promise의 핵심 이점:
- 호출자 코드가 `const response = await gate.request(...)` 한 줄로 끝남
- `Promise.allSettled`와 자연스럽게 통합 (배치 실행에서 한 에이전트 대기 시 나머지 완료 대기)
- 타임아웃은 `setTimeout` + `Deferred.resolve(fallback)` 으로 구현
- 취소는 `Deferred.reject(cancelError)` 으로 구현
- Level 1/2는 즉시 resolve → 호출자 코드 변경 불필요

### 9.2 왜 3-Level Autonomy인가?

CrewAI의 이진(on/off) 접근과 달리, 3단계 자율성은 실무에서 필수적이다:

- **Level 1 (Autonomous)**: 개발/테스트 환경에서 속도 우선. 모든 것을 로그로 추적 가능.
- **Level 2 (Inform)**: 가장 실용적. 에이전트가 안전하게 결정하되, 인간이 사후 확인 가능. 대부분의 `clarification`, `ambiguity_resolution`이 여기에 해당.
- **Level 3 (Approval)**: 파괴적 작업, 계획 승인 등 인간 판단이 필수인 항목. 이것이 SPEC.md §8의 요구사항.

### 9.3 왜 Config Resolution Chain인가?

단일 전역 설정으로는 실제 사용 시나리오를 충족할 수 없다:

- **전역**: "기본적으로 분해 결과는 승인이 필요하다"
- **Run 단위**: "이번 Run은 테스트 목적이므로 Level 2로 낮춘다"
- **Task 단위**: "이 특정 태스크는 프로덕션 DB를 다루므로 반드시 Level 3"

체인 우선순위 `byTask > byRun > byQuestionType > global`은 가장 구체적인 설정이 이기는 자연스러운 오버라이드 패턴이다.

### 9.4 왜 파일 기반 크래시 복구인가?

SQLite만으로는 크래시 복구가 불완전하다:

- SQLite에는 상호작용 레코드가 있지만, **인메모리 Deferred Promise**는 사라진다.
- `pending/*.json`은 Deferred를 재생성하기 위한 최소 정보를 담는다.
- 앱 재시작 시 Recovery Manager가 파일을 읽고, Gate에 Deferred를 재등록하고, SSE로 프론트엔드에 재발행한다.
- 이 접근은 WAL 로그나 Redis 같은 외부 의존성 없이 단순하게 동작한다.

### 9.5 왜 MCP Tool로 에이전트 질문을 처리하는가?

에이전트는 LLM이므로 tool call 인터페이스가 가장 자연스럽다:

- 에이전트 입장: "도구를 호출했더니 응답이 왔다" — 내부 구현 모름
- 에이전트는 질문을 **구조화된 형태**로 보냄 (제목, 설명, 선택지)
- InteractionGate가 autonomy level에 따라 즉시 또는 블로킹 처리
- 에이전트는 Level 1/2/3 구분을 전혀 모름 — 항상 같은 방식으로 호출

이것은 AutoGen의 `UserProxyAgent` + `UserInputRequestedEvent` 패턴과 유사하지만,
MCP tool이라는 표준화된 인터페이스를 사용한다는 점에서 더 깔끔하다.

---

## 10. Edge Cases & Recovery

### 10.1 Agent A 대기 중, Agent B 완료 (배치 내)

```
Batch [TaskA, TaskB]
├── AgentA → InteractionGate.request('clarification', ...) → Deferred (대기)
└── AgentB → 실행 완료 → Promise settled

Promise.allSettled([agentAPromise, agentBPromise])
  → agentBPromise: { status: 'fulfilled', value: result }
  → agentAPromise: (아직 pending)
  → allSettled은 모든 Promise가 settle될 때까지 대기
  → 사용자가 AgentA 질문에 응답 → agentAPromise settled
  → allSettled 리턴
```

**핵심**: `Promise.allSettled`는 rejected도 settled로 취급하므로, 에이전트 A가 `reject`(취소)되어도 배치는 정상 종료된다. 이것이 `Promise.all`이 아닌 `allSettled`를 사용하는 이유다.

### 10.2 Orchestrator 승인 → 에이전트 생성 전 블로킹

```
startRun() 호출
  ├── decompose() → 서브태스크 생성
  ├── ★ gate.request('decomposition_approval') → Level 3이면 여기서 블로킹
  │   └── 에이전트는 아직 생성되지 않음 — 안전
  ├── (사용자 승인)
  ├── schedule() → 실행 계획 생성
  ├── ★ gate.request('plan_approval') → Level 3이면 다시 블로킹
  ├── (사용자 승인)
  └── executeBatch() → 이제서야 에이전트 생성/실행
```

Orchestrator-level 승인은 에이전트 생성 **이전**에 발생하므로, 승인 없이 에이전트가 실행되는 일은 없다.

### 10.3 앱 종료 → 재시작 시 복구

```
1. 앱 정상 종료:
   ├── InteractionGate.dispose() 호출
   ├── 모든 pending Deferred를 reject(Error('disposed'))
   ├── 타이머 정리
   └── pending/*.json은 보존됨 (의도적)

2. 앱 크래시:
   ├── pending/*.json이 디스크에 남아있음
   └── 인메모리 Deferred는 소실됨

3. 앱 재시작:
   ├── RecoveryManager.recover() 호출
   ├── pending/*.json 읽기
   ├── 만료된 것: fallback 처리 + 파일 삭제
   ├── 유효한 것:
   │   ├── Gate.restorePending(id) → 새 Deferred 생성
   │   ├── SSE로 hitl:recovered + hitl:created 재발행
   │   └── 프론트엔드에 다시 표시
   └── Run 복구 로직이 restorePending()에서 반환된 Promise를 await
```

**주의사항**: 크래시 후 복구 시, 원래 호출자의 `await`는 사라졌다.
따라서 Run 복구 로직(`OrchestratorEngine.resumeRun()`)이 `gate.restorePending()`의 반환값을 다시 await 해야 한다.
이것은 Orchestration Engine의 Run 복구 구현 시 함께 설계해야 한다.

### 10.4 동시에 여러 질문 발생

```
Agent1 → gate.request('clarification', ...) → Deferred A
Agent2 → gate.request('permission_request', ...) → Deferred B
Orchestrator → gate.request('conflict_resolution', ...) → Deferred C

pending Map: { A: Deferred, B: Deferred, C: Deferred }

각각 독립적으로 관리:
├── 사용자가 B에 응답 → Deferred B resolve → Agent2 계속
├── C가 타임아웃 → Deferred C resolve(fallback) → Orchestrator 계속
└── 사용자가 A에 응답 → Deferred A resolve → Agent1 계속
```

프론트엔드는 여러 알림/다이얼로그를 큐에 쌓아 순서대로 표시하거나, `priority`에 따라 정렬한다.

### 10.5 타임아웃과 인간 응답의 Race Condition

```
t=0: gate.request() → Deferred 생성, setTimeout(10분)
t=9:59: 사용자가 응답 시작 (REST 요청 전송)
t=10:00: setTimeout 콜백 실행

Case A — 타임아웃이 먼저:
  handleTimeout(id):
    pending.has(id) → true → fallback resolve
  handleRespond(id):
    pending.has(id) → false → throw 'No pending interaction'
    → 프론트엔드에 404 반환 → "이미 처리됨" 표시

Case B — 응답이 먼저:
  handleRespond(id):
    pending.has(id) → true → resolve + delete from pending
  handleTimeout(id):
    pending.has(id) → false → return (무시)
```

`pending.has(id)` 체크가 원자적 가드 역할을 한다.
JavaScript는 단일 스레드이므로 실제 동시 실행은 발생하지 않지만,
이벤트 루프 순서에 의한 race는 이 가드로 안전하게 처리된다.

### 10.6 Level 2 Override 후 재실행

```
1. gate.request('assignment_approval') → Level 2 → 즉시 resolve (자동 배정)
2. 에이전트 실행 시작
3. 사용자가 나중에 UI에서 Override 클릭
4. POST /api/interactions/:id/override { action: 'modify', modifiedPayload: { ... } }
5. gate.override(id) → hitl:overridden 이벤트 발행
6. Orchestrator가 이벤트 수신:
   ├── 해당 태스크의 에이전트 실행이 아직 진행 중이면:
   │   ├── AbortController로 중단 (미래 구현)
   │   └── 수정된 배정으로 재실행
   └── 이미 완료됐으면:
       ├── 태스크에 're_execution_needed' 플래그 설정
       └── 다음 리뷰 단계에서 재실행 결정
```

---

## 11. Validation Criteria

HITL 시스템이 올바르게 구현되었는지 검증하기 위한 기준:

### 11.1 단위 테스트

| 테스트 대상 | 검증 항목 |
|------------|----------|
| `InteractionGate.request()` Level 1 | 즉시 resolve, `auto_resolved` 상태, 로그 기록 |
| `InteractionGate.request()` Level 2 | 즉시 resolve, `notified` 상태, `hitl:informed` 이벤트 발행 |
| `InteractionGate.request()` Level 3 | Promise가 pending 상태 유지, `hitl:created` 이벤트 발행 |
| `InteractionGate.respond()` | Deferred resolve, `responded` 상태, pending 파일 삭제, 이벤트 발행 |
| `InteractionGate.respond()` 중복 호출 | 두 번째 호출에서 에러 throw |
| 타임아웃 | fallbackAction에 따른 자동 resolve |
| 타임아웃 후 응답 | 무시됨 (pending.has() → false) |
| Config Resolution | byTask > byRun > byQuestionType > global 우선순위 |
| `cancelAllForRun()` | 해당 Run의 모든 pending Deferred reject |
| `override()` | Level 2만 가능, `overridden` 상태, 이벤트 발행 |

### 11.2 통합 테스트

| 시나리오 | 검증 항목 |
|---------|----------|
| 전체 흐름: 분해 → 승인 → 실행 → 리뷰 | 각 단계에서 gate.request() 호출되고 올바른 level 적용 |
| 배치 내 1개 대기 + 1개 완료 | Promise.allSettled가 올바르게 대기 |
| MCP tool → gate.request() → 응답 | 에이전트가 tool result로 응답 수신 |
| 앱 크래시 → 재시작 → 복구 | pending/*.json → Gate 재등록 → SSE 재발행 |
| SSE 연결 → 이벤트 수신 → REST 응답 | 프론트엔드 전체 흐름 |
| 동시 3개 질문 → 각각 독립 응답 | 서로 간섭 없이 처리 |

### 11.3 엣지 케이스 테스트

| 시나리오 | 기대 동작 |
|---------|----------|
| `destructive_action`을 Level 1로 설정 시도 | 설정은 적용되지만, `getAutonomousConfig()`에서 하드코딩으로 Level 3 유지 |
| 타임아웃 0ms | 즉시 fallback 실행 |
| 타임아웃 null + Level 3 | 무제한 대기 (메모리 누수 모니터링) |
| pending/*.json 파싱 실패 | 에러 로그 + 해당 파일 건너뛰기 |
| SSE 클라이언트 연결 끊김 | 해당 controller 정리, 다른 클라이언트 영향 없음 |
| Run 취소 중 응답 도착 | cancelAllForRun()의 reject가 먼저, 응답 무시 |

### 11.4 성능 기준

| 항목 | 기준 |
|------|------|
| Level 1/2 처리 시간 | < 5ms (DB 쓰기 포함) |
| Level 3 Deferred 생성 | < 10ms |
| 응답 처리 (respond()) | < 20ms (DB 업데이트 + 파일 삭제) |
| 크래시 복구 (100개 pending) | < 1초 |
| SSE 브로드캐스트 (10 클라이언트) | < 5ms |
| pending Map 메모리 (1000개) | < 10MB |

### 11.5 SPEC.md §8 준수 확인

최종적으로 이 시스템이 충족해야 할 핵심 원칙:

> **"Never auto-execute — always show proposed plan/subtasks for human review."**

- [x] 분해 결과(`decomposition_approval`)는 기본 Level 3 → 인간 확인 필수
- [x] 실행 계획(`plan_approval`)은 기본 Level 3 → 인간 확인 필수
- [x] 파괴적 작업(`destructive_action`)은 Level 3 하드코딩 → 자동 승인 불가
- [x] `getAutonomousConfig()`에서도 `destructive_action`은 Level 3 유지
- [x] Level 2 (Inform)에서도 사후 override 가능 → 최종 통제권은 항상 인간
- [x] Level 1 (Autonomous)에서도 모든 결정이 로그에 기록 → 감사 추적 가능
