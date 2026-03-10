import { describe, test, expect, afterAll } from 'bun:test';
import {
  createTask,
  getTask,
  patchTask,
  retryTask,
  retryTaskRaw,
  deleteTask,
} from './helpers';

const cleanup: string[] = [];

afterAll(async () => {
  for (const id of cleanup) {
    await deleteTask(id).catch(() => {});
  }
});

describe('Retry Leaf Tasks', () => {
  test('TC-R01: Leaf retry happy path', async () => {
    const task = await createTask({
      title: '[E2E-Phase2] TC-R01 Leaf Retry',
      status: 'backlog',
    });
    cleanup.push(task.id);

    await patchTask(task.id, { status: 'failed' });

    const result = await retryTask(task.id);
    expect(result.success).toBe(true);
    expect(result.data.task.status).toBe('ready');
    expect(result.data.task.retryCount).toBe(0);
    expect(result.data.retriedCount).toBe(1);

    const fetched = await getTask(task.id);
    expect(fetched.status).toBe('ready');
    expect(fetched.assignedAgentId).toBeNull();
  });

  test('TC-R02: Leaf retry with unresolved deps → blocked', async () => {
    const dep = await createTask({
      title: '[E2E-Phase2] TC-R02 Dep',
      status: 'backlog',
    });
    cleanup.push(dep.id);

    const main = await createTask({
      title: '[E2E-Phase2] TC-R02 Blocked Retry',
      dependsOnTaskIds: [dep.id],
    });
    cleanup.push(main.id);

    expect(main.status).toBe('blocked');

    await patchTask(main.id, { status: 'failed' });

    const result = await retryTask(main.id);
    expect(result.success).toBe(true);
    expect(result.data.task.status).toBe('blocked');
  });

  test('TC-R03: Dep resolved after retry → blocked then ready', async () => {
    const dep = await createTask({
      title: '[E2E-Phase2] TC-R03 Dep',
      status: 'backlog',
    });
    cleanup.push(dep.id);

    const main = await createTask({
      title: '[E2E-Phase2] TC-R03 Dep Resolved',
      dependsOnTaskIds: [dep.id],
    });
    cleanup.push(main.id);

    await patchTask(main.id, { status: 'failed' });
    const r1 = await retryTask(main.id);
    expect(r1.data.task.status).toBe('blocked');

    await patchTask(dep.id, { status: 'done' });
    await patchTask(main.id, { status: 'failed' });

    const r2 = await retryTask(main.id);
    expect(r2.success).toBe(true);
    expect(r2.data.task.status).toBe('ready');
  });

  test('TC-R04: Retry non-failed task → 400', async () => {
    const task = await createTask({
      title: '[E2E-Phase2] TC-R04 Non-failed',
      status: 'backlog',
    });
    cleanup.push(task.id);

    const res1 = await retryTaskRaw(task.id);
    expect(res1.status).toBe(400);

    await patchTask(task.id, { status: 'done' });
    const res2 = await retryTaskRaw(task.id);
    expect(res2.status).toBe(400);
  });
});
