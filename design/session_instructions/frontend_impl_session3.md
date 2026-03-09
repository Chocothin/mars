# Frontend Implementation Session 3

## Mission
Implement pages 11-15 from Pen design with pixel-accurate UI in Next.js frontend.

## Mandatory startup
1. Run `/frontend-ui-ux` first.
2. Use Playwriter MCP for visual checks during implementation.

## Assigned pages
1. `/mcp/[id]/edit` (R11)
2. `/projects/new` (R12)
3. `/tasks/new` (R13)
4. `/agents/new` (R14)
5. `/dag` (R15)

## Implementation rules
- Match forms, side panels, and table layouts exactly to design.
- Reuse `frontend/src/components/design-system` primitives.
- Keep route-level code in existing app-router locations.
- Avoid refactors outside assigned page scope unless required for shared component fixes.

## Verification loop (required)
For each page:
1. Implement page.
2. Use Playwriter MCP to open route.
3. Capture screenshot to `frontend/tests/visual/current/<slug>.png`.
4. Iterate until visual parity.

## Exit criteria
- All 5 pages complete with screenshots.
- `npm run lint` + `npm run build` pass.
- Document remaining visual deltas (if any) with file paths.
