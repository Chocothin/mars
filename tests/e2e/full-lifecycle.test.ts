import { describe, test, expect, afterAll } from 'bun:test';
import {
  createTask,
  getTask,
  patchTask,
  deleteTask,
  createRun,
  startRun,
  cancelRun,
  retryTask,
  pollUntil,
  waitForTaskStatus,
  getRun,
  PROJECT_ID,
  type Task,
} from './helpers';

const API = 'http://localhost:3001';
const TICK_WAIT = 10_000;

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

async function resumeRun(runId: string): Promise<void> {
  const res = await fetch(`${API}/api/runs/${runId}/resume`, { method: 'POST' });
  const json = await res.json();
  if (!json.success) throw new Error(`resumeRun failed: ${json.error}`);
}

describe('Full Lifecycle E2E', () => {
  test('TC-FULL-01: Create → Decompose → Execute → Fail → Retry → Complete', async () => {
    // Given: a parent task with no agent type (triggers decomposition)
    const parent = await createTask({
      title: '[E2E-Phase2] TC-FULL-01 Full Lifecycle',
      description: "Create a file called hello.txt containing 'Hello from MARS test'",
      status: 'backlog',
    });
    cleanup.tasks.push(parent.id);

    const run = await createRun([parent.id]);
    cleanup.runs.push(run.id);
    await startRun(run.id);

    // When: engine decomposes the parent into children
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
    console.log(`  Decomposed into ${children.length} children`);

    // When: we simulate child execution by patching statuses
    const firstChild = children[0];
    await patchTask(firstChild.id, { status: 'in_progress' });

    // Then: parent derives to in_progress (Rule A)
    const parentInProgress = await waitForTaskStatus(parent.id, 'in_progress', TICK_WAIT);
    expect(parentInProgress.status).toBe('in_progress');
    console.log(`  Parent correctly derived to in_progress`);

    // When: we force a child to failed and mark rest done
    await patchTask(firstChild.id, { status: 'failed' });
    for (const child of children.slice(1)) {
      await patchTask(child.id, { status: 'done' });
    }

    // Then: parent derives to failed (Rule B)
    const failedParent = await waitForTaskStatus(parent.id, 'failed', TICK_WAIT);
    expect(failedParent.status).toBe('failed');
    console.log(`  Parent correctly derived to failed`);

    // When: the run completes (all tasks terminal), wait for it
    await pollUntil(
      async () => {
        const r = await getRun(run.id);
        return r.status !== 'running';
      },
      TICK_WAIT,
      1_000,
    );

    // When: we retry the parent (resets failed leaves to ready/blocked)
    const retryResult = await retryTask(parent.id);
    expect(retryResult.success).toBe(true);
    console.log(`  Retried parent, retriedCount: ${retryResult.data.retriedCount}`);

    // Then: the failed child should be reset to ready/backlog
    const resetChild = await getTask(firstChild.id);
    expect(['ready', 'backlog']).toContain(resetChild.status);
    console.log(`  Child after retry: ${resetChild.status}`);

    // When: we mark the retried child as done
    await patchTask(firstChild.id, { status: 'done' });

    // Then: create a new run to trigger engine derivation for "all done" state
    const run2 = await createRun([parent.id]);
    cleanup.runs.push(run2.id);
    await startRun(run2.id);

    // Then: all children done → parent derives to done (Rule C)
    const doneParent = await waitForTaskStatus(parent.id, 'done', TICK_WAIT);
    expect(doneParent.status).toBe('done');
    console.log(`  Parent correctly derived to done`);

    await cancelRun(run2.id).catch(() => {});

    console.log(`✅ TC-FULL-01: Full lifecycle completed successfully`);
  }, 600_000);
});
