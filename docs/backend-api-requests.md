# Backend API Requests Queue

Use this file as the frontend->backend handoff queue.

Format:
- Requester session:
- Page:
- Needed endpoint:
- Required request params/body:
- Expected response shape:
- Priority:

---

- Requester session: Frontend Session 1 (R01-R05 API binding)
- Page: /app-shell (R01)
- Needed endpoint: GET /api/dashboard/summary
- Required request params/body: Optional `projectId` filter; no body.
- Expected response shape: `{ success: true, data: { projectCount: number, activeProjectCount: number, totalTaskCount: number, activeAgentCount: number, mcpOnline: number, mcpTotal: number, recentActivity: Array<{ title: string, detail: string, timestamp: string }>, health: { provider: string, mcp: string, memory: string } } }`
- Priority: High
- Status: Done (`/api/dashboard/summary` implemented and `/app-shell` integrated)

- Requester session: Frontend Session 1 (R01-R05 API binding)
- Page: /tasks and /tasks/[id] (R02)
- Needed endpoint: GET /api/tasks and GET /api/tasks/:id (global, non-project-scoped)
- Required request params/body: Query params for list: `projectId?`, `status?`, `priority?`, `search?`, `limit?`, `offset?`; no body.
- Expected response shape: `{ success: true, data: Task[], total: number, limit: number, offset: number }` for list and `{ success: true, data: Task }` for detail, where Task includes `projectId`, `title`, `description`, `status`, `priority`, `assignedAgentType`, `createdAt`, `updatedAt`.
- Priority: High
- Status: Done (`/api/projects/:projectId/dag` implemented and `/dag` integrated)

---

- Requester session: Frontend Session 3 (R11-R15 API binding)
- Page: `/mcp/[id]/edit` (R11)
- Needed endpoint: `GET /api/mcp-servers/by-name/:name` (or `GET /api/mcp-servers?name=` exact filter)
- Required request params/body: `name` (URL-safe slug/name used by route param)
- Expected response shape:
  ```json
  {
    "success": true,
    "data": {
      "id": "uuid",
      "name": "GitHub Copilot MCP",
      "description": "...",
      "transportType": "stdio",
      "command": "npx ...",
      "args": ["--flag", "value"],
      "env": { "KEY": "VALUE" },
      "enabled": true
    }
  }
  ```
- Priority: High

- Requester session: Frontend Session 3 (R11-R15 API binding)
- Page: `/tasks/new` (R13)
- Needed endpoint: `GET /api/options/task-create?projectId=...`
- Required request params/body: optional `projectId`; when omitted, backend should return sensible global defaults
- Expected response shape:
  ```json
  {
    "success": true,
    "data": {
      "statuses": ["backlog", "blocked", "ready", "in_progress", "review", "done"],
      "priorities": ["low", "medium", "high", "urgent"],
      "agents": [{ "id": "a1", "name": "CodeReviewer" }],
      "parentTasks": [{ "id": "t1", "title": "Parent task" }],
      "defaultAssigneeId": "a1"
    }
  }
  ```
- Priority: Medium

- Requester session: Frontend Session 3 (R11-R15 API binding)
- Page: `/agents/new` (R14)
- Needed endpoint: `GET /api/options/agent-create`
- Required request params/body: none
- Expected response shape:
  ```json
  {
    "success": true,
    "data": {
      "providers": [
        {
          "id": "p1",
          "name": "Claude",
          "models": [{ "id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4" }]
        }
      ],
      "mcpServers": [{ "id": "m1", "name": "GitHub" }],
      "skills": [{ "id": "s1", "name": "Code Review" }],
      "defaults": {
        "providerId": "p1",
        "modelId": "claude-sonnet-4-20250514",
        "reasoningLevel": "medium"
      }
    }
  }
  ```
- Priority: Medium
- Status: Done (`/api/options/agent-create` implemented and `/agents/new` integrated)

- Requester session: Frontend Session 3 (R11-R15 API binding)
- Page: `/dag` (R15)
- Needed endpoint: `GET /api/projects/:projectId/dag`
- Required request params/body: `projectId`; optional `runId` to pin a specific run snapshot
- Expected response shape:
  ```json
  {
    "success": true,
    "data": {
      "pipeline": {
        "runId": "run_123",
        "name": "research-pipeline-v2",
        "status": "running",
        "step": 5,
        "totalSteps": 8,
        "elapsedMs": 154000
      },
      "stats": {
        "totalTokens": 284302,
        "avgLatencyMs": 1800,
        "estimatedCostUsd": 0.42,
        "activeNodes": 3,
        "totalNodes": 8
      },
      "graph": {
        "nodes": [
          {
            "id": "n1",
            "label": "Code Agent",
            "kind": "agent",
            "status": "running",
            "x": 600,
            "y": 228,
            "progress": 0.62,
            "detail": "Running... 62%"
          }
        ],
        "edges": [{ "from": "n1", "to": "n2", "label": "" }]
      },
      "selectedNode": {
        "id": "n1",
        "metrics": { "tokens": 42180, "latencyMs": 2100, "costUsd": 0.08, "steps": 12 },
        "lastInput": "{...}",
        "lastOutput": "Generating ..."
      },
      "logs": [
        {
          "timestamp": 1710000000000,
          "level": "info",
          "message": "Router dispatched parallel group"
        }
      ]
    }
  }
  ```
- Priority: High

---

- Requester session: Frontend Session 2 (R06-R10 API binding)
- Page: `/provider` (R07)
- Needed endpoint: `GET /api/providers/:id/usage`
- Required request params/body: `:id` provider id; optional query `from`, `to`, `granularity=day|hour`
- Expected response shape:
  - `{ providerId, totals: { requests, tokens, costUsd, avgLatencyMs }, trend: [{ ts, requests, tokens, costUsd, avgLatencyMs }] }`
- Priority: High

- Requester session: Frontend Session 2 (R06-R10 API binding)
- Page: `/provider` (R07)
- Needed endpoint: `GET /api/providers/:id/activity`
- Required request params/body: `:id` provider id; optional query `limit`, `cursor`, `types[]`
- Expected response shape:
  - `{ providerId, items: [{ id, type, model, tokens, costUsd, latencyMs, timestamp }], pageInfo: { nextCursor } }`
- Priority: High

- Requester session: Frontend Session 2 (R06-R10 API binding)
- Page: `/tasks/[id]` (R09)
- Needed endpoint: `GET /api/tasks/:id`
- Required request params/body: `:id` global task id (no project id required)
- Expected response shape:
  - `{ task: { id, projectId, title, description, status, priority, assignee, labels, createdAt, updatedAt, dueAt, subtasks: [{ id, title, status, assignee, updatedAt }] } }`
- Priority: High

- Requester session: Frontend Session 2 (R06-R10 API binding)
- Page: `/tasks` + `/tasks/[id]` (R09)
- Needed endpoint: `GET /api/tasks`
- Required request params/body: query `projectId?`, `status?`, `priority?`, `search?`, `limit?`, `cursor?`
- Expected response shape:
  - `{ items: [{ id, projectId, title, status, priority, assignee, updatedAt }], pageInfo: { nextCursor, total } }`
- Priority: Medium

- Requester session: Frontend Session 2 (R06-R10 API binding)
- Page: `/agents/[id]` (R10)
- Needed endpoint: `GET /api/pages/agents/:id/composite`
- Required request params/body: `:id` agent id
- Expected response shape:
  - `{ agent: { ... }, mcpServers: [{ id, name, type, status, description }], skills: [{ id, name, category, description }], logs: [{ id, level, source, message, timestamp }] }`
- Priority: Medium

- Requester session: Ralph Infinite Parity Session B (R06-R10 targeted polish)
- Page: `/projects/[id]` (R08)
- Needed endpoint: `GET /api/projects/:id/runs`
- Required request params/body: `:id` project id; optional `limit`, `cursor`, `status`
- Expected response shape:
  - `{ runs: [{ id, status, type, level, time, startedAt, message, summary }], pageInfo: { nextCursor, total } }`
- Priority: High

- Requester session: Ralph Infinite Parity Session B (R06-R10 targeted polish)
- Page: `/tasks/[id]` (R09)
- Needed endpoint: `GET /api/projects/:projectId/tasks/:taskId/subtasks`
- Required request params/body: `:projectId`, `:taskId`; optional `limit`, `cursor`
- Expected response shape:
  - `{ subtasks: [{ id, title, status, assignedAgent, assignee, updatedAt }], pageInfo: { nextCursor, total } }`
- Priority: High

- Requester session: Ralph Infinite Parity Session B (R06-R10 targeted polish)
- Page: `/tasks/[id]` (R09)
- Needed endpoint: `GET /api/projects/:projectId/tasks/:taskId/activity`
- Required request params/body: `:projectId`, `:taskId`; optional `limit`, `cursor`, `types[]`
- Expected response shape:
  - `{ activity: [{ id, type, level, message, event, time, updatedAt }], pageInfo: { nextCursor, total } }`
- Priority: High

- Requester session: Ralph Infinite Parity Session B (R06-R10 targeted polish)
- Page: `/agents/[id]` (R10)
- Needed endpoint: `GET /api/agents/:id/logs`
- Required request params/body: `:id` agent id; optional `limit`, `cursor`, `level`
- Expected response shape:
  - `{ logs: [{ id, time, timestamp, level, message, event }], pageInfo: { nextCursor, total } }`
- Priority: Medium
