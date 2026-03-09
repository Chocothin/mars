# Frontend Missing API List

These are the remaining API gaps for clean frontend behavior without mock fallback.

## Resolved: Create contract mismatches
Now available:
- `POST /api/projects` supports and persists `providerId` and `agentIds`
- `POST /api/agents` supports and persists `skillIds` and `mcpServerIds`

Impact:
- Project create and agent create forms can submit actual assignments without disabled/mock behavior.

## Resolved: Global Task APIs (non-project-scoped)
Now available:
- `GET /api/tasks?projectId=&status=&priority=&search=`
- `GET /api/tasks/:id`

Impact:
- Global `/tasks` and `/tasks/[id]` routes can use backend APIs without project-scoped URL hacks.

## Resolved: Dashboard/App-shell aggregate API (R01)
Now available and wired:
- `GET /api/dashboard/summary`
  - project/task/agent counts
  - recent runs
  - provider + MCP health summary

Impact:
- `/app-shell` now consumes dashboard summary directly for aggregate metrics and health data.
- Removed N+1 fetch pattern that previously queried tasks per project.

## 3) Provider analytics API
Needed:
- `GET /api/providers/:id/usage`
- `GET /api/providers/:id/activity`

Why:
- R07 provider page includes usage cards + activity table semantics not provided by current provider CRUD endpoints.

## 4) Cross-resource page composition endpoints
Needed (optional but recommended):
- `GET /api/pages/projects/:id/composite`
- `GET /api/pages/tasks/:id/composite`
- `GET /api/pages/agents/:id/composite`

Why:
- Detail pages combine multiple domain objects; a composite endpoint reduces frontend orchestration complexity.

## Resolved: UI-ready options endpoint (R14)
Now available and wired:
- `GET /api/options/agent-create`
  - providers with model lists pre-grouped
  - MCP server options
  - skill options
  - default provider/model/reasoning values

Impact:
- `/agents/new` now hydrates from a single options payload instead of frontend multi-call orchestration.

## Resolved: DAG graph snapshot endpoint (R15)
Now available and wired:
- `GET /api/projects/:projectId/dag`
  - latest run snapshot per project (or pinned via `runId`)
  - pipeline status and elapsed timing
  - graph node/edge payload
  - selected node metrics and recent logs

Impact:
- `/dag` now uses a single backend snapshot endpoint instead of frontend run-list + run-detail composition.
