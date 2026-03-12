# MARS — Multi-Agent Runtime Studio

AI 에이전트 오케스트레이션 엔진. 여러 CLI 기반 AI 에이전트를 조율하여 복잡한 소프트웨어 프로젝트를 자동으로 분해, 실행, 검증한다.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Frontend (Next.js 16)        :3000                 │
│  Dashboard · Projects · Tasks · Agents · Terminal   │
├─────────────────────────────────────────────────────┤
│  Backend (Bun + Hono-style)   :3001                 │
│  ┌───────────────────────────────────────────────┐  │
│  │ Orchestrator Engine                           │  │
│  │  TaskDecomposer → ReactiveScheduler → Engine  │  │
│  │  AgentPool → AgentProcess → CLI Executor      │  │
│  │  ResultReviewer → Phase Gate → Artifact Bus   │  │
│  ├───────────────────────────────────────────────┤  │
│  │ Reactive Scheduler                            │  │
│  │  Dependency Resolution (blocks / informs)     │  │
│  │  Fail-Stop Cascade · Phase Gate Enforcement   │  │
│  │  Parent Status Derivation                     │  │
│  ├───────────────────────────────────────────────┤  │
│  │ Execution Layer                               │  │
│  │  Context Builder · Agent Runner · Session Mgr │  │
│  │  Codex CLI · Claude CLI · OpenAI Provider     │  │
│  ├───────────────────────────────────────────────┤  │
│  │ SQLite (bun:sqlite)                           │  │
│  │  providers · agents · skills · projects       │  │
│  │  tasks · task_dependencies · runs             │  │
│  │  task_executions · messages · mcp_servers     │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## Key Features

**Orchestration Engine**
- Task decomposition — LLM이 고수준 목표를 실행 가능한 서브태스크로 분해
- Reactive scheduling — 의존성 기반 동적 스케줄링, 매 tick마다 ready/blocked 전이
- Multi-agent pool — 에이전트별 워커 수 설정, 병렬 실행

**Fail-Stop Cascade**
- `blocks` 의존성: 상류 태스크가 done이어야만 하류 진행
- `informs` 의존성: 상류가 done/failed/cancelled 아무거나 되면 하류 진행
- 상류 실패 시 하류 연쇄 취소 (transitive cascade)

**Artifact Bus**
- 완료된 태스크의 산출물(output, filesModified)을 하류 태스크 시스템 프롬프트에 자동 주입
- 건당 4K, 총 12K 캡으로 truncation
- 하류 태스크 힌트를 상류 에이전트에게 제공

**Phase Gate**
- `phase` / `phaseOrder`로 단계별 실행 순서 강제
- 현재 phase의 모든 태스크가 완료되어야 다음 phase 개방
- 예: pm_definition → design → implementation → qa

**Human-in-the-Loop (HITL)**
- 3단계 승인 레벨 (auto / confirm / block)
- 인터랙션 게이트 — 에이전트가 사람에게 질문/승인 요청
- 복구 매니저 — 서버 재시작 시 pending 인터랙션 복원

**기타**
- Result reviewer — 자동 리뷰 + 수용 기준 검증
- MCP 서버 통합 — 외부 도구를 에이전트에 연결
- 실시간 이벤트 스트리밍 (SSE)
- 웹 터미널 (xterm.js + WebSocket)

## Requirements

- [Bun](https://bun.sh) >= 1.0
- [Node.js](https://nodejs.org) >= 20 (frontend)
- AI provider 중 하나:
  - [Codex CLI](https://github.com/openai/codex) (OpenAI)
  - [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) (Anthropic)

## Installation

```bash
# 클론
git clone https://github.com/Chocothin/mars.git
cd mars

# 백엔드 의존성
bun install

# 프론트엔드 의존성
cd frontend && npm install && cd ..
```

## Usage

### 서버 실행

```bash
# 백엔드 (포트 3001)
bun src/index.ts

# 프론트엔드 (포트 3000) — 별도 터미널
cd frontend && npm run dev
```

브라우저에서 `http://localhost:3000` 접속.

### 기본 셋업 순서

1. **Provider 등록** — Settings에서 API 키와 함께 AI provider 추가
2. **Agent 생성** — 모델, 시스템 프롬프트, 워커 수 설정
3. **Project 생성** — 작업 디렉토리와 에이전트 지정
4. **Task 생성** — 고수준 목표 입력 → 자동 분해 → 실행

### API

```bash
# 프로젝트 목록
curl http://localhost:3001/api/projects

# 태스크 생성
curl -X POST http://localhost:3001/api/projects/:id/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title": "Implement auth module", "description": "..."}'

# 런 시작
curl -X POST http://localhost:3001/api/projects/:id/runs \
  -H 'Content-Type: application/json' \
  -d '{"taskIds": ["task-1", "task-2"], "autoReview": true}'
```

### 테스트

```bash
# 전체 테스트
bun test

# 특정 테스트
bun test src/__tests__/orchestrator/fail-stop.test.ts

# 타입 체크
bun run typecheck
```

## Project Structure

```
src/
├── orchestrator/      # 엔진 코어 — 스케줄러, 디컴포저, 리뷰어
├── execution/         # 에이전트 실행 — 컨텍스트 빌더, 러너
├── providers/         # CLI 실행기 — Codex, Claude
├── db/                # SQLite 레포지토리 레이어
├── routes/            # REST API 라우트
├── types/             # 타입 정의
├── events/            # 이벤트 버스 (SSE)
├── hitl/              # Human-in-the-Loop 인터랙션
├── terminal/          # 웹 터미널 (WebSocket)
├── mcp/               # MCP 프로토콜 통합
├── skills/            # 스킬 시스템
├── tasks/             # 태스크 서비스
└── __tests__/         # 테스트
frontend/              # Next.js 16 대시보드
```

## License

[MIT](LICENSE)
