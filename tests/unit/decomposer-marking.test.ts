import { describe, test, expect, afterAll, beforeAll } from 'bun:test';
import { initDatabase } from '../../src/db/index';
import { TaskService } from '../../src/tasks/service';
import { getTaskById, updateTask, deleteTask } from '../../src/db/task-repo';
import { ReactiveScheduler } from '../../src/orchestrator/reactive-scheduler';

const PROJECT_ID = '8d521bc0-b621-45e1-a07f-8f5a106a0a9f';
const service = new TaskService();
const scheduler = new ReactiveScheduler();
const cleanup: string[] = [];

beforeAll(() => {
  initDatabase();
});

afterAll(async () => {
  for (const id of [...cleanup].reverse()) {
    try {
      deleteTask(PROJECT_ID, id);
    } catch {}
  }
});

describe('decomposer-marking unit tests', () => {
  test('D1: Undecomposed task → marked with decomposer', async () => {
    const task = await service.create(PROJECT_ID, {
      title: '[Unit-Phase2] D1 undecomposed',
      status: 'backlog',
    });
    cleanup.push(task.id);

    expect(task.assignedAgentType).toEqual([]);

    const marked = scheduler.markUndecomposedForDecomposer([task.id]);
    expect(marked).toContain(task.id);

    const updated = getTaskById(PROJECT_ID, task.id)!;
    expect(updated.assignedAgentType).toEqual(['decomposer']);
  });

  test('D2: Already marked → skip', async () => {
    const task = await service.create(PROJECT_ID, {
      title: '[Unit-Phase2] D2 already marked',
      status: 'backlog',
      assignedAgentType: ['decomposer'],
    });
    cleanup.push(task.id);

    const marked = scheduler.markUndecomposedForDecomposer([task.id]);
    expect(marked).toEqual([]);
  });

  test('D3: Task with children → skip', async () => {
    const parent = await service.create(PROJECT_ID, {
      title: '[Unit-Phase2] D3 parent with child',
      status: 'backlog',
    });
    cleanup.push(parent.id);

    const child = await service.create(PROJECT_ID, {
      title: '[Unit-Phase2] D3 child',
      status: 'backlog',
      parentTaskId: parent.id,
    });
    cleanup.push(child.id);

    const marked = scheduler.markUndecomposedForDecomposer([parent.id]);
    expect(marked).toEqual([]);
  });
});
