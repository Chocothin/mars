import { describe, test, expect, afterAll, beforeAll } from 'bun:test';
import { initDatabase } from '../../src/db/index';
import { TaskService } from '../../src/tasks/service';
import { getTaskById, deleteTask } from '../../src/db/task-repo';
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

describe('findDecomposableTasks unit tests', () => {
  test('D1: Undecomposed task (no children, no agent) → found', async () => {
    const task = await service.create(PROJECT_ID, {
      title: '[Unit-Phase2] D1 undecomposed',
      status: 'backlog',
    });
    cleanup.push(task.id);

    const found = scheduler.findDecomposableTasks([task.id]);
    expect(found.map(t => t.id)).toContain(task.id);
  });

  test('D2: Task with assignedAgentType → excluded', async () => {
    const task = await service.create(PROJECT_ID, {
      title: '[Unit-Phase2] D2 has agent type',
      status: 'backlog',
      assignedAgentType: ['backend'],
    });
    cleanup.push(task.id);

    const found = scheduler.findDecomposableTasks([task.id]);
    expect(found.map(t => t.id)).not.toContain(task.id);
  });

  test('D3: Task with children → excluded', async () => {
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

    const found = scheduler.findDecomposableTasks([parent.id]);
    expect(found.map(t => t.id)).not.toContain(parent.id);
  });

  test('D4: Done/cancelled/failed tasks → excluded', async () => {
    const done = await service.create(PROJECT_ID, {
      title: '[Unit-Phase2] D4 done',
      status: 'backlog',
    });
    cleanup.push(done.id);
    await service.update(PROJECT_ID, done.id, { status: 'done' });

    const failed = await service.create(PROJECT_ID, {
      title: '[Unit-Phase2] D4 failed',
      status: 'backlog',
    });
    cleanup.push(failed.id);
    await service.update(PROJECT_ID, failed.id, { status: 'failed' });

    const found = scheduler.findDecomposableTasks([done.id, failed.id]);
    expect(found).toEqual([]);
  });

  test('D5: Deps-resolved tasks come first', async () => {
    const dep = await service.create(PROJECT_ID, {
      title: '[Unit-Phase2] D5 dependency',
      status: 'backlog',
    });
    cleanup.push(dep.id);
    await service.update(PROJECT_ID, dep.id, { status: 'done' });

    const blockedTask = await service.create(PROJECT_ID, {
      title: '[Unit-Phase2] D5 blocked',
      status: 'blocked',
      dependsOnTaskIds: [dep.id],
    });
    cleanup.push(blockedTask.id);

    const freeTask = await service.create(PROJECT_ID, {
      title: '[Unit-Phase2] D5 free',
      status: 'ready',
    });
    cleanup.push(freeTask.id);

    const found = scheduler.findDecomposableTasks([blockedTask.id, freeTask.id]);
    const ids = found.map(t => t.id);
    if (ids.includes(freeTask.id) && ids.includes(blockedTask.id)) {
      expect(ids.indexOf(freeTask.id)).toBeLessThan(ids.indexOf(blockedTask.id));
    }
  });
});
