import { describe, test, expect, afterAll, beforeAll } from 'bun:test';
import { initDatabase } from '../../src/db/index';
import { TaskService } from '../../src/tasks/service';
import { getTaskById, updateTask, deleteTask, insertTask } from '../../src/db/task-repo';
import { randomUUID } from 'node:crypto';

const PROJECT_ID = '81054c4e-33cc-42da-82c7-674e40c9bd4a';
const service = new TaskService();
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

describe('retry-service unit tests', () => {
  test('T1: Leaf retry — failed → ready (deps all done)', async () => {
    const task = await createTestTask({ title: '[Unit-Phase2] T1 leaf retry' });
    updateTask(task.id, { status: 'failed' });

    const result = await service.retryTask(PROJECT_ID, task.id);
    expect(result.task.status).toBe('ready');
    expect(result.task.retryCount).toBe(0);
    expect(result.retriedCount).toBe(1);
  });

  test('T2: Leaf retry — failed → blocked (unresolved deps)', async () => {
    const dep = await createTestTask({ title: '[Unit-Phase2] T2 dep task' });
    // dep stays in backlog (not done) → unresolved dependency

    const main = await createTestTask({
      title: '[Unit-Phase2] T2 main task',
      dependsOnTaskIds: [dep.id],
    });
    // main should be auto-blocked due to dep not being done
    updateTask(main.id, { status: 'failed' });

    const result = await service.retryTask(PROJECT_ID, main.id);
    expect(result.task.status).toBe('blocked');
    expect(result.retriedCount).toBe(1);
  });

  test('T3: Leaf retry — non-failed → error', async () => {
    const task = await createTestTask({ title: '[Unit-Phase2] T3 non-failed' });
    updateTask(task.id, { status: 'ready' });

    expect(service.retryTask(PROJECT_ID, task.id)).rejects.toThrow('Task is not in failed status');
  });

  test('T4: Parent retry — failed children retried', async () => {
    const parent = await createTestTask({ title: '[Unit-Phase2] T4 parent' });

    const child1 = await createTestTask({
      title: '[Unit-Phase2] T4 child done',
      parentTaskId: parent.id,
    });
    updateTask(child1.id, { status: 'done' });

    const child2 = await createTestTask({
      title: '[Unit-Phase2] T4 child failed 1',
      parentTaskId: parent.id,
    });
    updateTask(child2.id, { status: 'failed' });

    const child3 = await createTestTask({
      title: '[Unit-Phase2] T4 child failed 2',
      parentTaskId: parent.id,
    });
    updateTask(child3.id, { status: 'failed' });

    const result = await service.retryTask(PROJECT_ID, parent.id);
    expect(result.retriedCount).toBe(2);

    const c1 = getTaskById(PROJECT_ID, child1.id)!;
    expect(c1.status).toBe('done'); // unchanged

    const c2 = getTaskById(PROJECT_ID, child2.id)!;
    expect(c2.status).toBe('ready');

    const c3 = getTaskById(PROJECT_ID, child3.id)!;
    expect(c3.status).toBe('ready');
  });

  test('T5: Parent retry — no failed children → error', async () => {
    const parent = await createTestTask({ title: '[Unit-Phase2] T5 parent' });

    const child1 = await createTestTask({
      title: '[Unit-Phase2] T5 child done 1',
      parentTaskId: parent.id,
    });
    updateTask(child1.id, { status: 'done' });

    const child2 = await createTestTask({
      title: '[Unit-Phase2] T5 child done 2',
      parentTaskId: parent.id,
    });
    updateTask(child2.id, { status: 'done' });

    expect(service.retryTask(PROJECT_ID, parent.id)).rejects.toThrow('No failed tasks to retry');
  });

  test('T6: Parent retry — nested hierarchy (grandchild)', async () => {
    const parent = await createTestTask({ title: '[Unit-Phase2] T6 grandparent' });

    const child = await createTestTask({
      title: '[Unit-Phase2] T6 child (mid)',
      parentTaskId: parent.id,
    });

    const now = Date.now();
    const grandchildId = randomUUID();
    const grandchild = {
      id: grandchildId,
      projectId: PROJECT_ID,
      parentTaskId: child.id,
      title: '[Unit-Phase2] T6 grandchild failed',
      description: '',
      status: 'failed' as const,
      priority: 'medium' as const,
      order: 0,
      assignedAgentType: ['worker'],
      assignedAgentId: null,
      dependsOnTaskIds: [],
      acceptanceCriteria: [],
      expectedOutputs: [],
      maxRetries: 2,
      retryCount: 0,
      reviewFeedback: null,
      createdAt: now,
      updatedAt: now,
    };
    insertTask(grandchild);
    cleanup.push(grandchildId);

    const result = await service.retryTask(PROJECT_ID, parent.id);
    expect(result.retriedCount).toBe(1);

    const gc = getTaskById(PROJECT_ID, grandchildId)!;
    expect(gc.status).toBe('ready');
  });
});
