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
  for (const id of [...cleanup].reverse()) {
    await deleteTask(id).catch(() => {});
  }
});

describe('Retry Parent Tasks', () => {
  test('TC-R05: Parent retry → failed children retried', async () => {
    const parent = await createTask({
      title: '[E2E-Phase2] TC-R05 Parent',
      status: 'backlog',
    });
    cleanup.push(parent.id);

    const childA = await createTask({
      title: '[E2E-Phase2] TC-R05 Child A',
      parentTaskId: parent.id,
      status: 'backlog',
    });
    const childB = await createTask({
      title: '[E2E-Phase2] TC-R05 Child B',
      parentTaskId: parent.id,
      status: 'backlog',
    });
    const childC = await createTask({
      title: '[E2E-Phase2] TC-R05 Child C',
      parentTaskId: parent.id,
      status: 'backlog',
    });

    await patchTask(childA.id, { status: 'done' });
    await patchTask(childB.id, { status: 'failed' });
    await patchTask(childC.id, { status: 'failed' });

    const result = await retryTask(parent.id);
    expect(result.success).toBe(true);
    expect(result.data.retriedCount).toBe(2);

    const bAfter = await getTask(childB.id);
    const cAfter = await getTask(childC.id);
    const aAfter = await getTask(childA.id);

    expect(bAfter.status).toBe('ready');
    expect(cAfter.status).toBe('ready');
    expect(aAfter.status).toBe('done');
  });

  test('TC-R06: Parent retry with no failed children → 400', async () => {
    const parent = await createTask({
      title: '[E2E-Phase2] TC-R06 Parent',
      status: 'backlog',
    });
    cleanup.push(parent.id);

    const childA = await createTask({
      title: '[E2E-Phase2] TC-R06 Child A',
      parentTaskId: parent.id,
      status: 'backlog',
    });
    const childB = await createTask({
      title: '[E2E-Phase2] TC-R06 Child B',
      parentTaskId: parent.id,
      status: 'backlog',
    });

    await patchTask(childA.id, { status: 'done' });
    await patchTask(childB.id, { status: 'done' });

    const res = await retryTaskRaw(parent.id);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('No failed tasks to retry');
  });
});
