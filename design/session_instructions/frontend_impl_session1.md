# Frontend Implementation Session 1

## Mission
Implement pages 1-5 from Pen design with pixel-accurate UI in Next.js frontend.

## Mandatory startup
1. Run `/frontend-ui-ux` first.
2. Use Playwriter MCP for visual checks during implementation.

## Assigned pages
1. `/app-shell` (R01)
2. `/tasks` (R02)
3. `/agents` (R03)
4. `/mcp` (R04)
5. `/memory` (R05)

## Implementation rules
- Reference source: `design/mars.pen` and generated routes under `src/app/(dashboard)`.
- Build/modify only frontend code under `frontend/src`.
- Reuse shared design components from `frontend/src/components/design-system` first.
- Keep strict TypeScript. Do not use `any` or `@ts-ignore`.
- Match spacing, typography, border, elevation, and colors exactly.

## Verification loop (required)
For each page:
1. Implement page.
2. Use Playwriter MCP to open `http://127.0.0.1:3000/<route>`.
3. Capture screenshot to `frontend/tests/visual/current/<slug>.png`.
4. Compare against design visually and iterate until aligned.

## Exit criteria
- All 5 pages implemented.
- `npm run lint` passes (warnings allowed only if pre-existing and documented).
- `npm run build` passes.
- Screenshot files produced for all 5 pages.
