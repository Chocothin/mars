#!/usr/bin/env python3
"""Step 3: Build component_map.json from normalized IR files."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


PIPELINE_DIR = Path(__file__).resolve().parent
IR_DIR = PIPELINE_DIR / "ir"
OUT_FILE = PIPELINE_DIR / "component_map.json"


def to_kebab(name: str) -> str:
    out = []
    for ch in name:
        if ch.isupper() and out:
            out.append("-")
        out.append(ch.lower())
    kebab = "".join(out).replace("_", "-")
    kebab = re.sub(r"[^a-z0-9-]", "-", kebab)
    kebab = re.sub(r"-{2,}", "-", kebab).strip("-")
    return kebab


def unique_id(candidate: str, used: set[str]) -> str:
    if candidate not in used:
        used.add(candidate)
        return candidate

    index = 2
    while f"{candidate}-{index}" in used:
        index += 1
    resolved = f"{candidate}-{index}"
    used.add(resolved)
    return resolved


def sanitize_component_id(raw_id: str, react_name: str, description: str) -> str:
    candidate = to_kebab(raw_id.replace("comp-", "")).strip("-") if raw_id else ""

    # Prefer meaningful id from description when raw id is too short.
    # Example: "Repeated m component ..." -> use react_name-derived fallback instead of "m".
    if len(candidate) < 3:
        desc = description.lower()
        if "nav" in desc:
            candidate = "nav-item"
        elif "row" in desc:
            candidate = "activity-row"
        elif "usage" in desc:
            candidate = "usage-metric"
        elif "project" in desc:
            candidate = "project-card"
        elif "agent" in desc:
            candidate = "agent-card"
        elif "mcp" in desc:
            candidate = "mcp-card"
        elif "skill" in desc:
            candidate = "skill-chip"
        elif "log" in desc:
            candidate = "log-row"
        elif "stat" in desc:
            candidate = "metric-card"
        else:
            candidate = to_kebab(react_name)

    if len(candidate) < 3:
        candidate = f"component-{candidate}"

    return candidate


def sanitize_react_name(raw_name: str, sanitized_id: str) -> str:
    compact = re.sub(r"[^a-zA-Z0-9]", "", raw_name or "")
    if compact and len(compact) >= 3:
        normalized = compact[0].upper() + compact[1:]
    else:
        normalized = "".join(p.capitalize() for p in sanitized_id.split("-") if p)

    if not normalized:
        normalized = "GeneratedComponent"
    if normalized[0].isdigit():
        normalized = f"Component{normalized}"
    return normalized


def page_key_from_route(route: str) -> str:
    if route == "/":
        return "root"
    return route.strip("/").replace("/", "__").replace("[", "").replace("]", "")


def main() -> None:
    ir_files = sorted(IR_DIR.glob("*_ir.json"))
    if not ir_files:
        raise SystemExit("No IR files found in design/pipeline/ir")

    shared_candidates: dict[str, list[dict]] = defaultdict(list)
    page_entries: dict[str, dict] = {}

    for ir_path in ir_files:
        data = json.loads(ir_path.read_text())
        meta = data.get("metadata", {})
        route = meta.get("routePath", "/")
        page_id = meta.get("pageId", ir_path.stem.replace("_ir", ""))
        page_key = page_key_from_route(route)

        per_page_components: dict[str, dict] = {}
        used_ids: set[str] = set()
        for comp in data.get("components", []):
            cid = comp.get("id", "")
            description = comp.get("description", "")
            raw_react_name = comp.get("reactName", "Component")
            ir_component_id = sanitize_component_id(cid, raw_react_name, description)
            ir_component_id = unique_id(ir_component_id, used_ids)
            react_name = sanitize_react_name(raw_react_name, ir_component_id)

            mapping = {
                "irComponentId": ir_component_id,
                "reactName": react_name,
                "filePath": f"src/generated/components/{to_kebab(react_name)}.tsx",
                "propsInterface": f"{react_name}Props",
                "shadcnDependencies": [],
                "lucideIcons": [],
                "usedOnPages": [route],
                "status": "pending",
            }
            per_page_components[ir_component_id] = mapping
            shared_candidates[ir_component_id].append({"route": route, "mapping": mapping})

        page_entries[page_key] = {
            "route": route,
            "pageId": page_id,
            "pageComponent": f"src/generated/pages/{page_key}/page.tsx",
            "components": per_page_components,
        }

    shared: dict[str, dict] = {}
    pages: dict[str, dict] = {}

    for key, page_def in page_entries.items():
        comp_out: dict[str, dict] = {}
        for cid, mapping in page_def["components"].items():
            routes = sorted({x["route"] for x in shared_candidates[cid]})
            if len(routes) >= 2:
                if cid not in shared:
                    shared[cid] = {
                        **mapping,
                        "usedOnPages": routes,
                    }
            else:
                comp_out[cid] = mapping

        pages[key] = {
            "route": page_def["route"],
            "pageId": page_def["pageId"],
            "pageComponent": page_def["pageComponent"],
            "components": comp_out,
        }

    out = {
        "$schema": "component_map",
        "version": "1.0.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "shared": shared,
        "pages": pages,
    }

    OUT_FILE.write_text(json.dumps(out, indent=2))
    print(f"Wrote {OUT_FILE}")
    print(f"Shared components: {len(shared)}")
    print(f"Pages: {len(pages)}")


if __name__ == "__main__":
    main()
