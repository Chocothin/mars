# MARS Orchestrator Tools Spec

> Orchestrator가 프로젝트 상태를 직접 조회/변경할 수 있도록 노출할 tool surface 명세.
> 현재 코드베이스의 기존 API/service를 최대한 재사용하는 것을 전제로 한다.

---

## 1. Purpose

이 문서의 목표는 오케스트레이터가 다음 작업을 직접 수행할 수 있도록, 작고 명시적인 tool set을 정의하는 것이다.

- 프로젝트 메타데이터 조회
- 태스크 생성/조회/수정
- 태스크 의존성 생성/삭제/조회
- 에이전트 조회/랭킹/할당
- 실행(run) 생성/시작/조회/중단
- HITL 상호작용 조회/응답

핵심 원칙:

- 하나의 범용 mutation tool 대신, 작고 목적이 분명한 typed tool 여러 개를 둔다.
- 현재 `src/routes/*.ts`, `src/*/service.ts`가 이미 제공하는 primitive를 래핑한다.
- read / additive write / destructive write 권한을 분리한다.
- 오케스트레이터가 쓰는 모든 tool은 structured input/output을 가진다.

---

## 2. Design Rules

### 2.1 Tool Design

- tool name은 동사 중심으로 명확해야 한다.
- 입력은 JSON object 하나만 받는다.
- 출력은 prose가 아니라 machine-readable object를 반환한다.
- 모든 ID는 canonical ID를 사용한다 (`projectId`, `taskId`, `agentId`, `runId`, `interactionId`).
- destructive 작업은 별도 tool로 분리한다.

### 2.2 Permission Classes

| Class | Meaning | Examples |
|---|---|---|
| `read` | 상태 조회만 가능 | `project_get_context`, `task_get`, `agent_list` |
| `write:additive` | 새 리소스 생성 또는 비파괴 변경 | `task_create`, `task_add_dependency`, `run_create` |
| `write:destructive` | 삭제/관계 제거/취소 | `task_delete`, `task_remove_dependency`, `run_cancel` |

### 2.3 Execution Rules

- tool은 가능하면 현재 existing route/service를 그대로 호출한다.
- tool layer는 validation/permission/audit를 추가하지만 business logic을 재구현하지 않는다.
- project-scoped 작업은 반드시 `projectId`를 기준으로 검증한다.

---

## 3. Tool Catalog

## 3.1 Project Tools

### `project_get_context`

- Permission: `read`
- Purpose: 오케스트레이터가 특정 프로젝트의 실행 문맥을 읽는다.
- Backing surface:
  - `src/routes/projects.ts`
  - `src/projects/service.ts`
  - `src/db/project-repo.ts`

Input:

```json
{
  "projectId": "string"
}
```

Output:

```json
{
  "project": {
    "id": "string",
    "name": "string",
    "description": "string",
    "directoryPath": "string",
    "providerId": "string|null",
    "status": "active|archived",
    "agentIds": ["string"],
    "mcpServerIds": ["string"],
    "createdAt": 0,
    "updatedAt": 0
  }
}
```

Notes:

- 오케스트레이터용으로는 단순 project row 외에 agent/provider summary를 함께 enrich하는 것이 좋다.

### `project_list`

- Permission: `read`
- Purpose: 실행 가능한 프로젝트 후보 탐색

Input:

```json
{
  "status": "active",
  "search": "optional string",
  "limit": 50,
  "offset": 0
}
```

Output:

```json
{
  "projects": []
}
```

---

## 3.2 Task Tools

### `task_list`

- Permission: `read`
- Purpose: project 내 task inventory 조회
- Backing surface:
  - `src/routes/tasks.ts`
  - `src/tasks/service.ts`

Input:

```json
{
  "projectId": "string",
  "status": "optional backlog|blocked|ready|in_progress|review|done",
  "priority": "optional low|medium|high|urgent",
  "parentTaskId": "optional string|null",
  "assignedAgentType": "optional string",
  "search": "optional string",
  "limit": 100,
  "offset": 0
}
```

Output:

```json
{
  "tasks": [
    {
      "id": "string",
      "projectId": "string",
      "parentTaskId": "string|null",
      "title": "string",
      "description": "string",
      "status": "string",
      "priority": "string",
      "order": 0,
      "assignedAgentType": "string|null",
      "dependsOnTaskIds": ["string"],
      "createdAt": 0,
      "updatedAt": 0
    }
  ]
}
```

### `task_get`

- Permission: `read`
- Purpose: 단일 task 상세 조회

Input:

```json
{
  "taskId": "string"
}
```

Output:

```json
{
  "task": {}
}
```

### `task_create`

- Permission: `write:additive`
- Purpose: 새 task 생성
- Backing surface:
  - `src/routes/tasks.ts`
  - `src/tasks/service.ts#create`

Input:

```json
{
  "projectId": "string",
  "title": "string",
  "description": "optional string",
  "status": "optional backlog|blocked|ready|in_progress|review|done",
  "priority": "optional low|medium|high|urgent",
  "parentTaskId": "optional string",
  "assignedAgentType": "optional string",
  "dependsOnTaskIds": ["optional string"]
}
```

Output:

```json
{
  "task": {}
}
```

Behavior:

- dependency self-reference / missing task / circular dependency는 service 레벨에서 거부된다.
- 미완료 dependency가 있으면 status는 자동으로 `blocked`가 될 수 있다.

### `task_update`

- Permission: `write:additive`
- Purpose: title/description/status/priority/order/assigned hint 변경

Input:

```json
{
  "projectId": "string",
  "taskId": "string",
  "patch": {
    "title": "optional string",
    "description": "optional string",
    "status": "optional string",
    "priority": "optional string",
    "order": "optional integer",
    "assignedAgentType": "optional string|null"
  }
}
```

Output:

```json
{
  "task": {},
  "warnings": ["string"],
  "autoTransitioned": [
    {
      "taskId": "string",
      "taskTitle": "string",
      "from": "string",
      "to": "string"
    }
  ]
}
```

### `task_delete`

- Permission: `write:destructive`
- Purpose: task 삭제

Input:

```json
{
  "projectId": "string",
  "taskId": "string"
}
```

Output:

```json
{
  "deleted": true
}
```

---

## 3.3 Dependency Tools

### `task_get_dependencies`

- Permission: `read`
- Purpose: 특정 task의 upstream dependency 조회

Input:

```json
{
  "projectId": "string",
  "taskId": "string"
}
```

Output:

```json
{
  "dependencies": [
    {
      "id": "string",
      "title": "string"
    }
  ]
}
```

### `task_add_dependency`

- Permission: `write:additive`
- Purpose: task dependency edge 생성
- Backing surface:
  - `src/routes/tasks.ts#dependencies`
  - `src/tasks/service.ts#addDependency`

Input:

```json
{
  "projectId": "string",
  "taskId": "string",
  "dependsOnTaskId": "string"
}
```

Output:

```json
{
  "task": {}
}
```

### `task_remove_dependency`

- Permission: `write:destructive`
- Purpose: dependency edge 제거

Input:

```json
{
  "projectId": "string",
  "taskId": "string",
  "dependsOnTaskId": "string"
}
```

Output:

```json
{
  "task": {}
}
```

---

## 3.4 Agent Tools

### `agent_list`

- Permission: `read`
- Purpose: 에이전트 후보 조회
- Backing surface:
  - `src/routes/agents.ts`
  - `src/agents/service.ts`

Input:

```json
{
  "providerId": "optional string",
  "modelId": "optional string",
  "reasoningLevel": "optional none|low|medium|high",
  "enabled": true,
  "search": "optional string",
  "limit": 50,
  "offset": 0
}
```

Output:

```json
{
  "agents": [
    {
      "id": "string",
      "name": "string",
      "description": "string",
      "providerId": "string",
      "modelId": "string",
      "systemPrompt": "string",
      "reasoningLevel": "string",
      "workerCount": 1,
      "mcpServerIds": ["string"],
      "skillIds": ["string"],
      "enabled": true
    }
  ]
}
```

### `agent_get`

- Permission: `read`
- Purpose: 단일 agent 상세 조회

Input:

```json
{
  "agentId": "string"
}
```

Output:

```json
{
  "agent": {}
}
```

### `agent_rank_for_task`

- Permission: `read`
- Purpose: 주어진 task에 대해 agent suitability ranking 조회
- Backing surface:
  - `src/routes/orchestrator.ts#match-agents`
  - `src/orchestrator/router.ts`

Input:

```json
{
  "taskId": "string",
  "candidateAgentIds": ["string"]
}
```

Output:

```json
{
  "scores": [
    {
      "agentId": "string",
      "taskId": "string",
      "score": 0.0,
      "matchedCapabilities": ["string"],
      "missingCapabilities": ["string"]
    }
  ]
}
```

---

## 3.5 Assignment Tools

### `task_assign_agent`

- Permission: `write:additive`
- Purpose: task에 concrete agentId를 영속적으로 배정한다.
- Status: `NEW REQUIRED`

Input:

```json
{
  "projectId": "string",
  "taskId": "string",
  "agentId": "string"
}
```

Output:

```json
{
  "task": {
    "id": "string",
    "assignedAgentId": "string"
  }
}
```

Why needed:

- 현재 task 모델에는 `assignedAgentType`만 있고 concrete `agentId`가 없다.
- 현재 `AgentRouter`는 runtime scoring으로만 선택하며, 선택 결과가 task domain state로 저장되지 않는다.

Required model change:

- `src/types/task.ts`에 `assignedAgentId: string | null` 추가
- `src/db/task-repo.ts` 및 schema에 column 추가
- `src/tasks/service.ts` / `src/routes/tasks.ts` update path 확장

---

## 3.6 Run Tools

### `run_create`

- Permission: `write:additive`
- Purpose: 특정 프로젝트와 root task set으로 orchestration run 생성
- Backing surface:
  - `src/routes/runs.ts`
  - `src/orchestrator/engine.ts#createRun`

Input:

```json
{
  "projectId": "string",
  "taskIds": ["string"],
  "config": {
    "maxConcurrency": 3,
    "maxRetries": 1,
    "timeoutMs": 1800000,
    "taskTimeoutMs": 300000,
    "autoReview": true,
    "requireHumanApproval": true
  }
}
```

Output:

```json
{
  "run": {
    "id": "string",
    "projectId": "string",
    "status": "pending"
  }
}
```

Validation requirement:

- tool layer에서 `taskIds`가 실제로 해당 `projectId` 소속인지 검증해야 한다.

### `run_start`

- Permission: `write:additive`
- Purpose: pending run 시작

Input:

```json
{
  "runId": "string"
}
```

Output:

```json
{
  "accepted": true
}
```

### `run_pause`

- Permission: `write:additive`
- Purpose: run pause 요청

Input:

```json
{
  "runId": "string"
}
```

Output:

```json
{
  "accepted": true
}
```

Note:

- 현재 구현은 hard stop이 아니라 soft status flip 성격이다.

### `run_resume`

- Permission: `write:additive`

Input:

```json
{
  "runId": "string"
}
```

Output:

```json
{
  "accepted": true
}
```

### `run_cancel`

- Permission: `write:destructive`

Input:

```json
{
  "runId": "string"
}
```

Output:

```json
{
  "accepted": true
}
```

### `run_get`

- Permission: `read`
- Purpose: run status / execution plan / result 조회

Input:

```json
{
  "runId": "string"
}
```

Output:

```json
{
  "run": {
    "id": "string",
    "projectId": "string",
    "status": "pending|decomposing|scheduling|running|reviewing|paused|completed|failed|cancelled",
    "executionPlan": {},
    "result": {}
  }
}
```

### `run_list`

- Permission: `read`
- Status: `RECOMMENDED ADDITION`
- Purpose: project 기준 최근 run 조회

---

## 3.7 HITL Tools

### `interaction_list`

- Permission: `read`
- Purpose: pending approval / info interaction 조회
- Backing surface:
  - `src/routes/interactions.ts`
  - `src/hitl/interaction-gate.ts`

Input:

```json
{
  "runId": "optional string",
  "status": "optional pending|resolved"
}
```

Output:

```json
{
  "interactions": []
}
```

### `interaction_respond`

- Permission: `write:additive`
- Purpose: approval/reject/modify 응답 제출

Input:

```json
{
  "interactionId": "string",
  "decision": "approve|reject|modify",
  "message": "optional string",
  "payload": {}
}
```

Output:

```json
{
  "resolved": true
}
```

---

## 4. Recommended Tool Set for V1

V1에서 먼저 여는 tool은 아래가 최소 집합이다.

1. `project_get_context`
2. `task_list`
3. `task_get`
4. `task_create`
5. `task_update`
6. `task_add_dependency`
7. `task_remove_dependency`
8. `agent_list`
9. `agent_rank_for_task`
10. `task_assign_agent` `NEW REQUIRED`
11. `run_create`
12. `run_start`
13. `run_get`
14. `interaction_list`
15. `interaction_respond`

---

## 5. Gaps in Current Codebase

## 5.1 Missing Persistent Agent Assignment

현재 부족한 가장 큰 기능은 concrete `agentId` 영속 배정이다.

- 현재 있음: `assignedAgentType`
- 현재 없음: `assignedAgentId`
- 현재 동작: execution 시점에 `AgentRouter`가 score 계산 후 선택
- 문제: orchestrator가 "이 태스크는 이 에이전트가 맡는다"를 state로 남길 수 없음

## 5.2 Project-Scoped Agent Resolution

도구 계층은 기본적으로 `project.agentIds`를 candidate pool로 사용해야 한다.

- 그렇지 않으면 전역 enabled agent가 assignment 후보가 된다.
- orchestrator tool은 project membership-aware여야 한다.

## 5.3 Run Introspection Surface

`run_get`만으로 부족하면 다음이 필요하다.

- `run_list(projectId, status?)`
- `run_get_task_executions(runId)`
- live telemetry/event summary

## 5.4 Working Directory Context

tool이 task/run을 생성할 때 project의 `directoryPath`를 context에 포함해 주는 것이 좋다.

- orchestrator planning prompt
- execution context builder
- dependency-aware file ops

---

## 6. Implementation Mapping

| Tool | Existing Surface | Change Needed |
|---|---|---|
| `project_get_context` | `src/routes/projects.ts`, `src/projects/service.ts` | enrich optional |
| `task_list` | `src/routes/tasks.ts` | none |
| `task_get` | `src/routes/tasks.ts` | none |
| `task_create` | `src/routes/tasks.ts`, `src/tasks/service.ts` | none |
| `task_update` | `src/routes/tasks.ts`, `src/tasks/service.ts` | extend if `assignedAgentId` added |
| `task_add_dependency` | `src/routes/tasks.ts`, `src/tasks/service.ts` | none |
| `task_remove_dependency` | `src/routes/tasks.ts`, `src/tasks/service.ts` | none |
| `agent_list` | `src/routes/agents.ts`, `src/agents/service.ts` | none |
| `agent_rank_for_task` | `src/routes/orchestrator.ts`, `src/orchestrator/router.ts` | candidate scoping recommended |
| `task_assign_agent` | none | new schema + route + service support |
| `run_create` | `src/routes/runs.ts`, `src/orchestrator/engine.ts` | task/project validation needed |
| `run_start` | `src/routes/runs.ts` | none |
| `run_get` | `src/routes/runs.ts` | enrich optional |
| `interaction_list` | `src/routes/interactions.ts` | none |
| `interaction_respond` | `src/routes/interactions.ts` | none |

---

## 7. Approval Policy

기본 approval 정책 권장값:

- `read`: auto-allow
- `write:additive`: allow with audit log
- `write:destructive`: explicit approval required

오케스트레이터가 destructive operation을 호출할 때는 최소한 아래를 함께 기록해야 한다.

- actor = `orchestrator`
- runId
- taskId / projectId
- reason
- timestamp

---

## 8. Suggested Next Implementation Order

1. `project_get_context`, `task_*`, `agent_list`, `agent_rank_for_task`를 thin wrapper로 노출
2. `task_assign_agent`를 위한 schema + persistence 추가
3. `run_create`에 project/task ownership validation 추가
4. `run_list` / execution telemetry surface 보강

이 순서면 기존 시스템을 깨지 않고 orchestrator-native tool layer를 가장 빠르게 만들 수 있다.
