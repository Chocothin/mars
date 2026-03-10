import { describe, test, expect, afterAll } from 'bun:test';
import {
  createTask,
  getTask,
  patchTask,
  deleteTask,
  createRun,
  startRun,
  cancelRun,
  pollUntil,
  waitForTaskStatus,
} from './helpers';

const cleanup: { tasks: string[]; runs: string[] } = { tasks: [], runs: [] };

afterAll(async () => {
  for (const runId of cleanup.runs) {
    await cancelRun(runId).catch(() => {});
  }
  for (const id of [...cleanup.tasks].reverse()) {
    await deleteTask(id).catch(() => {});
  }
});

const TICK_WAIT = 6000;

describe('Parent Status Derivation', () => {
  test('TC-P01: Rule A — child in_progress → parent in_progress', async () => {
    const parent = await createTask({
      title: '[E2E-Phase2] TC-P01 Parent',
      status: 'backlog',
    });
    cleanup.tasks.push(parent.id);

    const childA = await createTask({
      title: '[E2E-Phase2] TC-P01 Child A',
      parentTaskId: parent.id,
      status: 'backlog',
      assignedAgentType: ['executor'],
    });
    const childB = await createTask({
      title: '[E2E-Phase2] TC-P01 Child B',
      parentTaskId: parent.id,
      status: 'backlog',
      assignedAgentType: ['executor'],
    });

    const run = await createRun([parent.id]);
    cleanup.runs.push(run.id);
    await startRun(run.id);

    await new Promise((r) => setTimeout(r, 3000));

    await patchTask(childA.id, { status: 'in_progress' });
    await patchTask(childB.id, { status: 'done' });

    const p = await waitForTaskStatus(parent.id, 'in_progress', TICK_WAIT);
    expect(p.status).toBe('in_progress');

    await cancelRun(run.id).catch(() => {});
  }, 20000);

  test('TC-P02: Rule B — child failed, none in_progress → parent failed', async () => {
    const parent = await createTask({
      title: '[E2E-Phase2] TC-P02 Parent',
      status: 'backlog',
    });
    cleanup.tasks.push(parent.id);

    const childA = await createTask({
      title: '[E2E-Phase2] TC-P02 Child A',
      parentTaskId: parent.id,
      status: 'backlog',
      assignedAgentType: ['executor'],
    });
    const childB = await createTask({
      title: '[E2E-Phase2] TC-P02 Child B',
      parentTaskId: parent.id,
      status: 'backlog',
      assignedAgentType: ['executor'],
    });

    const run = await createRun([parent.id]);
    cleanup.runs.push(run.id);
    await startRun(run.id);

    await new Promise((r) => setTimeout(r, 3000));

    await patchTask(childA.id, { status: 'done' });
    await patchTask(childB.id, { status: 'failed' });

    const p = await waitForTaskStatus(parent.id, 'failed', TICK_WAIT);
    expect(p.status).toBe('failed');

    await cancelRun(run.id).catch(() => {});
  }, 20000);

  test('TC-P03: Rule C — all children done → parent done', async () => {
    const parent = await createTask({
      title: '[E2E-Phase2] TC-P03 Parent',
      status: 'backlog',
    });
    cleanup.tasks.push(parent.id);

    const childA = await createTask({
      title: '[E2E-Phase2] TC-P03 Child A',
      parentTaskId: parent.id,
      status: 'backlog',
      assignedAgentType: ['executor'],
    });
    const childB = await createTask({
      title: '[E2E-Phase2] TC-P03 Child B',
      parentTaskId: parent.id,
      status: 'backlog',
      assignedAgentType: ['executor'],
    });

    const run = await createRun([parent.id]);
    cleanup.runs.push(run.id);
    await startRun(run.id);

    await new Promise((r) => setTimeout(r, 3000));

    await patchTask(childA.id, { status: 'done' });
    await patchTask(childB.id, { status: 'done' });

    const p = await waitForTaskStatus(parent.id, 'done', TICK_WAIT);
    expect(p.status).toBe('done');

    await cancelRun(run.id).catch(() => {});
  }, 20000);

  test('TC-P04: Rule D — all children ready → parent unchanged (not done/failed)', async () => {
    const parent = await createTask({
      title: '[E2E-Phase2] TC-P04 Parent',
      status: 'backlog',
    });
    cleanup.tasks.push(parent.id);

    const childA = await createTask({
      title: '[E2E-Phase2] TC-P04 Child A',
      parentTaskId: parent.id,
      status: 'backlog',
      assignedAgentType: ['executor'],
    });
    const childB = await createTask({
      title: '[E2E-Phase2] TC-P04 Child B',
      parentTaskId: parent.id,
      status: 'backlog',
      assignedAgentType: ['executor'],
    });

    const run = await createRun([parent.id]);
    cleanup.runs.push(run.id);
    await startRun(run.id);

    await new Promise((r) => setTimeout(r, 5000));

    const p = await getTask(parent.id);
    expect(p.status).not.toBe('done');
    expect(p.status).not.toBe('failed');
    expect(p.status).not.toBe('in_progress');

    await cancelRun(run.id).catch(() => {});
  }, 15000);

  test('TC-P05: EC2 — Parent deps unresolved → blocked override', async () => {
    const prereq = await createTask({
      title: '[E2E-Phase2] TC-P05 Prereq',
      status: 'backlog',
      assignedAgentType: ['executor'],
    });
    cleanup.tasks.push(prereq.id);

    const parent = await createTask({
      title: '[E2E-Phase2] TC-P05 Parent',
      status: 'backlog',
      dependsOnTaskIds: [prereq.id],
    });
    cleanup.tasks.push(parent.id);

    expect(parent.status).toBe('blocked');

    const childA = await createTask({
      title: '[E2E-Phase2] TC-P05 Child A',
      parentTaskId: parent.id,
      status: 'backlog',
      assignedAgentType: ['executor'],
    });

    await patchTask(childA.id, { status: 'in_progress' });

    const run = await createRun([parent.id]);
    cleanup.runs.push(run.id);
    await startRun(run.id);

    await new Promise((r) => setTimeout(r, 5000));

    let p = await getTask(parent.id);
    expect(p.status).toBe('blocked');

    await patchTask(prereq.id, { status: 'done' });

    await new Promise((r) => setTimeout(r, 5000));

    p = await getTask(parent.id);
    expect(p.status).toBe('in_progress');

    await cancelRun(run.id).catch(() => {});
  }, 25000);
});
