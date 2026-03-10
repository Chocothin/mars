const API = 'http://localhost:3001';
const PROJECT_ID = '8d521bc0-b621-45e1-a07f-8f5a106a0a9f';

// ─── Types ───

interface TaskInput {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  parentTaskId?: string;
  dependsOnTaskIds?: string[];
  assignedAgentType?: string[];
  acceptanceCriteria?: string[];
  expectedOutputs?: string[];
  maxRetries?: number;
}

interface TaskPatchInput {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  order?: number;
  assignedAgentType?: string[] | null;
  assignedAgentId?: string | null;
  retryCount?: number;
  maxRetries?: number;
}

export interface Task {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  title: string;
  description: string;
  status: string;
  priority: string;
  order: number;
  assignedAgentType: string[];
  assignedAgentId: string | null;
  dependsOnTaskIds: string[];
  acceptanceCriteria: string[];
  expectedOutputs: string[];
  maxRetries: number;
  retryCount: number;
  reviewFeedback: string | null;
  createdAt: number;
  updatedAt: number;
  assignedAgentName: string | null;
}

export interface RetryResult {
  success: boolean;
  data: {
    task: Task;
    retriedCount: number;
  };
}

// ─── Helpers ───

export async function createTask(input: TaskInput): Promise<Task> {
  const res = await fetch(`${API}/api/projects/${PROJECT_ID}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`createTask failed: ${json.error}`);
  return json.data;
}

export async function getTask(taskId: string): Promise<Task> {
  const res = await fetch(`${API}/api/projects/${PROJECT_ID}/tasks/${taskId}`);
  const json = await res.json();
  if (!json.success) throw new Error(`getTask failed: ${json.error}`);
  return json.data;
}

export async function patchTask(taskId: string, input: TaskPatchInput): Promise<Task> {
  const res = await fetch(`${API}/api/projects/${PROJECT_ID}/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`patchTask failed: ${json.error}`);
  return json.data;
}

export async function retryTask(taskId: string): Promise<RetryResult> {
  const res = await fetch(`${API}/api/projects/${PROJECT_ID}/tasks/${taskId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const json = await res.json();
  return json;
}

export async function retryTaskRaw(taskId: string): Promise<Response> {
  return fetch(`${API}/api/projects/${PROJECT_ID}/tasks/${taskId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function deleteTask(taskId: string): Promise<void> {
  const res = await fetch(`${API}/api/projects/${PROJECT_ID}/tasks/${taskId}`, {
    method: 'DELETE',
  });
  // Ignore errors during cleanup
  await res.json().catch(() => {});
}

export async function createRun(taskIds: string[]): Promise<any> {
  const res = await fetch(`${API}/api/projects/${PROJECT_ID}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`createRun failed: ${json.error}`);
  return json.data;
}

export async function startRun(runId: string): Promise<void> {
  const res = await fetch(`${API}/api/runs/${runId}/start`, { method: 'POST' });
  const json = await res.json();
  if (!json.success) throw new Error(`startRun failed: ${json.error}`);
}

export async function getRun(runId: string): Promise<any> {
  const res = await fetch(`${API}/api/runs/${runId}`);
  const json = await res.json();
  if (!json.success) throw new Error(`getRun failed: ${json.error}`);
  return json.data;
}

export async function cancelRun(runId: string): Promise<void> {
  const res = await fetch(`${API}/api/runs/${runId}/cancel`, { method: 'POST' });
  await res.json().catch(() => {});
}

export async function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs = 10000,
  intervalMs = 500,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

export async function waitForTaskStatus(
  taskId: string,
  status: string,
  timeoutMs = 10000,
): Promise<Task> {
  let task!: Task;
  await pollUntil(async () => {
    task = await getTask(taskId);
    return task.status === status;
  }, timeoutMs);
  return task;
}

export { PROJECT_ID };
