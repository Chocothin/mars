# Frontend Implementation Session 2

## Mission
Implement pages 6-10 from Pen design with pixel-accurate UI in Next.js frontend.

## Mandatory startup
1. Run `/frontend-ui-ux` first.
2. Use Playwriter MCP for visual checks during implementation.

## Assigned pages
1. `/skills` (R06)
2. `/provider` (R07)
3. `/projects/[id]` (R08)
4. `/tasks/[id]` (R09)
5. `/agents/[id]` (R10)

## Implementation rules
- Reference source: `design/mars.pen` and `design/pipeline/ir/*_ir.json`.
- Prefer composition from shared design components.
- Preserve existing route structure and loading behavior.
- No new UI libraries.

## Verification loop (required)
For each page:
1. Implement page.
2. Use Playwriter MCP to open route and inspect.
3. Capture screenshot to `frontend/tests/visual/current/<slug>.png`.
4. Improve until visually aligned to Pen design.

## Exit criteria
- All 5 pages implemented and visually checked.
- `npm run lint` and `npm run build` pass.
- List exact files changed and screenshots captured.
