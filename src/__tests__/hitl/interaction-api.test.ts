import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { initDatabase, getDb } from '../../db/index';
import { InteractionStore } from '../../hitl/interaction-store';
import { InteractionGate } from '../../hitl/interaction-gate';
import { InteractionAPI } from '../../hitl/interaction-api';
import { InteractionSSE } from '../../hitl/interaction-sse';
import { DEFAULT_APPROVAL_CONFIG } from '../../hitl/simple-config';
import { eventBus } from '../../events/bus';
import type { Interaction, InteractionResponse } from '../../hitl/types';

interface ApiBody {
  success: boolean;
  data?: any;
  error?: string;
}

async function json(res: Response): Promise<ApiBody> {
  return (await res.json()) as ApiBody;
}

let store: InteractionStore;
let gate: InteractionGate;
let api: InteractionAPI;

function makeUrl(path: string, params?: Record<string, string>): URL {
  const url = new URL(`http://localhost:3001${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

function makeRequest(method: string, body?: unknown): Request {
  const opts: RequestInit = { method };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers = { 'Content-Type': 'application/json' };
  }
  return new Request('http://localhost:3001', opts);
}

async function createLevel3Interaction(runId: string): Promise<string> {
  gate.request({
    type: 'destructive_action',
    runId,
    question: {
      title: 'Delete files?',
      description: 'About to delete important files',
      payload: { files: ['a.txt'] },
      suggestedAction: 'approve',
      suggestedMessage: null,
      options: null,
    },
  }).catch(() => {});

  await new Promise((r) => setTimeout(r, 20));

  const ids = gate.getPendingIds();
  const id = ids[ids.length - 1];
  if (!id) throw new Error('No pending interaction created');
  return id;
}

async function createLevel2Interaction(runId: string): Promise<string> {
  await gate.request({
    type: 'clarification',
    runId,
    question: {
      title: 'Clarification needed',
      description: 'What format?',
      payload: {},
      suggestedAction: 'answer',
      suggestedMessage: 'Use JSON',
      options: null,
    },
  });

  const interactions = await store.getByRunId(runId);
  const last = interactions[interactions.length - 1];
  if (!last) throw new Error('No interaction created');
  return last.id;
}

beforeAll(async () => {
  process.env.MARS_DB_PATH = ':memory:';
  initDatabase();
  store = new InteractionStore({ db: getDb(), dataDir: '/tmp/mars-test-interaction-api' });
  await store.initialize();
});

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM interactions');
  gate = new InteractionGate({ store, config: DEFAULT_APPROVAL_CONFIG });
  api = new InteractionAPI({ store, gate });
});

afterEach(() => {
  gate.dispose();
});

describe('InteractionAPI', () => {
  describe('handleList', () => {
    it('lists all interactions when runId is missing', async () => {
      await createLevel2Interaction('run-list-all-1');
      await createLevel3Interaction('run-list-all-2');

      const url = makeUrl('/api/interactions');
      const res = await api.handleList(url);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });

    it('returns empty array for unknown runId', async () => {
      const url = makeUrl('/api/interactions', { runId: 'unknown-run' });
      const res = await api.handleList(url);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('lists interactions for a given runId', async () => {
      const runId = 'run-list-1';
      await createLevel2Interaction(runId);
      await createLevel2Interaction(runId);

      const url = makeUrl('/api/interactions', { runId });
      const res = await api.handleList(url);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });

    it('filters by status', async () => {
      const runId = 'run-list-filter';
      await createLevel2Interaction(runId);
      await createLevel3Interaction(runId);

      const url = makeUrl('/api/interactions', { runId, status: 'pending' });
      const res = await api.handleList(url);
      const body = await json(res);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].status).toBe('pending');
    });

    it('returns 400 for invalid status filter', async () => {
      const url = makeUrl('/api/interactions', { runId: 'run-1', status: 'invalid' });
      const res = await api.handleList(url);
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain('Invalid status');
    });
  });

  describe('handleGet', () => {
    it('returns 404 for non-existent interaction', async () => {
      const res = await api.handleGet('nonexistent-id');
      expect(res.status).toBe(404);
      const body = await json(res);
      expect(body.success).toBe(false);
    });

    it('returns interaction by id', async () => {
      const id = await createLevel2Interaction('run-get-1');
      const res = await api.handleGet(id);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(id);
      expect(body.data.runId).toBe('run-get-1');
    });
  });

  describe('handleRespond', () => {
    it('returns 404 for non-existent interaction', async () => {
      const req = makeRequest('POST', { action: 'approve' });
      const res = await api.handleRespond('nonexistent', req);
      expect(res.status).toBe(404);
    });

    it('returns 400 for non-Level-3 interaction', async () => {
      const id = await createLevel2Interaction('run-respond-level2');
      const req = makeRequest('POST', { action: 'approve' });
      const res = await api.handleRespond(id, req);
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain('Level 3');
    });

    it('returns 400 for invalid JSON body', async () => {
      const id = await createLevel3Interaction('run-respond-badjson');
      const req = new Request('http://localhost:3001', {
        method: 'POST',
        body: 'not json',
        headers: { 'Content-Type': 'application/json' },
      });
      const res = await api.handleRespond(id, req);
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain('Invalid JSON');
    });

    it('returns 400 when action is missing', async () => {
      const id = await createLevel3Interaction('run-respond-noaction');
      const req = makeRequest('POST', { message: 'ok' });
      const res = await api.handleRespond(id, req);
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain('action');
    });

    it('returns 400 for invalid action value', async () => {
      const id = await createLevel3Interaction('run-respond-badaction');
      const req = makeRequest('POST', { action: 'invalid_action' });
      const res = await api.handleRespond(id, req);
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain('action must be one of');
    });

    it('successfully responds to a pending Level 3 interaction', async () => {
      const id = await createLevel3Interaction('run-respond-ok');
      const req = makeRequest('POST', { action: 'approve', message: 'Looks good' });
      const res = await api.handleRespond(id, req);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('responded');
      expect(body.data.response.action).toBe('approve');
      expect(body.data.response.respondedBy).toBe('human');
    });

    it('returns 409 when interaction is already responded', async () => {
      const id = await createLevel3Interaction('run-respond-twice');
      const req1 = makeRequest('POST', { action: 'approve' });
      await api.handleRespond(id, req1);

      const req2 = makeRequest('POST', { action: 'reject' });
      const res = await api.handleRespond(id, req2);
      expect(res.status).toBe(409);
      const body = await json(res);
      expect(body.error).toContain('not pending');
    });

    it('accepts modifiedPayload for modify action', async () => {
      const id = await createLevel3Interaction('run-respond-modify');
      const req = makeRequest('POST', {
        action: 'modify',
        message: 'Changed plan',
        modifiedPayload: { newPlan: true },
      });
      const res = await api.handleRespond(id, req);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.data.response.action).toBe('modify');
      expect(body.data.response.modifiedPayload).toEqual({ newPlan: true });
    });
  });

});

describe('InteractionSSE', () => {
  let sse: InteractionSSE;

  beforeEach(() => {
    sse = new InteractionSSE();
  });

  afterEach(() => {
    sse.stop();
    eventBus.removeAllListeners();
  });

  it('starts with zero clients', () => {
    expect(sse.getClientCount()).toBe(0);
  });

  it('creates an SSE stream response with correct headers', () => {
    const controller = new AbortController();
    const req = new Request('http://localhost:3001/api/interactions/stream', {
      signal: controller.signal,
    });

    const res = sse.createStream(req, null);

    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('Connection')).toBe('keep-alive');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(sse.getClientCount()).toBe(1);

    controller.abort();
  });

  it('sends connected event on stream creation', async () => {
    const controller = new AbortController();
    const req = new Request('http://localhost:3001/api/interactions/stream', {
      signal: controller.signal,
    });

    const res = sse.createStream(req, null);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    expect(text).toContain('event: connected');
    expect(text).toContain('"timestamp"');

    controller.abort();
    reader.releaseLock();
  });

  it('broadcasts hitl events to connected clients', async () => {
    sse.start();

    const controller = new AbortController();
    const req = new Request('http://localhost:3001/api/interactions/stream', {
      signal: controller.signal,
    });

    const res = sse.createStream(req, null);
    const reader = res.body!.getReader();

    await reader.read();

    eventBus.emit({
      type: 'hitl:created',
      interactionId: 'test-id',
      runId: 'run-sse-1',
      taskId: null,
      questionType: 'clarification',
      level: 3,
      question: {
        title: 'Test?',
        description: 'Test question',
        payload: {},
        suggestedAction: 'approve',
        suggestedMessage: null,
        options: null,
      },
      timeoutMs: null,
      expiresAt: null,
      priority: 'normal',
    });

    await new Promise((r) => setTimeout(r, 50));

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    expect(text).toContain('event: hitl:created');
    expect(text).toContain('test-id');

    controller.abort();
    reader.releaseLock();
  });

  it('filters events by runId when client subscribes with runId', async () => {
    sse.start();

    const controller = new AbortController();
    const req = new Request('http://localhost:3001/api/interactions/stream', {
      signal: controller.signal,
    });

    const res = sse.createStream(req, 'run-filter-1');
    const reader = res.body!.getReader();

    await reader.read();

    eventBus.emit({
      type: 'hitl:cancelled',
      interactionId: 'other-id',
      runId: 'run-filter-OTHER',
      reason: 'cancelled',
    });

    eventBus.emit({
      type: 'hitl:cancelled',
      interactionId: 'matching-id',
      runId: 'run-filter-1',
      reason: 'cancelled',
    });

    await new Promise((r) => setTimeout(r, 50));

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    expect(text).toContain('matching-id');
    expect(text).not.toContain('other-id');

    controller.abort();
    reader.releaseLock();
  });

  it('does not broadcast non-hitl events', async () => {
    sse.start();

    const controller = new AbortController();
    const req = new Request('http://localhost:3001/api/interactions/stream', {
      signal: controller.signal,
    });

    const res = sse.createStream(req, null);
    const reader = res.body!.getReader();

    await reader.read();

    eventBus.emit({
      type: 'run:created',
      runId: 'run-nonhitl',
      projectId: 'proj-1',
    });

    await new Promise((r) => setTimeout(r, 50));

    const readPromise = Promise.race([
      reader.read().then((r) => r.value),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
    ]);

    const value = await readPromise;
    if (value) {
      const text = new TextDecoder().decode(value);
      expect(text).not.toContain('run:created');
    }

    controller.abort();
    reader.releaseLock();
  });

  it('removes client on abort', async () => {
    const controller = new AbortController();
    const req = new Request('http://localhost:3001/api/interactions/stream', {
      signal: controller.signal,
    });

    sse.createStream(req, null);
    expect(sse.getClientCount()).toBe(1);

    controller.abort();
    await new Promise((r) => setTimeout(r, 50));

    expect(sse.getClientCount()).toBe(0);
  });

  it('stop() clears all clients and unsubscribes', () => {
    sse.start();

    const controller1 = new AbortController();
    const controller2 = new AbortController();

    sse.createStream(
      new Request('http://localhost:3001', { signal: controller1.signal }),
      null,
    );
    sse.createStream(
      new Request('http://localhost:3001', { signal: controller2.signal }),
      null,
    );

    expect(sse.getClientCount()).toBe(2);

    sse.stop();

    expect(sse.getClientCount()).toBe(0);

    controller1.abort();
    controller2.abort();
  });
});
