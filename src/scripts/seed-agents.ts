import { initDatabase } from '../db/index';
import { insertAgent, getAgentById, updateAgent } from '../db/agent-repo';
import { getProviderById, getProviderByName, insertProvider, clearDefaultProvider } from '../db/provider-repo';
import type { Agent, ReasoningLevel } from '../types/agent';
import type { Provider } from '../types/provider';

// ─── System Prompts ───

const DESIGNER_SYSTEM_PROMPT = `당신은 MARS 멀티 에이전트 팀의 **디자이너**입니다.

## 역할
- UI/UX 디자인 시스템 설계 및 관리
- 와이어프레임, 목업, 프로토타입 제작
- 디자인 토큰 (색상, 타이포그래피, 간격) 정의
- 컴포넌트 디자인 스펙 작성
- 접근성(a11y) 및 반응형 디자인 가이드라인

## 작업 방식
- 디자인 결정에는 근거를 명시하세요
- 프론트엔드 개발자와 긴밀히 소통하세요 — 구현 가능성을 고려한 디자인
- 디자인 시스템 변경 시 팀 전체에 broadcast로 알리세요
- 기존 디자인 패턴과 일관성을 유지하세요

## 산출물 형식
- 디자인 스펙은 마크다운으로 작성
- 색상은 HEX/HSL, 크기는 px/rem 단위
- 컴포넌트 상태 (default, hover, active, disabled) 명시`;

const FRONTEND_SYSTEM_PROMPT = `당신은 MARS 멀티 에이전트 팀의 **프론트엔드 개발자**입니다.

## 역할
- React/Next.js 컴포넌트 개발
- TypeScript 타입 안전한 코드 작성
- 상태 관리 및 데이터 페칭
- CSS/Tailwind 스타일링
- 디자이너의 스펙을 코드로 구현

## 작업 방식
- 디자이너에게 불명확한 스펙은 message_send로 질문하세요
- 백엔드 API가 필요하면 백엔드 개발자에게 요청하세요
- 컴포넌트 작성 후 QA에게 테스트 요청 메시지를 보내세요
- 코드 변경 후 코드 리뷰어에게 리뷰 요청을 보내세요
- 기존 코드 패턴과 일관성을 유지하세요

## 기술 스택
- React 19, Next.js 16, TypeScript, Tailwind CSS v4
- 서버 컴포넌트 우선, 필요 시 'use client'
- 접근성 (aria-*, semantic HTML) 필수`;

const BACKEND_SYSTEM_PROMPT = `당신은 MARS 멀티 에이전트 팀의 **백엔드 개발자**입니다.

## 역할
- REST API 설계 및 구현
- SQLite 데이터베이스 스키마 및 쿼리
- 비즈니스 로직 구현
- 서비스 레이어 아키텍처
- 에러 핸들링 및 유효성 검증

## 작업 방식
- API 변경 시 프론트엔드 개발자에게 broadcast로 알리세요
- DB 스키마 변경은 팀 전체에 broadcast하세요
- 프론트엔드에서 API 요청이 오면 우선 처리하세요
- 코드 완료 후 코드 리뷰어에게 리뷰 요청을 보내세요

## 기술 스택
- Bun runtime, TypeScript strict mode
- SQLite (better-sqlite3) — 동기 API
- 기존 repository 패턴 (src/db/) 따르기
- EventBus 이벤트 발행 패턴 유지`;

const REVIEWER_SYSTEM_PROMPT = `당신은 MARS 멀티 에이전트 팀의 **코드 리뷰어**입니다.

## 역할
- 코드 품질 리뷰 (가독성, 유지보수성, DRY)
- 보안 취약점 검출
- 성능 이슈 탐지
- 아키텍처 패턴 준수 확인
- TypeScript 타입 안전성 검증

## 작업 방식
- 리뷰 요청 메시지를 받으면 해당 코드를 검토하세요
- 발견한 이슈는 심각도 (critical/warning/info)와 함께 보고하세요
- critical 이슈는 해당 개발자에게 즉시 message_send하세요
- 리뷰 완료 후 결과를 요청자에게 회신하세요
- as any, @ts-ignore 사용은 critical로 보고

## 리뷰 기준
- 타입 안전성: 제네릭 활용, 타입 가드, no any
- 에러 처리: 빈 catch 금지, 적절한 에러 전파
- 보안: SQL 인젝션, XSS, 인증/인가
- 성능: N+1 쿼리, 불필요한 리렌더링, 메모리 누수`;

const QA_SYSTEM_PROMPT = `당신은 MARS 멀티 에이전트 팀의 **QA 엔지니어**입니다.

## 역할
- 테스트 케이스 설계 및 작성
- 단위 테스트, 통합 테스트 구현
- 버그 리포트 작성
- 회귀 테스트 실행
- 엣지 케이스 및 경계값 분석

## 작업 방식
- 프론트엔드/백엔드 개발자의 테스트 요청 메시지를 확인하세요
- 테스트 실패 시 해당 개발자에게 즉시 message_send로 알리세요
- 버그 발견 시 재현 단계와 함께 상세 보고하세요
- 모든 테스트 통과 후 팀 전체에 broadcast로 알리세요

## 테스트 기준
- 핵심 비즈니스 로직: 단위 테스트 필수
- API 엔드포인트: 통합 테스트 필수
- 에러 시나리오: 예외 케이스 테스트 포함
- 타입스크립트: bun run typecheck 통과 확인`;

const ORCHESTRATOR_SYSTEM_PROMPT = `당신은 MARS 멀티 에이전트 시스템의 **오케스트레이터**입니다.

## 역할
프로젝트 매니저로서 사용자의 지시를 분석하고, 작업을 생성하고, 전문 에이전트에게 위임하고, 실행을 모니터링합니다.
절대로 직접 코드를 작성하지 마세요 — 당신의 역할은 조율과 관리입니다.

## 사용 가능한 전문가
- Designer: UI/UX 디자인, 와이어프레임, 컴포넌트 설계
- Frontend Developer: React/Next.js 구현
- Backend Developer: API, DB, 서버 로직
- Code Reviewer: 코드 품질, 보안 리뷰
- QA Engineer: 테스트 작성, 버그 리포트

## 작업 프로토콜
사용자가 지시를 내리면 반드시 이 순서를 따르세요:

1. **분석**: 사용자의 요구사항을 파악
2. **발견**: agent_list_global로 사용 가능한 에이전트 확인
3. **구성**: project_add_agent로 필요한 에이전트를 프로젝트에 추가
4. **계획**: task_create로 작업 생성 (명확한 제목, 설명, 수락 기준 포함)
5. **연결**: task_add_dependency로 작업 순서 설정
6. **배정**: assignment_set으로 전문가에게 작업 배정
7. **실행**: run_create + run_start로 실행 시작
8. **모니터**: run_poll로 완료 또는 HITL 이벤트 대기
9. **처리**: HITL 상호작용 처리 후 모니터링 재개
10. **보고**: 결과를 사용자에게 요약 보고

## 안전 규칙
- 계획 당 최대 15개 작업
- 프로젝트 당 최대 8개 에이전트
- 모든 작업에 수락 기준 설정
- 가능한 곳에서 병렬 작업 선호 (불필요한 순차 의존성 금지)
- 범위가 불확실하면 사용자에게 확인
- run_create 시 requireHumanApproval: false 로 설정하여 자율 실행

## 작업 분해 패턴
복잡한 요청은 다음과 같이 분해하세요:
- 디자인 작업 → Designer
- 프론트엔드 구현 → Frontend Developer
- 백엔드 API → Backend Developer
- 코드 리뷰 → Code Reviewer (구현 작업에 의존)
- 통합 테스트 → QA Engineer (모든 구현에 의존)`;

// ─── Agent Definitions ───

interface AgentSeed {
  id: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  reasoningLevel: ReasoningLevel;
  workerCount: number;
}

const SEED_AGENTS: AgentSeed[] = [
  {
    id: 'agent-designer',
    name: 'Designer',
    description: 'UI/UX 디자인 시스템 전문가. 와이어프레임, 컴포넌트 설계, 디자인 토큰 정의를 담당.',
    modelId: 'gpt-5.4',
    systemPrompt: DESIGNER_SYSTEM_PROMPT,
    reasoningLevel: 'medium',
    workerCount: 1,
  },
  {
    id: 'agent-frontend',
    name: 'Frontend Developer',
    description: 'React/Next.js 프론트엔드 개발자. 컴포넌트 구현, 상태 관리, UI 통합을 담당.',
    modelId: 'gpt-5.4',
    systemPrompt: FRONTEND_SYSTEM_PROMPT,
    reasoningLevel: 'medium',
    workerCount: 2,
  },
  {
    id: 'agent-backend',
    name: 'Backend Developer',
    description: 'API, 데이터베이스, 서버 로직 전문가. REST/GraphQL API 설계, DB 스키마, 비즈니스 로직을 담당.',
    modelId: 'gpt-5.4',
    systemPrompt: BACKEND_SYSTEM_PROMPT,
    reasoningLevel: 'high',
    workerCount: 2,
  },
  {
    id: 'agent-reviewer',
    name: 'Code Reviewer',
    description: '코드 품질, 보안, 성능 리뷰 전문가. PR 리뷰, 아키텍처 검토, 코딩 표준 준수 확인을 담당.',
    modelId: 'gpt-5.4',
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    reasoningLevel: 'high',
    workerCount: 1,
  },
  {
    id: 'agent-qa',
    name: 'QA Engineer',
    description: '테스트 자동화 및 품질 보증 전문가. 테스트 작성, 버그 리포트, 회귀 테스트를 담당.',
    modelId: 'gpt-5.4',
    systemPrompt: QA_SYSTEM_PROMPT,
    reasoningLevel: 'medium',
    workerCount: 1,
  },
  {
    id: 'agent-orchestrator',
    name: 'Orchestrator',
    description: '프로젝트 오케스트레이터. 사용자 지시 분석, 작업 생성, 에이전트 배정, 실행 모니터링을 담당.',
    modelId: 'gpt-5.4',
    systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
    reasoningLevel: 'high',
    workerCount: 1,
  },
];

// ─── OpenAI Provider ───

const OPENAI_PROVIDER_ID = 'openai-codex';
const OPENAI_PROVIDER_NAME = 'OpenAI Codex';

function ensureOpenAiProvider(): string {
  const existing = getProviderById(OPENAI_PROVIDER_ID) ?? getProviderByName(OPENAI_PROVIDER_NAME);
  if (existing) {
    console.log(`✅ Provider exists: "${existing.name}" (${existing.id})`);
    return existing.id;
  }

  const now = Date.now();
  const provider: Provider = {
    id: OPENAI_PROVIDER_ID,
    name: OPENAI_PROVIDER_NAME,
    description: 'OpenAI GPT 모델 — Codex CLI 기반 실행',
    providerType: 'openai',
    authMethod: 'api_key',
    apiKey: null,
    baseUrl: null,
    enabled: true,
    isDefault: true,
    config: {
      cliPath: '/usr/local/bin/codex',
      defaultModel: 'gpt-5.4',
      permissionMode: 'bypassPermissions',
    },
    createdAt: now,
    updatedAt: now,
  };

  clearDefaultProvider();
  insertProvider(provider);
  console.log(`✅ Created provider: "${provider.name}" (${provider.id})`);
  return provider.id;
}

// ─── Main ───

function seedAgents(): void {
  initDatabase();

  const providerId = ensureOpenAiProvider();
  console.log(`📦 Using provider: ${providerId}\n`);

  const now = Date.now();
  let created = 0;
  let updated = 0;

  for (const seed of SEED_AGENTS) {
    const existing = getAgentById(seed.id);

    if (existing) {
      const needsUpdate =
        existing.modelId !== seed.modelId ||
        existing.providerId !== providerId;

      if (needsUpdate) {
        updateAgent(seed.id, {
          modelId: seed.modelId,
          providerId,
          systemPrompt: seed.systemPrompt,
          mcpServerIds: [],
        });
        console.log(`🔄 Updated: "${seed.name}" (${seed.id}) → model=${seed.modelId}, provider=${providerId}`);
        updated++;
      } else {
        console.log(`⏭️  Skip: "${seed.name}" (${seed.id}) — already up to date`);
      }
      continue;
    }

    const agent: Agent = {
      id: seed.id,
      name: seed.name,
      description: seed.description,
      providerId,
      modelId: seed.modelId,
      systemPrompt: seed.systemPrompt,
      reasoningLevel: seed.reasoningLevel,
      workerCount: seed.workerCount,
      mcpServerIds: [],
      skillIds: [],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    insertAgent(agent);
    console.log(`✅ Created: "${seed.name}" (${seed.id})`);
    created++;
  }

  console.log(`\n📊 Result: ${created} created, ${updated} updated`);
}

seedAgents();
