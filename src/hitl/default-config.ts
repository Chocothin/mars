import type { AutonomyConfig, AutonomyRule, QuestionType } from './types';

// ─── 질문 유형별 기본 규칙 ───

const DEFAULT_RULES: Record<QuestionType, AutonomyRule> = {
  // Orchestrator-level
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

  // Agent-level
  clarification: {
    level: 2,                    // Inform — 에이전트가 자체 판단, 알림
    timeoutMs: null,
    fallbackAction: 'auto_answer',
  },
  destructive_action: {
    level: 3,                    // Approval — 파괴적 작업은 절대 자동 승인 금지
    timeoutMs: null,             // 무제한 대기 — 인간이 반드시 결정
    fallbackAction: 'fail',
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
    level: 2,
    timeoutMs: null,
    fallbackAction: 'auto_answer',
  },
  task_review: {
    level: 3,
    timeoutMs: 10 * 60 * 1000,
    fallbackAction: 'auto_approve',
  },
};

// ─── 기본 Autonomy Config ───

export const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  global: 3,                    // 기본값: Approval (안전 우선)
  byQuestionType: DEFAULT_RULES,
  byRun: null,
  byTask: null,
};

/** @deprecated Use simple-config.ts instead */
export function getAutoReviewOverrides(): Partial<Record<QuestionType, AutonomyRule>> {
  return {};
}

/** @deprecated Use simple-config.ts instead */
export function getManualReviewOverrides(): Partial<Record<QuestionType, AutonomyRule>> {
  return {};
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
