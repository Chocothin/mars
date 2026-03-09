import { describe, it, expect } from 'bun:test';
import { TaskScheduler } from '../../orchestrator/scheduler';
import type { DependencyEdge, ExecutionPlan } from '../../orchestrator/types';

const scheduler = new TaskScheduler();

function edge(from: string, to: string, type: DependencyEdge['type'] = 'blocks'): DependencyEdge {
  return { fromTaskId: from, toTaskId: to, type };
}

describe('TaskScheduler', () => {
  describe('createPlan', () => {
    it('returns single batch for independent tasks', () => {
      const plan = scheduler.createPlan(['a', 'b', 'c'], []);

      expect(plan.batches).toHaveLength(1);
      expect(plan.batches[0]!.batchIndex).toBe(0);
      expect(plan.batches[0]!.taskIds).toEqual(expect.arrayContaining(['a', 'b', 'c']));
      expect(plan.dependencyGraph).toEqual([]);
    });

    it('creates linear chain A → B → C', () => {
      const deps = [edge('a', 'b'), edge('b', 'c')];
      const plan = scheduler.createPlan(['a', 'b', 'c'], deps);

      expect(plan.batches).toHaveLength(3);
      expect(plan.batches[0]!.taskIds).toEqual(['a']);
      expect(plan.batches[1]!.taskIds).toEqual(['b']);
      expect(plan.batches[2]!.taskIds).toEqual(['c']);
    });

    it('creates diamond: A → B,C → D', () => {
      const deps = [
        edge('a', 'b'),
        edge('a', 'c'),
        edge('b', 'd'),
        edge('c', 'd'),
      ];
      const plan = scheduler.createPlan(['a', 'b', 'c', 'd'], deps);

      expect(plan.batches).toHaveLength(3);
      expect(plan.batches[0]!.taskIds).toEqual(['a']);
      expect(plan.batches[1]!.taskIds).toEqual(expect.arrayContaining(['b', 'c']));
      expect(plan.batches[2]!.taskIds).toEqual(['d']);
    });

    it('creates wide parallel (all independent)', () => {
      const plan = scheduler.createPlan(['a', 'b', 'c', 'd', 'e'], []);

      expect(plan.batches).toHaveLength(1);
      expect(plan.batches[0]!.taskIds).toHaveLength(5);
    });

    it('handles single task', () => {
      const plan = scheduler.createPlan(['only'], []);

      expect(plan.batches).toHaveLength(1);
      expect(plan.batches[0]!.taskIds).toEqual(['only']);
    });

    it('handles empty input', () => {
      const plan = scheduler.createPlan([], []);

      expect(plan.batches).toHaveLength(0);
      expect(plan.dependencyGraph).toEqual([]);
    });

    it('throws on circular dependency (simple A ↔ B)', () => {
      const deps = [edge('a', 'b'), edge('b', 'a')];

      expect(() => scheduler.createPlan(['a', 'b'], deps)).toThrow(
        /Circular dependency/,
      );
    });

    it('throws on complex cycle (A → B → C → A)', () => {
      const deps = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];

      expect(() => scheduler.createPlan(['a', 'b', 'c'], deps)).toThrow(
        /Circular dependency/,
      );
    });

    it('filters out dependencies not in taskIds set', () => {
      const deps = [edge('a', 'b'), edge('b', 'x')];
      const plan = scheduler.createPlan(['a', 'b'], deps);

      expect(plan.batches).toHaveLength(2);
      expect(plan.dependencyGraph).toHaveLength(1);
    });

    it('treats informs edges as non-blocking in topological sort', () => {
      const deps = [
        edge('a', 'b', 'blocks'),
        edge('a', 'c', 'informs'),
      ];
      const plan = scheduler.createPlan(['a', 'b', 'c'], deps);

      expect(plan.batches[0]!.taskIds).toContain('a');
      expect(plan.batches[0]!.taskIds).toContain('c');
      expect(plan.batches[1]!.taskIds).toEqual(['b']);
    });
  });

  describe('detectCycles', () => {
    it('returns null when no cycles exist', () => {
      const result = scheduler.detectCycles([edge('a', 'b'), edge('b', 'c')]);
      expect(result).toBeNull();
    });

    it('returns cycle edges for simple cycle', () => {
      const result = scheduler.detectCycles([edge('a', 'b'), edge('b', 'a')]);
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(1);
      expect(result![0]!).toHaveLength(2);
    });

    it('returns null for empty dependencies', () => {
      expect(scheduler.detectCycles([])).toBeNull();
    });
  });

  describe('getNextBatch', () => {
    it('returns first batch when nothing completed', () => {
      const plan: ExecutionPlan = {
        batches: [
          { batchIndex: 0, taskIds: ['a'] },
          { batchIndex: 1, taskIds: ['b'] },
        ],
        dependencyGraph: [edge('a', 'b')],
      };

      const batch = scheduler.getNextBatch(plan, new Set());
      expect(batch).not.toBeNull();
      expect(batch!.taskIds).toEqual(['a']);
    });

    it('returns second batch when first is complete', () => {
      const plan: ExecutionPlan = {
        batches: [
          { batchIndex: 0, taskIds: ['a'] },
          { batchIndex: 1, taskIds: ['b'] },
        ],
        dependencyGraph: [edge('a', 'b')],
      };

      const batch = scheduler.getNextBatch(plan, new Set(['a']));
      expect(batch).not.toBeNull();
      expect(batch!.taskIds).toEqual(['b']);
    });

    it('returns null when all tasks are completed', () => {
      const plan: ExecutionPlan = {
        batches: [
          { batchIndex: 0, taskIds: ['a'] },
          { batchIndex: 1, taskIds: ['b'] },
        ],
        dependencyGraph: [edge('a', 'b')],
      };

      const batch = scheduler.getNextBatch(plan, new Set(['a', 'b']));
      expect(batch).toBeNull();
    });

    it('returns partial batch with only pending tasks', () => {
      const plan: ExecutionPlan = {
        batches: [
          { batchIndex: 0, taskIds: ['a', 'b', 'c'] },
        ],
        dependencyGraph: [],
      };

      const batch = scheduler.getNextBatch(plan, new Set(['a']));
      expect(batch).not.toBeNull();
      expect(batch!.taskIds).toEqual(['b', 'c']);
    });

    it('blocks batch when blocking dependency not met', () => {
      const plan: ExecutionPlan = {
        batches: [
          { batchIndex: 0, taskIds: ['a'] },
          { batchIndex: 1, taskIds: ['b'] },
        ],
        dependencyGraph: [edge('a', 'b')],
      };

      const batch = scheduler.getNextBatch(plan, new Set());
      expect(batch!.taskIds).toEqual(['a']);
    });
  });
});
