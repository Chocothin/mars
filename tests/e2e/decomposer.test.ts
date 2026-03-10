import { describe, test, expect, afterAll } from 'bun:test';
import {
  createTask,
  getTask,
  deleteTask,
  createRun,
  startRun,
  cancelRun,
  pollUntil,
  PROJECT_ID,
  type Task,
} from './helpers';

const API = 'http://localhost:3001';

const cleanup: { tasks: string[]; runs: string[] } = { tasks: [], runs: [] };

afterAll(async () => {
  for (const runId of cleanup.runs) {
    await cancelRun(runId).catch(() => {});
  }
  for (const id of [...cleanup.tasks].reverse()) {
    await deleteTask(id).catch(() => {});
  }
});

async function listChildren(parentId: string): Promise<Task[]> {
  const res = await fetch(`${API}/api/projects/${PROJECT_ID}/tasks?parentTaskId=${parentId}`);
  const json = await res.json();
  return json.data ?? [];
}

describe('Decomposer E2E', () => {
  let sharedParentId: string;
  let sharedRunId: string;
  let sharedChildren: Task[];

  test('TC-D01/D02: Decomposer marks, claims, and creates children', async () => {
    const parent = await createTask({
      title: '[E2E-Phase2] TC-D01 Decompose Me',
      description:
        "Create a simple hello world Node.js script that prints 'Hello MARS' to the console",
      status: 'backlog',
    });
    cleanup.tasks.push(parent.id);
    sharedParentId = parent.id;

    expect(parent.assignedAgentType).toEqual([]);
    expect(parent.status).toBe('backlog');

    const run = await createRun([parent.id]);
    cleanup.runs.push(run.id);
    sharedRunId = run.id;
    await startRun(run.id);

    await pollUntil(
      async () => {
        const children = await listChildren(parent.id);
        return children.length > 0;
      },
      120_000,
      2_000,
    );

    const children = await listChildren(parent.id);
    expect(children.length).toBeGreaterThanOrEqual(1);

    for (const child of children) {
      expect(child.parentTaskId).toBe(parent.id);
    }

    sharedChildren = children;

    console.log(
      `✅ TC-D01/D02: Parent decomposed into ${children.length} children`,
    );
    console.log(
      `   Children: ${children.map((c) => `"${c.title}" (${c.status})`).join(', ')}`,
    );
  }, 300_000);

  test('TC-D03: Children inherit correct parent and have valid structure', async () => {
    expect(sharedParentId).toBeDefined();
    expect(sharedChildren).toBeDefined();
    expect(sharedChildren.length).toBeGreaterThanOrEqual(1);

    const children = await listChildren(sharedParentId);
    expect(children.length).toBeGreaterThanOrEqual(1);

    for (const child of children) {
      expect(child.parentTaskId).toBe(sharedParentId);

      expect(child.assignedAgentType).toBeDefined();
      expect(Array.isArray(child.assignedAgentType)).toBe(true);
      expect(child.assignedAgentType.length).toBeGreaterThanOrEqual(1);

      expect(['backlog', 'blocked', 'ready', 'in_progress', 'done']).toContain(
        child.status,
      );

      expect(child.title).toBeTruthy();
    }

    console.log(`✅ TC-D03: All ${children.length} children have valid structure`);

    if (sharedRunId) {
      await cancelRun(sharedRunId).catch(() => {});
    }
  }, 30_000);
});
