import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { handleTerminalRoutes } from '../../routes/terminal';
import { initDatabase, getDb } from '../../db/index';

type SessionSummary = {
  id: string;
  projectId: string;
  agentId: string;
  mcpServerIds: string[];
  status: string;
  cliSessionId: string | null;
  restartRequired: boolean;
  restartReason: string | null;
  restartMarkedAt: number | null;
};

type SessionAccessResponse = {
  success: boolean;
  data: {
    session: SessionSummary;
    accessToken: string;
  };
};

type SessionResponse = {
  success: boolean;
  data: SessionSummary;
};

type ActivityResponse = {
  success: boolean;
  data: {
    sessionId: string;
    runId: string | null;
    runStatus: string | null;
    heartbeatStatus: string | null;
    heartbeatLastSeenAt: number | null;
    currentTaskId: string | null;
    currentTaskTitle: string | null;
    latestExecutionStatus: string | null;
    latestExecutionTimestamp: number | null;
  };
};

type SessionListResponse = {
  success: boolean;
  data: SessionSummary[];
};

type EmptyResponse = {
  success: boolean;
};

let sessionId: string;
let sessionWithSingleOverrideId: string;
let isolatedSessionId: string;

beforeAll(async () => {
  process.env.MARS_DB_PATH = ':memory:';
  await initDatabase();

  const now = Date.now();
  getDb().exec(
    `INSERT INTO providers (id, name, provider_type, auth_method, enabled, is_default, config, created_at, updated_at)
     VALUES ('test-provider', 'Test Provider', 'anthropic', 'oauth', 1, 1, '{}', ${now}, ${now})`,
  );

  getDb().exec(
    `INSERT INTO agents (id, name, provider_id, model_id, system_prompt, reasoning_level, mcp_server_ids, enabled, created_at, updated_at)
      VALUES ('test-agent', 'Test Agent', 'test-provider', 'claude-3-5-sonnet', '', 'none', '[]', 1, ${now}, ${now})`,
  );

  getDb().exec(
    `INSERT INTO agents (id, name, provider_id, model_id, system_prompt, reasoning_level, mcp_server_ids, enabled, created_at, updated_at)
      VALUES ('test-agent-2', 'Test Agent 2', 'test-provider', 'claude-3-5-sonnet', '', 'none', '[]', 1, ${now}, ${now})`,
  );
  getDb().exec(`UPDATE agents SET worker_count = 3 WHERE id = 'test-agent-2'`);

  getDb().exec(
    `INSERT INTO projects (id, name, directory_path, status, agent_ids, mcp_server_ids, created_at, updated_at)
      VALUES ('test-project', 'Test Project', '/tmp', 'active', '["test-agent"]', '[]', ${now}, ${now})`,
  );

  getDb().exec(
    `INSERT INTO projects (id, name, directory_path, status, agent_ids, mcp_server_ids, created_at, updated_at)
      VALUES ('test-project-2', 'Test Project 2', '/tmp', 'active', '["test-agent-2"]', '[]', ${now}, ${now})`,
  );

  getDb().exec(
    `INSERT INTO mcp_servers (id, name, description, transport_type, command, args, url, headers, env, enabled, created_at, updated_at)
      VALUES ('mcp-a', 'MCP A', '', 'stdio', 'node', '["a.js"]', NULL, '{}', '{}', 1, ${now}, ${now})`,
  );

  getDb().exec(
    `INSERT INTO mcp_servers (id, name, description, transport_type, command, args, url, headers, env, enabled, created_at, updated_at)
      VALUES ('mcp-b', 'MCP B', '', 'stdio', 'node', '["b.js"]', NULL, '{}', '{}', 1, ${now}, ${now})`,
  );
});

afterAll(() => {
  // In-memory DB is auto-cleaned
});

async function callRoute(method: string, path: string, body?: unknown): Promise<Response | null> {
  const url = new URL('http://localhost' + path);
  const init: RequestInit = { method };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const req = new Request(url.toString(), init);
  return handleTerminalRoutes(req, url);
}

describe('Terminal API Routes', () => {
  describe('POST /api/terminal/sessions', () => {
    it('valid body returns 201 with session', async () => {
      const response = await callRoute('POST', '/api/terminal/sessions', {
        projectId: 'test-project',
        agentId: 'test-agent',
      });

      expect(response).not.toBeNull();
      expect(response!.status).toBe(201);

      const data = (await response!.json()) as SessionAccessResponse;
      expect(data.success).toBe(true);
      expect(data.data.session.id).toBeDefined();
      expect(data.data.session.projectId).toBe('test-project');
      expect(data.data.session.agentId).toBe('test-agent');
      expect(data.data.session.mcpServerIds).toEqual([]);
      expect(data.data.session.status).toBe('idle');
      expect(data.data.session.restartRequired).toBe(false);
      expect(typeof data.data.accessToken).toBe('string');

      sessionId = data.data.session.id;
    });

    it('missing projectId returns 400', async () => {
      const response = await callRoute('POST', '/api/terminal/sessions', {
        agentId: 'test-agent',
      });

      expect(response).not.toBeNull();
      expect(response!.status).toBe(400);

      const data = (await response!.json()) as EmptyResponse;
      expect(data.success).toBe(false);
    });

    it('missing agentId returns 400', async () => {
      const response = await callRoute('POST', '/api/terminal/sessions', {
        projectId: 'test-project',
      });

      expect(response).not.toBeNull();
      expect(response!.status).toBe(400);

      const data = (await response!.json()) as EmptyResponse;
      expect(data.success).toBe(false);
    });

    it('invalid JSON returns 400', async () => {
      const url = new URL('http://localhost/api/terminal/sessions');
      const req = new Request(url.toString(), {
        method: 'POST',
        body: 'invalid json',
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await handleTerminalRoutes(req, url);
      expect(response).not.toBeNull();
      expect(response!.status).toBe(400);
    });

    it('non-existent agent returns 404', async () => {
      const response = await callRoute('POST', '/api/terminal/sessions', {
        projectId: 'test-project',
        agentId: 'non-existent-agent',
      });

      expect(response).not.toBeNull();
      expect(response!.status).toBe(404);

      const data = (await response!.json()) as EmptyResponse;
      expect(data.success).toBe(false);
    });

    it('accepts and persists session-specific mcpServerIds', async () => {
      const response = await callRoute('POST', '/api/terminal/sessions', {
        projectId: 'test-project-2',
        agentId: 'test-agent-2',
        mcpServerIds: ['mcp-a'],
      });

      expect(response).not.toBeNull();
      expect(response!.status).toBe(201);

      const data = (await response!.json()) as SessionAccessResponse;
      expect(data.success).toBe(true);
      expect(data.data.session.mcpServerIds).toEqual(['mcp-a']);
      sessionWithSingleOverrideId = data.data.session.id;
    });

    it('creates a separate session for a different MCP override set', async () => {
      const response = await callRoute('POST', '/api/terminal/sessions', {
        projectId: 'test-project-2',
        agentId: 'test-agent-2',
        mcpServerIds: ['mcp-a', 'mcp-b'],
      });

      expect(response).not.toBeNull();
      expect(response!.status).toBe(201);

      const data = (await response!.json()) as SessionAccessResponse;
      expect(data.success).toBe(true);
      expect(data.data.session.id).not.toBe(sessionWithSingleOverrideId);
      expect(data.data.session.mcpServerIds).toEqual(['mcp-a', 'mcp-b']);
      isolatedSessionId = data.data.session.id;
    });

    it('reuses an existing session when the MCP override set matches', async () => {
      const response = await callRoute('POST', '/api/terminal/sessions', {
        projectId: 'test-project-2',
        agentId: 'test-agent-2',
        mcpServerIds: ['mcp-a'],
      });

      expect(response).not.toBeNull();
      expect(response!.status).toBe(201);

      const data = (await response!.json()) as SessionAccessResponse;
      expect(data.success).toBe(true);
      expect(data.data.session.id).toBe(sessionWithSingleOverrideId);
      expect(data.data.session.mcpServerIds).toEqual(['mcp-a']);
    });

    it('invalid mcpServerIds shape returns 400', async () => {
      const response = await callRoute('POST', '/api/terminal/sessions', {
        projectId: 'test-project',
        agentId: 'test-agent',
        mcpServerIds: 'mcp-a',
      });

      expect(response).not.toBeNull();
      expect(response!.status).toBe(400);
    });
  });

  describe('GET /api/terminal/sessions', () => {
    it('list all returns 200 with paginated results', async () => {
      const response = await callRoute('GET', '/api/terminal/sessions');

      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);

      const data = (await response!.json()) as SessionListResponse;
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);
    });

    it('returns separate sessions for different MCP override sets', async () => {
      const response = await callRoute('GET', '/api/terminal/sessions?projectId=test-project-2&agentId=test-agent-2');

      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);

      const data = (await response!.json()) as SessionListResponse;
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(2);
      expect(data.data.some((session) => session.id === sessionWithSingleOverrideId)).toBe(true);
      expect(data.data.some((session) => session.id === isolatedSessionId)).toBe(true);
    });

    it('filter by projectId returns matching sessions', async () => {
      const response = await callRoute('GET', '/api/terminal/sessions?projectId=test-project');

      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);

      const data = (await response!.json()) as SessionListResponse;
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.every((session) => session.projectId === 'test-project')).toBe(true);
    });

    it('with limit and offset params returns paginated results', async () => {
      const response = await callRoute('GET', '/api/terminal/sessions?limit=5&offset=0');

      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);

      const data = (await response!.json()) as SessionListResponse;
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
    });
  });

  describe('GET /api/terminal/sessions/:id', () => {
    it('existing session returns 200', async () => {
      const response = await callRoute('GET', `/api/terminal/sessions/${sessionId}`);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);

      const data = (await response!.json()) as SessionResponse;
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(sessionId);
      expect(data.data.projectId).toBe('test-project');
      expect(data.data.agentId).toBe('test-agent');
      expect(data.data.restartRequired).toBe(false);
      expect('accessToken' in data.data).toBe(false);
    });

    it('non-existent session returns 404', async () => {
      const response = await callRoute('GET', '/api/terminal/sessions/non-existent-id');

      expect(response).not.toBeNull();
      expect(response!.status).toBe(404);

      const data = (await response!.json()) as EmptyResponse;
      expect(data.success).toBe(false);
    });
  });

  describe('POST /api/terminal/sessions/:id/access', () => {
    it('returns a scoped access payload for terminal recovery', async () => {
      const response = await callRoute('POST', `/api/terminal/sessions/${sessionId}/access`);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);

      const data = (await response!.json()) as SessionAccessResponse;
      expect(data.success).toBe(true);
      expect(data.data.session.id).toBe(sessionId);
      expect(typeof data.data.accessToken).toBe('string');
    });
  });

  describe('GET /api/terminal/sessions/:id/activity', () => {
    it('returns a compact activity summary for the terminal session', async () => {
      const now = Date.now();
      const taskId = `task-terminal-activity-${now}`;
      const runId = `run-terminal-activity-${now}`;
      const executionId = `exec-terminal-activity-${now}`;

      getDb().exec(
        `INSERT INTO tasks (id, project_id, parent_task_id, title, description, status, priority, "order", assigned_agent_type, assigned_agent_id, created_at, updated_at)
         VALUES ('${taskId}', 'test-project-2', NULL, 'Inspect live activity', '', 'in_progress', 'medium', 0, NULL, 'test-agent-2', ${now}, ${now})`,
      );

      getDb().exec(
        `INSERT INTO runs (id, project_id, root_task_ids, status, config, execution_plan, result, created_at, started_at, completed_at)
         VALUES ('${runId}', 'test-project-2', '["${taskId}"]', 'running', '{"maxConcurrency":1,"maxRetries":1,"timeoutMs":1000,"taskTimeoutMs":1000,"autoReview":false,"requireHumanApproval":false,"hitl":null}', NULL, NULL, ${now}, ${now}, NULL)`,
      );

      getDb().exec(
        `INSERT INTO task_executions (id, run_id, task_id, agent_id, session_id, status, attempt, input, output, started_at, completed_at, duration_ms, error)
         VALUES ('${executionId}', '${runId}', '${taskId}', 'test-agent-2', '${isolatedSessionId}', 'running', 1, '{}', NULL, ${now}, NULL, NULL, NULL)`,
      );

      getDb().exec(
        `INSERT INTO agent_heartbeats (agent_id, run_id, status, current_task_id, last_seen, started_at)
         VALUES ('test-agent-2', '${runId}', 'working', '${taskId}', ${now}, ${now})`,
      );

      const response = await callRoute('GET', `/api/terminal/sessions/${isolatedSessionId}/activity`);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);

      const data = (await response!.json()) as ActivityResponse;
      expect(data.success).toBe(true);
      expect(data.data.sessionId).toBe(isolatedSessionId);
      expect(data.data.runId).toBe(runId);
      expect(data.data.runStatus).toBe('running');
      expect(data.data.heartbeatStatus).toBe('working');
      expect(data.data.heartbeatLastSeenAt).toBe(now);
      expect(data.data.currentTaskId).toBe(taskId);
      expect(data.data.currentTaskTitle).toBe('Inspect live activity');
      expect(data.data.latestExecutionStatus).toBe('running');
      expect(data.data.latestExecutionTimestamp).toBe(now);
    });

    it('does not attribute heartbeat-only activity from another session', async () => {
      const now = Date.now() + 1;
      const taskId = `task-heartbeat-only-${now}`;
      const runId = `run-heartbeat-only-${now}`;

      getDb().exec(
        `INSERT INTO tasks (id, project_id, parent_task_id, title, description, status, priority, "order", assigned_agent_type, assigned_agent_id, created_at, updated_at)
         VALUES ('${taskId}', 'test-project', NULL, 'Heartbeat only task', '', 'in_progress', 'medium', 0, NULL, 'test-agent', ${now}, ${now})`,
      );

      getDb().exec(
        `INSERT INTO runs (id, project_id, root_task_ids, status, config, execution_plan, result, created_at, started_at, completed_at)
         VALUES ('${runId}', 'test-project', '["${taskId}"]', 'running', '{"maxConcurrency":1,"maxRetries":1,"timeoutMs":1000,"taskTimeoutMs":1000,"autoReview":false,"requireHumanApproval":false,"hitl":null}', NULL, NULL, ${now}, ${now}, NULL)`,
      );

      getDb().exec(
        `INSERT INTO agent_heartbeats (agent_id, run_id, status, current_task_id, last_seen, started_at)
         VALUES ('test-agent', '${runId}', 'working', '${taskId}', ${now}, ${now})`,
      );

      const response = await callRoute('GET', `/api/terminal/sessions/${sessionId}/activity`);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);

      const data = (await response!.json()) as ActivityResponse;
      expect(data.success).toBe(true);
      expect(data.data.sessionId).toBe(sessionId);
      expect(data.data.runId).toBeNull();
      expect(data.data.runStatus).toBeNull();
      expect(data.data.heartbeatStatus).toBeNull();
      expect(data.data.heartbeatLastSeenAt).toBeNull();
      expect(data.data.currentTaskId).toBeNull();
      expect(data.data.currentTaskTitle).toBeNull();
      expect(data.data.latestExecutionStatus).toBeNull();
      expect(data.data.latestExecutionTimestamp).toBeNull();
    });

    it('prefers the most recent execution over older running rows', async () => {
      const base = Date.now() + 2;
      const olderTaskId = `task-older-running-${base}`;
      const newerTaskId = `task-newer-completed-${base}`;
      const runId = `run-recency-${base}`;

      getDb().exec(
        `INSERT INTO tasks (id, project_id, parent_task_id, title, description, status, priority, "order", assigned_agent_type, assigned_agent_id, created_at, updated_at)
         VALUES ('${olderTaskId}', 'test-project-2', NULL, 'Older running task', '', 'in_progress', 'medium', 0, NULL, 'test-agent-2', ${base}, ${base})`,
      );
      getDb().exec(
        `INSERT INTO tasks (id, project_id, parent_task_id, title, description, status, priority, "order", assigned_agent_type, assigned_agent_id, created_at, updated_at)
         VALUES ('${newerTaskId}', 'test-project-2', NULL, 'Newer completed task', '', 'done', 'medium', 1, NULL, 'test-agent-2', ${base + 1}, ${base + 1})`,
      );

      getDb().exec(
        `INSERT INTO runs (id, project_id, root_task_ids, status, config, execution_plan, result, created_at, started_at, completed_at)
         VALUES ('${runId}', 'test-project-2', '["${olderTaskId}","${newerTaskId}"]', 'running', '{"maxConcurrency":1,"maxRetries":1,"timeoutMs":1000,"taskTimeoutMs":1000,"autoReview":false,"requireHumanApproval":false,"hitl":null}', NULL, NULL, ${base}, ${base}, NULL)`,
      );

      getDb().exec(
        `INSERT INTO task_executions (id, run_id, task_id, agent_id, session_id, status, attempt, input, output, started_at, completed_at, duration_ms, error)
         VALUES ('exec-older-running-${base}', '${runId}', '${olderTaskId}', 'test-agent-2', '${sessionWithSingleOverrideId}', 'running', 1, '{}', NULL, ${base}, NULL, NULL, NULL)`,
      );
      getDb().exec(
        `INSERT INTO task_executions (id, run_id, task_id, agent_id, session_id, status, attempt, input, output, started_at, completed_at, duration_ms, error)
         VALUES ('exec-newer-completed-${base}', '${runId}', '${newerTaskId}', 'test-agent-2', '${sessionWithSingleOverrideId}', 'completed', 1, '{}', '{}', ${base + 10}, ${base + 20}, 10, NULL)`,
      );

      const response = await callRoute('GET', `/api/terminal/sessions/${sessionWithSingleOverrideId}/activity`);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);

      const data = (await response!.json()) as ActivityResponse;
      expect(data.success).toBe(true);
      expect(data.data.runId).toBe(runId);
      expect(data.data.currentTaskId).toBe(newerTaskId);
      expect(data.data.currentTaskTitle).toBe('Newer completed task');
      expect(data.data.latestExecutionStatus).toBe('completed');
      expect(data.data.latestExecutionTimestamp).toBe(base + 20);
    });
  });

  describe('GET /api/terminal/sessions/:id/messages', () => {
    it('empty messages returns 200 with empty array', async () => {
      const response = await callRoute('GET', `/api/terminal/sessions/${sessionId}/messages`);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);

      const data = (await response!.json()) as SessionListResponse;
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBe(0);
    });
  });

  describe('DELETE /api/terminal/sessions/:id/messages', () => {
    it('clear messages returns 200', async () => {
      const response = await callRoute('DELETE', `/api/terminal/sessions/${sessionId}/messages`);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);

      const data = (await response!.json()) as EmptyResponse;
      expect(data.success).toBe(true);
    });
  });

  describe('DELETE /api/terminal/sessions/:id', () => {
    it('existing session returns 200', async () => {
      const response = await callRoute('DELETE', `/api/terminal/sessions/${sessionId}`);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);

      const data = (await response!.json()) as EmptyResponse;
      expect(data.success).toBe(true);
    });

    it('non-existent session returns 404', async () => {
      const response = await callRoute('DELETE', '/api/terminal/sessions/non-existent-id');

      expect(response).not.toBeNull();
      expect(response!.status).toBe(404);

      const data = (await response!.json()) as EmptyResponse;
      expect(data.success).toBe(false);
    });
  });

  describe('POST /api/terminal/sessions/:id/restart', () => {
    it('clears restart-required state and cli session id', async () => {
      const restartMarkedAt = Date.now();
      getDb().exec(
        `UPDATE terminal_sessions
         SET cli_session_id = 'cli-old', restart_required = 1, restart_reason = 'Need restart', restart_marked_at = ${restartMarkedAt}
         WHERE id = '${isolatedSessionId}'`,
      );

      const response = await callRoute('POST', `/api/terminal/sessions/${isolatedSessionId}/restart`);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);

      const data = (await response!.json()) as SessionAccessResponse;
      expect(data.success).toBe(true);
      expect(data.data.session.id).toBe(isolatedSessionId);
      expect(data.data.session.cliSessionId).toBeNull();
      expect(data.data.session.restartRequired).toBe(false);
      expect(data.data.session.restartReason).toBeNull();
      expect(data.data.session.restartMarkedAt).toBeNull();
      expect(typeof data.data.accessToken).toBe('string');
    });
  });

  describe('Non-terminal paths', () => {
    it('non-matching path returns null', async () => {
      const response = await callRoute('GET', '/api/other/path');

      expect(response).toBeNull();
    });
  });
});
