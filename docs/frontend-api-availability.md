# Frontend API Availability Map

Backend server entry: `src/index.ts` (Bun, default `:3001`).

## Available APIs (can be wired now)

### Projects
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:id`
- `PATCH /api/projects/:id`
- `DELETE /api/projects/:id`

### Tasks (project-scoped)
- `GET /api/projects/:projectId/tasks`
- `POST /api/projects/:projectId/tasks`
- `GET /api/projects/:projectId/tasks/:taskId`
- `PATCH /api/projects/:projectId/tasks/:taskId`
- `DELETE /api/projects/:projectId/tasks/:taskId`
- `GET /api/projects/:projectId/tasks/:taskId/dependencies`
- `POST /api/projects/:projectId/tasks/:taskId/dependencies`
- `DELETE /api/projects/:projectId/tasks/:taskId/dependencies/:depTaskId`

### Agents
- `GET /api/agents`
- `POST /api/agents`
- `GET /api/agents/:id`
- `PATCH /api/agents/:id`
- `DELETE /api/agents/:id`

### MCP Servers
- `GET /api/mcp-servers`
- `POST /api/mcp-servers`
- `GET /api/mcp-servers/:id`
- `PATCH /api/mcp-servers/:id`
- `DELETE /api/mcp-servers/:id`

### Providers
- `GET /api/providers`
- `POST /api/providers`
- `GET /api/providers/default`
- `GET /api/providers/:id`
- `PATCH /api/providers/:id`
- `DELETE /api/providers/:id`
- `POST /api/providers/:id/test-connection`
- `GET /api/providers/:id/models`
- `GET /api/providers/:id/health`

### Skills
- `GET /api/skills`
- `POST /api/skills`
- `GET /api/skills/:id`
- `PATCH /api/skills/:id`
- `DELETE /api/skills/:id`

### Memory
- `GET /api/memory`
- `POST /api/memory`
- `GET /api/memory/:id`
- `PATCH /api/memory/:id`
- `DELETE /api/memory/:id`
- `GET /api/memory/stats`
- `GET /api/memory/compact/targets`
- `POST /api/memory/compact/estimate`
- `POST /api/memory/compact`

### Runs / DAG
- `POST /api/projects/:projectId/runs`
- `GET /api/projects/:projectId/runs`
- `GET /api/runs/:runId`
- `POST /api/runs/:runId/start`
- `POST /api/runs/:runId/pause`
- `POST /api/runs/:runId/resume`
- `POST /api/runs/:runId/cancel`

### Orchestrator
- `POST /api/tasks/:taskId/decompose`
- `POST /api/tasks/:taskId/decompose/confirm`
- `GET /api/tasks/:taskId/match-agents?agentIds=a,b,c`

### Interaction / Events / Terminal
- `GET /api/events/stream`
- `GET /api/interactions`
- `GET /api/interactions/:id`
- `POST /api/interactions/:id/respond`
- `POST /api/interactions/:id/override`
- `GET /api/interactions/stream`
- `POST /api/terminal/sessions`
- `GET /api/terminal/sessions`
- `GET /api/terminal/sessions/:id`
- `DELETE /api/terminal/sessions/:id`
- `GET /api/terminal/sessions/:id/messages`
- `DELETE /api/terminal/sessions/:id/messages`

## Page binding recommendations (immediate)
- `/projects` → `GET /api/projects`
- `/projects/[id]` → `GET /api/projects/:id`, `GET /api/projects/:id/tasks`, `GET /api/projects/:id/runs`
- `/projects/new` → `POST /api/projects`
- `/agents` → `GET /api/agents`
- `/agents/[id]` → `GET /api/agents/:id`
- `/agents/new` → `POST /api/agents`, plus selector data from `GET /api/providers`, `GET /api/mcp-servers`
- `/mcp` → `GET /api/mcp-servers`
- `/mcp/[id]/edit` → `GET /api/mcp-servers/:id`, `PATCH /api/mcp-servers/:id`
- `/provider` → `GET /api/providers`, `GET /api/providers/:id/models`, `GET /api/providers/:id/health`
- `/skills` → `GET /api/skills`
- `/memory` → `GET /api/memory`, `GET /api/memory/stats`
- `/dag` → `GET /api/projects/:projectId/runs`, `GET /api/runs/:id`
