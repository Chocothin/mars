import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_AUTONOMY_CONFIG,
  getStrictConfig,
  getAutonomousConfig,
  getAutoReviewOverrides,
  getManualReviewOverrides,
} from '../../hitl/default-config';
import type { QuestionType } from '../../hitl/types';

const ALL_QUESTION_TYPES: QuestionType[] = [
  'clarification',
  'destructive_action',
  'ambiguity_resolution',
  'permission_request',
  'agent_stuck',
  'task_review',
];

describe('DEFAULT_AUTONOMY_CONFIG', () => {
  it('has global level 3', () => {
    expect(DEFAULT_AUTONOMY_CONFIG.global).toBe(3);
  });

  it('defines rules for all question types', () => {
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

  it('sets clarification to level 2', () => {
    expect(DEFAULT_AUTONOMY_CONFIG.byQuestionType.clarification.level).toBe(2);
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
});

describe('getAutoReviewOverrides', () => {
  it('returns empty object (deprecated)', () => {
    const overrides = getAutoReviewOverrides();
    expect(Object.keys(overrides)).toEqual([]);
  });
});

describe('getManualReviewOverrides', () => {
  it('returns empty object (deprecated)', () => {
    const overrides = getManualReviewOverrides();
    expect(Object.keys(overrides)).toEqual([]);
  });
});
