#!/usr/bin/env python3
"""Step 4: Generate React + Tailwind code from IR + component_map."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PIPELINE_DIR = ROOT / "design" / "pipeline"
IR_DIR = PIPELINE_DIR / "ir"
MAP_FILE = PIPELINE_DIR / "component_map.json"
TOKENS_FILE = PIPELINE_DIR / "design_tokens.json"
OUT_DIR = ROOT / "frontend" / "src" / "generated"


def ensure_dirs() -> None:
    (OUT_DIR / "components").mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "pages").mkdir(parents=True, exist_ok=True)
    (ROOT / "frontend" / "src" / "app" / "generated").mkdir(parents=True, exist_ok=True)


def to_camel(name: str) -> str:
    parts = name.replace("-", "_").split("_")
    if not parts:
        return "value"
    return parts[0].lower() + "".join(p.capitalize() for p in parts[1:])


def render_component(component: dict) -> str:
    react_name = component["reactName"]
    props_name = component["propsInterface"]

    return f'''import React from "react";

export interface {props_name} {{
  title?: string;
  subtitle?: string;
  status?: string;
  items?: string[];
}}

export function {react_name}({{ title, subtitle, status, items = [] }}: {props_name}) {{
  return (
    <section className="rounded-card border border-mars-border-subtle bg-mars-card p-4">
      {{title ? <h3 className="text-base font-semibold text-text-primary">{{title}}</h3> : null}}
      {{subtitle ? <p className="mt-1 text-sm text-text-secondary">{{subtitle}}</p> : null}}
      {{status ? <p className="mt-2 text-xs text-text-muted">Status: {{status}}</p> : null}}
      {{items.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm text-text-secondary">
          {{items.map((item) => (
            <li key={{item}}>{{item}}</li>
          ))}}
        </ul>
      ) : null}}
    </section>
  );
}}
'''


def flatten_nodes(node: dict) -> list[dict]:
    out = [node]
    for ch in node.get("children", []):
        out.extend(flatten_nodes(ch))
    return out


def render_page(page_key: str, route: str, ir: dict, shared: dict, local: dict) -> str:
    imports = []
    uses = []
    for c in list(shared.values()) + list(local.values()):
        imports.append(
            f'import {{ {c["reactName"]} }} from "@/generated/components/{Path(c["filePath"]).stem}";'
        )
        uses.append(c["reactName"])

    root = ir.get("root", {})
    nodes = flatten_nodes(root)

    section_blocks = []
    for zone in [n for n in nodes if n.get("type") == "zone"]:
        title = zone.get("name", "zone")
        section_blocks.append(
            f'''<section className="rounded-card border border-mars-border bg-mars-surface p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">{title}</h2>
        <p className="mt-2 text-xs text-text-muted">nodes: {len(zone.get("children", []))}</p>
      </section>'''
        )

    comps_render = "\n      ".join(
        [f"<{name} title=\"{name}\" subtitle=\"Generated from IR\" />" for name in uses]
    )

    zones_render = "\n      ".join(section_blocks)
    import_block = "\n".join(sorted(set(imports)))

    return f'''import React from "react";
{import_block}

export default function GeneratedPage() {{
  return (
    <main className="min-h-screen bg-mars-bg p-6 text-text-primary">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">{page_key}</h1>
        <p className="text-sm text-text-secondary">Route: {route}</p>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
      {comps_render if comps_render else '<p className="text-sm text-text-muted">No detected reusable components.</p>'}
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-2">
      {zones_render}
      </section>
    </main>
  );
}}
'''


def main() -> None:
    ensure_dirs()
    if not MAP_FILE.exists():
        raise SystemExit("Missing component_map.json. Run generate_component_map.py first.")

    cmap = json.loads(MAP_FILE.read_text())

    # Shared components
    for comp in cmap.get("shared", {}).values():
        out = OUT_DIR / "components" / f"{Path(comp['filePath']).stem}.tsx"
        out.write_text(render_component(comp))

    # Page components (local + page files)
    for page_key, page in cmap.get("pages", {}).items():
        page_route = page.get("route", "/")
        page_id = page.get("pageId", page_key)
        ir_file = IR_DIR / f"{page_id.upper()}_ir.json"
        if not ir_file.exists():
            ir_file = IR_DIR / f"{page_id}_ir.json"
        if not ir_file.exists():
            continue

        ir = json.loads(ir_file.read_text())
        local_components = page.get("components", {})

        for comp in local_components.values():
            out = OUT_DIR / "components" / f"{Path(comp['filePath']).stem}.tsx"
            if not out.exists():
                out.write_text(render_component(comp))

        page_dir = OUT_DIR / "pages" / page_key
        page_dir.mkdir(parents=True, exist_ok=True)
        page_tsx = page_dir / "page.tsx"
        page_tsx.write_text(
            render_page(page_key, page_route, ir, cmap.get("shared", {}), local_components)
        )

        # Next.js app route wrapper for visual testing and manual preview
        app_route_dir = ROOT / "frontend" / "src" / "app" / "generated" / page_key
        app_route_dir.mkdir(parents=True, exist_ok=True)
        app_route_page = app_route_dir / "page.tsx"
        app_route_page.write_text(
            (
                'import GeneratedPage from "@/generated/pages/'
                + page_key
                + '/page";\n\nexport default GeneratedPage;\n'
            )
        )

    # tokens snapshot for generator consumers
    if TOKENS_FILE.exists():
        (OUT_DIR / "design_tokens.snapshot.json").write_text(TOKENS_FILE.read_text())

    print(f"Generated React artifacts under {OUT_DIR}")


if __name__ == "__main__":
    main()
