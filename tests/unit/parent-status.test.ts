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

async function createTestTask(overrides: {
  title: string;
  parentTaskId?: string;
  status?: string;
  dependsOnTaskIds?: string[];
  assignedAgentType?: string[];
}) {
  const task = await service.create(PROJECT_ID, {
    title: overrides.title,
    status: overrides.status as any ?? 'backlog',
    parentTaskId: overrides.parentTaskId,
    dependsOnTaskIds: overrides.dependsOnTaskIds,
    assignedAgentType: overrides.assignedAgentType ?? ['worker'],
  });
  cleanup.push(task.id);
  return task;
}

describe('parent-status unit tests', () => {
  test('P1: child in_progress → parent in_progress', async () => {
    const parent = await createTestTask({ title: '[Unit-Phase2] P1 parent' });
    const child1 = await createTestTask({ title: '[Unit-Phase2] P1 child1', parentTaskId: parent.id });
    const child2 = await createTestTask({ title: '[Unit-Phase2] P1 child2', parentTaskId: parent.id });

    updateTask(child1.id, { status: 'in_progress' });
    updateTask(child2.id, { status: 'ready' });

    const changed = scheduler.refreshParentStatuses([parent.id]);
    expect(changed).toContain(parent.id);

    const p = getTaskById(PROJECT_ID, parent.id)!;
    expect(p.status).toBe('in_progress');
  });

  test('P2: child failed, none in_progress → parent failed', async () => {
    const parent = await createTestTask({ title: '[Unit-Phase2] P2 parent' });
    const child1 = await createTestTask({ title: '[Unit-Phase2] P2 child1', parentTaskId: parent.id });
    const child2 = await createTestTask({ title: '[Unit-Phase2] P2 child2', parentTaskId: parent.id });

    updateTask(child1.id, { status: 'failed' });
    updateTask(child2.id, { status: 'done' });

    const changed = scheduler.refreshParentStatuses([parent.id]);
    expect(changed).toContain(parent.id);

    const p = getTaskById(PROJECT_ID, parent.id)!;
    expect(p.status).toBe('failed');
  });

  test('P3: all children done → parent done', async () => {
    const parent = await createTestTask({ title: '[Unit-Phase2] P3 parent' });
    const child1 = await createTestTask({ title: '[Unit-Phase2] P3 child1', parentTaskId: parent.id });
    const child2 = await createTestTask({ title: '[Unit-Phase2] P3 child2', parentTaskId: parent.id });

    updateTask(child1.id, { status: 'done' });
    updateTask(child2.id, { status: 'done' });

    const changed = scheduler.refreshParentStatuses([parent.id]);
    expect(changed).toContain(parent.id);

    const p = getTaskById(PROJECT_ID, parent.id)!;
    expect(p.status).toBe('done');
  });

  test('P4: all children ready → no change', async () => {
    const parent = await createTestTask({ title: '[Unit-Phase2] P4 parent' });
    const child1 = await createTestTask({ title: '[Unit-Phase2] P4 child1', parentTaskId: parent.id });
    const child2 = await createTestTask({ title: '[Unit-Phase2] P4 child2', parentTaskId: parent.id });

    updateTask(child1.id, { status: 'ready' });
    updateTask(child2.id, { status: 'ready' });
    updateTask(parent.id, { status: 'ready' });

    const changed = scheduler.refreshParentStatuses([parent.id]);
    expect(changed).not.toContain(parent.id);

    const p = getTaskById(PROJECT_ID, parent.id)!;
    expect(p.status).toBe('ready');
  });

  test('P5: parent deps unresolved → blocked (no change despite children)', async () => {
    const blocker = await createTestTask({ title: '[Unit-Phase2] P5 blocker' });
    const parent = await createTestTask({
      title: '[Unit-Phase2] P5 parent',
      dependsOnTaskIds: [blocker.id],
    });
    const child1 = await createTestTask({ title: '[Unit-Phase2] P5 child1', parentTaskId: parent.id });

    updateTask(child1.id, { status: 'in_progress' });

    const changed = scheduler.refreshParentStatuses([parent.id]);
    expect(changed).not.toContain(parent.id);
  });

  test('P6: no children (undecomposed) → no change', async () => {
    const parent = await createTestTask({ title: '[Unit-Phase2] P6 no children' });
    updateTask(parent.id, { status: 'ready' });

    const changed = scheduler.refreshParentStatuses([parent.id]);
    expect(changed).not.toContain(parent.id);

    const p = getTaskById(PROJECT_ID, parent.id)!;
    expect(p.status).toBe('ready');
  });

  test('P7: done + cancelled mix → parent done', async () => {
    const parent = await createTestTask({ title: '[Unit-Phase2] P7 parent' });
    const child1 = await createTestTask({ title: '[Unit-Phase2] P7 child1', parentTaskId: parent.id });
    const child2 = await createTestTask({ title: '[Unit-Phase2] P7 child2', parentTaskId: parent.id });

    updateTask(child1.id, { status: 'done' });
    updateTask(child2.id, { status: 'cancelled' });

    const changed = scheduler.refreshParentStatuses([parent.id]);
    expect(changed).toContain(parent.id);

    const p = getTaskById(PROJECT_ID, parent.id)!;
    expect(p.status).toBe('done');
  });

  test('P8: retry → child changes (done + ready) → no change (Rule D)', async () => {
    const parent = await createTestTask({ title: '[Unit-Phase2] P8 parent' });
    const child1 = await createTestTask({ title: '[Unit-Phase2] P8 child1', parentTaskId: parent.id });
    const child2 = await createTestTask({ title: '[Unit-Phase2] P8 child2', parentTaskId: parent.id });

    updateTask(child1.id, { status: 'done' });
    updateTask(child2.id, { status: 'ready' });
    updateTask(parent.id, { status: 'ready' });

    const changed = scheduler.refreshParentStatuses([parent.id]);
    expect(changed).not.toContain(parent.id);

    const p = getTaskById(PROJECT_ID, parent.id)!;
    expect(p.status).toBe('ready');
  });
});
