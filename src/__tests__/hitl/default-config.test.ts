import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_AUTONOMY_CONFIG,
  getStrictConfig,
  getAutonomousConfig,
  getAutoReviewOverrides,
  getManualReviewOverrides,
} from '../../hitl/default-config';
import type { QuestionType, AutonomyLevel } from '../../hitl/types';

const ALL_QUESTION_TYPES: QuestionType[] = [
  'decomposition_approval',
  'assignment_approval',
  'plan_approval',
  'conflict_resolution',
  'clarification',
  'destructive_action',
  'ambiguity_resolution',
  'permission_request',
  'agent_stuck',
  'result_approval',
  'quality_override',
];

describe('DEFAULT_AUTONOMY_CONFIG', () => {
  it('has global level 3', () => {
    expect(DEFAULT_AUTONOMY_CONFIG.global).toBe(3);
  });

  it('defines rules for all 11 question types', () => {
    for (const qt of ALL_QUESTION_TYPES) {
      expect(DEFAULT_AUTONOMY_CONFIG.byQuestionType[qt]).toBeDefined();
    }
  });

  it('has byRun and byTask as null', () => {
    expect(DEFAULT_AUTONOMY_CONFIG.byRun).toBeNull();
    expect(DEFAULT_AUTONOMY_CONFIG.byTask).toBeNull();
  });

  it('sets destructive_action to level 3 with fail fallback', () => {
    const rule = DEFAULT_AUTONOMY_CONFIG.byQuestionType.destructive_action;
    expect(rule.level).toBe(3);
    expect(rule.fallbackAction).toBe('fail');
  });

  it('sets assignment_approval to level 2 with auto_approve fallback', () => {
    const rule = DEFAULT_AUTONOMY_CONFIG.byQuestionType.assignment_approval;
    expect(rule.level).toBe(2);
    expect(rule.fallbackAction).toBe('auto_approve');
  });

  it('sets clarification to level 2', () => {
    expect(DEFAULT_AUTONOMY_CONFIG.byQuestionType.clarification.level).toBe(2);
  });

  it('sets decomposition_approval to level 3 with 10 min timeout', () => {
    const rule = DEFAULT_AUTONOMY_CONFIG.byQuestionType.decomposition_approval;
    expect(rule.level).toBe(3);
    expect(rule.timeoutMs).toBe(10 * 60 * 1000);
  });
});

describe('getStrictConfig', () => {
  it('has global level 3', () => {
    const config = getStrictConfig();
    expect(config.global).toBe(3);
  });

  it('sets ALL question types to level 3', () => {
    const config = getStrictConfig();
    for (const qt of ALL_QUESTION_TYPES) {
      expect(config.byQuestionType[qt].level).toBe(3);
    }
  });

  it('sets ALL question types to fail fallback', () => {
    const config = getStrictConfig();
    for (const qt of ALL_QUESTION_TYPES) {
      expect(config.byQuestionType[qt].fallbackAction).toBe('fail');
    }
  });

  it('has byRun and byTask as null', () => {
    const config = getStrictConfig();
    expect(config.byRun).toBeNull();
    expect(config.byTask).toBeNull();
  });
});

describe('getAutonomousConfig', () => {
  it('has global level 1', () => {
    const config = getAutonomousConfig();
    expect(config.global).toBe(1);
  });

  it('sets all question types to level 1 except destructive_action', () => {
    const config = getAutonomousConfig();
    for (const qt of ALL_QUESTION_TYPES) {
      if (qt === 'destructive_action') {
        expect(config.byQuestionType[qt].level).toBe(3);
      } else {
        expect(config.byQuestionType[qt].level).toBe(1);
      }
    }
  });

  it('keeps destructive_action at level 3 (safety hardcoded)', () => {
    const config = getAutonomousConfig();
    expect(config.byQuestionType.destructive_action.level).toBe(3);
    expect(config.byQuestionType.destructive_action.fallbackAction).toBe('fail');
  });

  it('has byRun and byTask as null', () => {
    const config = getAutonomousConfig();
    expect(config.byRun).toBeNull();
    expect(config.byTask).toBeNull();
  });
});

describe('getAutoReviewOverrides', () => {
  it('returns result_approval at level 2 with auto_approve fallback', () => {
    const overrides = getAutoReviewOverrides();
    expect(overrides.result_approval).toBeDefined();
    expect(overrides.result_approval!.level).toBe(2);
    expect(overrides.result_approval!.fallbackAction).toBe('auto_approve');
    expect(overrides.result_approval!.timeoutMs).toBeNull();
  });

  it('only contains result_approval key', () => {
    const overrides = getAutoReviewOverrides();
    expect(Object.keys(overrides)).toEqual(['result_approval']);
  });
});

describe('getManualReviewOverrides', () => {
  it('returns result_approval at level 3 with fail fallback', () => {
    const overrides = getManualReviewOverrides();
    expect(overrides.result_approval).toBeDefined();
    expect(overrides.result_approval!.level).toBe(3);
    expect(overrides.result_approval!.fallbackAction).toBe('fail');
    expect(overrides.result_approval!.timeoutMs).toBeNull();
  });

  it('only contains result_approval key', () => {
    const overrides = getManualReviewOverrides();
    expect(Object.keys(overrides)).toEqual(['result_approval']);
  });
});
