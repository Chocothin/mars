#!/usr/bin/env python3
"""
MARS IR Normalizer — Step 2c of the design-to-code pipeline.

Converts extracted Penpot JSON files into normalized IR JSON files
conforming to the NormalizedIR schema (schemas/normalized_ir.ts).

Usage:
    python3 normalize_ir.py          # Process all pages
    python3 normalize_ir.py R07      # Process single page
    python3 normalize_ir.py R07 R12  # Process specific pages
"""

from __future__ import annotations

import json
import os
import re
import sys
import math
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
EXTRACTED_DIR = os.path.join(SCRIPT_DIR, "..", "extracted")
IR_DIR = os.path.join(SCRIPT_DIR, "ir")
TOKENS_PATH = os.path.join(SCRIPT_DIR, "design_tokens.json")

CANVAS_W = 1440
CANVAS_H = 900
HEADER_H = 52
SIDEBAR_W = 220
RIGHT_PANEL_THRESHOLD = 1200  # x >= this suggests right panel
RIGHT_PANEL_MIN_SHAPES = 5
SPATIAL_TOLERANCE = 4  # px

ROUTE_MAP: dict[str, str] = {
    "Pilot": "/",
    "R01": "/app-shell",
    "R02": "/tasks",
    "R03": "/agents",
    "R04": "/mcp",
    "R05": "/memory",
    "R06": "/skills",
    "R07": "/provider",
    "R08": "/projects/[id]",
    "R09": "/tasks/[id]",
    "R10": "/agents/[id]",
    "R11": "/mcp/[id]/edit",
    "R12": "/projects/new",
    "R13": "/tasks/new",
    "R14": "/agents/new",
    "R15": "/dag",
    "R16": "/projects",
    "R17": "/settings",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def log(msg: str) -> None:
    """Print progress message."""
    print(f"  {msg}")


def warn(msg: str) -> None:
    """Print warning."""
    print(f"  ⚠ {msg}")


def normalize_name(name: str) -> str:
    """
    Normalize shape name to consistent kebab-case.
    Handles both 'kebab-case' and 'Title Case With Spaces'.
    """
    # Already kebab? Return as-is (lowercase)
    if "-" in name and " " not in name:
        return name.lower()
    # Title Case → kebab-case
    # "Nav Projects Active BG" → "nav-projects-active-bg"
    return re.sub(r"\s+", "-", name.strip()).lower()


def to_pascal(kebab: str) -> str:
    """Convert kebab-case to PascalCase."""
    return "".join(word.capitalize() for word in kebab.split("-") if word)


def extract_text_content(content_node: dict | None) -> dict | None:
    """
    Extract text string and font info from Penpot's nested content structure.
    content → root → children → paragraph-set → children → paragraph → children → [{text, ...}]
    """
    if not content_node:
        return None
    try:
        paragraphs = []
        font_info: dict[str, Any] = {}
        for ps in content_node.get("children", []):
            for para in ps.get("children", []):
                for span in para.get("children", []):
                    text = span.get("text", "")
                    if text:
                        paragraphs.append(text)
                    if not font_info:
                        font_info = {
                            "fontSize": _parse_num(span.get("font-size")),
                            "fontWeight": _parse_num(span.get("font-weight", "400")),
                            "fontFamily": span.get("font-family"),
                            "textAlign": span.get("text-align", "left"),
                            "textColor": _extract_fill_color(span.get("fills", [])),
                        }
        if paragraphs:
            return {"text": "\n".join(paragraphs), **font_info}
    except (KeyError, IndexError, TypeError):
        pass
    return None


def _parse_num(val: Any) -> int | float | None:
    """Safely parse a number from string or numeric value."""
    if val is None:
        return None
    try:
        n = float(val)
        return int(n) if n == int(n) else n
    except (ValueError, TypeError):
        return None


def _extract_fill_color(fills: list[dict]) -> dict | None:
    """Extract primary fill color as ColorRef."""
    if not fills:
        return None
    fill = fills[0]
    hex_val = fill.get("fill-color")
    if not hex_val:
        return None
    result: dict[str, Any] = {"hex": hex_val}
    opacity = fill.get("fill-opacity")
    if opacity is not None and opacity != 1.0:
        result["opacity"] = opacity
    return result


def get_border_radius(detail: dict) -> int | list[int] | None:
    """Extract border radius from shape detail."""
    r1, r2, r3, r4 = detail.get("r1"), detail.get("r2"), detail.get("r3"), detail.get("r4")
    rx = detail.get("rx")
    if r1 is not None and any(r is not None for r in [r2, r3, r4]):
        corners = [r1 or 0, r2 or 0, r3 or 0, r4 or 0]
        if all(c == corners[0] for c in corners):
            return int(corners[0]) if corners[0] else None
        return [int(c) for c in corners]
    if rx:
        return int(rx)
    return None


def bbox_contains(container: dict, child: dict, tolerance: int = SPATIAL_TOLERANCE) -> bool:
    """Check if child bbox is within container bbox (with tolerance)."""
    cx, cy = container["x"], container["y"]
    cw, ch_ = container["width"], container["height"]
    sx, sy = child["x"], child["y"]
    sw, sh = child["width"], child["height"]
    return (
        sx >= cx - tolerance
        and sy >= cy - tolerance
        and sx + sw <= cx + cw + tolerance
        and sy + sh <= cy + ch_ + tolerance
    )


def shapes_aligned_x(shapes: list[dict], tolerance: int = SPATIAL_TOLERANCE) -> bool:
    """Check if shapes share similar X positions (vertical column)."""
    if len(shapes) < 2:
        return False
    xs = [s["x"] for s in shapes]
    return max(xs) - min(xs) <= tolerance


def shapes_aligned_y(shapes: list[dict], tolerance: int = SPATIAL_TOLERANCE) -> bool:
    """Check if shapes share similar Y positions (horizontal row)."""
    if len(shapes) < 2:
        return False
    ys = [s["y"] for s in shapes]
    return max(ys) - min(ys) <= tolerance


def median(values: list[float]) -> float:
    """Compute median of a list."""
    if not values:
        return 0
    s = sorted(values)
    n = len(s)
    if n % 2 == 0:
        return (s[n // 2 - 1] + s[n // 2]) / 2
    return s[n // 2]


# ---------------------------------------------------------------------------
# Core: flatten tree to get all shapes with metadata
# ---------------------------------------------------------------------------

def flatten_tree(node: dict, parent_id: str | None = None, depth: int = 0) -> list[dict]:
    """Flatten tree into list of shapes with parent info and depth."""
    shapes = []
    entry = {
        "id": node["id"],
        "name": node.get("name", ""),
        "norm_name": normalize_name(node.get("name", "")),
        "type": node.get("type", "frame"),
        "x": float(node.get("x", 0)),
        "y": float(node.get("y", 0)),
        "width": float(node.get("width", 0)),
        "height": float(node.get("height", 0)),
        "parent_id": parent_id,
        "depth": depth,
        "children_ids": [c["id"] for c in node.get("children", [])],
        "_raw": node,
    }
    shapes.append(entry)
    for child in node.get("children", []):
        shapes.extend(flatten_tree(child, node["id"], depth + 1))
    return shapes


# ---------------------------------------------------------------------------
# PHASE 1: Zone Classification
# ---------------------------------------------------------------------------

def _detect_right_panel(shapes: list[dict]) -> tuple[bool, int | None]:
    """
    Detect right panel via explicit background rect rather than raw shape count.
    A right panel is defined by a large rect (height >=400, width >=150)
    positioned at x > sidebar_width + 200 that names itself as a panel/preview
    background, or is at least 3/4 canvas height.
    """
    panel_bg = None
    for s in shapes:
        if s["type"] != "rect" or s["y"] < HEADER_H - SPATIAL_TOLERANCE:
            continue
        name = s["norm_name"]
        is_panel_name = any(kw in name for kw in ("panel", "preview", "aside", "detail"))
        is_tall_bg = s["height"] >= (CANVAS_H - HEADER_H) * 0.75 and s["width"] >= 150
        is_right_half = s["x"] > SIDEBAR_W + 200

        if is_right_half and (is_panel_name or is_tall_bg) and name.endswith(("-bg", "")):
            if panel_bg is None or s["width"] * s["height"] > panel_bg["width"] * panel_bg["height"]:
                panel_bg = s

    if panel_bg:
        return True, int(panel_bg["x"])
    return False, None


def phase1_zone_classification(
    shapes: list[dict],
) -> tuple[dict[str, list[dict]], bool, int | None]:
    """
    Classify shapes into zones: HEADER, SIDEBAR, MAIN, RIGHT_PANEL.
    Returns (zone_map, has_right_panel, right_panel_x).
    """
    has_right_panel, right_panel_x = _detect_right_panel(shapes)

    main_right_bound = right_panel_x if right_panel_x else CANVAS_W

    zones: dict[str, list[dict]] = {
        "HEADER": [],
        "SIDEBAR": [],
        "MAIN": [],
        "RIGHT_PANEL": [],
    }

    for s in shapes:
        # Skip only structural root-like entries; keep depth==2 content nodes
        # because some pages place all real shapes directly under App Shell.
        if s["width"] >= CANVAS_W and s["height"] >= CANVAS_H and s["type"] == "frame":
            if "app shell" in s["norm_name"] or "root" in s["norm_name"]:
                continue
        # Skip zero-size or hidden
        if s["width"] <= 0 and s["height"] <= 0:
            continue

        x, y, w, h = s["x"], s["y"], s["width"], s["height"]

        if y + h <= HEADER_H + SPATIAL_TOLERANCE:
            zones["HEADER"].append(s)
        elif x + w <= SIDEBAR_W + SPATIAL_TOLERANCE and y >= HEADER_H - SPATIAL_TOLERANCE:
            zones["SIDEBAR"].append(s)
        elif has_right_panel and right_panel_x and x >= right_panel_x - SPATIAL_TOLERANCE and y >= HEADER_H - SPATIAL_TOLERANCE:
            zones["RIGHT_PANEL"].append(s)
        elif y >= HEADER_H - SPATIAL_TOLERANCE:
            zones["MAIN"].append(s)
        else:
            # Edge case: spans multiple zones — classify by center point
            cx = x + w / 2
            cy = y + h / 2
            if cy <= HEADER_H:
                zones["HEADER"].append(s)
            elif cx <= SIDEBAR_W:
                zones["SIDEBAR"].append(s)
            else:
                zones["MAIN"].append(s)

    return zones, has_right_panel, right_panel_x


# ---------------------------------------------------------------------------
# PHASE 2: Name Parsing → Group Candidates
# ---------------------------------------------------------------------------

def phase2_name_grouping(shapes: list[dict]) -> dict[str, list[dict]]:
    """
    Group shapes by name prefix segments.
    Splits normalized names by '-' and groups by common prefix.
    """
    groups: dict[str, list[dict]] = defaultdict(list)

    for s in shapes:
        name = s["norm_name"]
        if not name:
            continue

        segments = name.split("-")
        if not segments:
            continue

        # Strategy: find the best prefix that groups multiple shapes
        # Use first segment, but merge numeric suffixes (card1, card2 → card)
        prefix = segments[0]

        # Handle numbered prefixes: card1 → card, usage1 → usage, r1 → r
        # But keep nav-projects separate from nav-tasks (use first 2 segments for nav)
        base_prefix = re.sub(r"\d+$", "", prefix)

        if len(segments) >= 2:
            second = segments[1]
            # For patterns like "nav-projects-bg", group by "nav-projects"
            # For patterns like "card1-header-bar", group by "card1" (keep number)
            if base_prefix in ("nav", "section"):
                group_key = f"{prefix}-{second}"
            elif base_prefix in ("th", "r1", "r2", "r3"):
                # Table header/row cells
                group_key = f"table-{base_prefix}"
            else:
                group_key = prefix
        else:
            group_key = prefix

        groups[group_key].append(s)

    return dict(groups)


def merge_singleton_groups(groups: dict[str, list[dict]]) -> dict[str, list[dict]]:
    """Merge singleton groups into a common 'ungrouped' bucket if they don't form a pattern."""
    merged: dict[str, list[dict]] = {}
    ungrouped: list[dict] = []

    for key, members in groups.items():
        if len(members) >= 2:
            merged[key] = members
        else:
            # Check if singleton has a bg suffix (it's a standalone element)
            name = members[0]["norm_name"]
            if name.endswith("-bg") or name.endswith("-border"):
                ungrouped.extend(members)
            else:
                merged[key] = members

    if ungrouped:
        merged["_ungrouped"] = ungrouped

    return merged


# ---------------------------------------------------------------------------
# PHASE 3: Spatial Validation
# ---------------------------------------------------------------------------

def phase3_spatial_validation(
    groups: dict[str, list[dict]],
    details: dict[str, dict],
) -> dict[str, dict]:
    """
    For each group, find the container (bg shape or largest member),
    validate members are within container bbox.
    Returns validated group info: {group_key: {container, members, orphans}}.
    """
    validated: dict[str, dict] = {}

    for key, members in groups.items():
        if key == "_ungrouped":
            validated[key] = {"container": None, "members": members, "orphans": []}
            continue

        # Find container: shape ending in -bg, or largest area member
        container = None
        bg_shapes = [m for m in members if m["norm_name"].endswith("-bg")]
        if bg_shapes:
            # Pick the one with largest area
            container = max(bg_shapes, key=lambda s: s["width"] * s["height"])
        else:
            # Use largest area member as container
            container = max(members, key=lambda s: s["width"] * s["height"])

        # Validate containment
        valid_members = []
        orphans = []
        for m in members:
            if m["id"] == container["id"]:
                valid_members.append(m)
                continue
            if bbox_contains(container, m):
                valid_members.append(m)
            else:
                orphans.append(m)

        validated[key] = {
            "container": container,
            "members": valid_members,
            "orphans": orphans,
        }

    return validated


# ---------------------------------------------------------------------------
# PHASE 4: Component Pattern Detection
# ---------------------------------------------------------------------------

def _get_suffix_set(name: str, prefix: str) -> set[str]:
    """Get the suffix set for a name relative to its group prefix."""
    norm = normalize_name(name)
    if norm.startswith(prefix):
        suffix = norm[len(prefix):]
        if suffix.startswith("-"):
            suffix = suffix[1:]
        # Remove leading numeric id: "1-label" → "label"
        suffix = re.sub(r"^\d+-", "", suffix)
        return {suffix} if suffix else {"_self"}
    return {norm}


def _compute_structural_signature(members: list[dict], group_prefix: str) -> list[str]:
    """
    Compute a structural signature for a group.
    Returns sorted list of suffix types (ignoring numeric instance ids).
    """
    suffixes: set[str] = set()
    for m in members:
        for s in _get_suffix_set(m["norm_name"], group_prefix):
            # Normalize: remove leading digits and instance markers
            clean = re.sub(r"^\d+[-_]?", "", s)
            clean = re.sub(r"\d+$", "", clean)
            if clean:
                suffixes.add(clean)
    return sorted(suffixes)


def phase4_component_detection(
    validated_groups: dict[str, dict],
    all_shapes: list[dict],
) -> list[dict]:
    """
    Detect repeating component patterns across groups.
    Returns list of ComponentDef dicts.
    """
    components: list[dict] = []

    # Build signature → groups mapping
    sig_groups: dict[str, list[tuple[str, dict]]] = defaultdict(list)

    for key, info in validated_groups.items():
        if key == "_ungrouped":
            continue
        members = info["members"]
        if len(members) < 2:
            continue

        # Extract the base prefix without trailing numbers
        base_key = re.sub(r"\d+$", "", key)
        sig = tuple(_compute_structural_signature(members, key))
        if len(sig) >= 2:  # Need at least 2 distinct suffix types
            sig_groups[f"{base_key}::{','.join(sig)}"].append((key, info))

    # Find groups with same signature (component instances)
    # Also detect numbered groups: card1, card2 → same component
    numbered_families: dict[str, list[tuple[str, dict]]] = defaultdict(list)
    for key, info in validated_groups.items():
        if key == "_ungrouped":
            continue
        base = re.sub(r"\d+$", "", key)
        if base != key:  # Has trailing number
            numbered_families[base].append((key, info))

    # Process numbered families
    for base, family_members in numbered_families.items():
        if len(family_members) < 2:
            continue

        # Compute structural similarity between instances
        sigs = []
        for key, info in family_members:
            sig = _compute_structural_signature(info["members"], key)
            sigs.append(sig)

        # Check >=80% structural similarity
        if len(sigs) >= 2:
            common = set(sigs[0])
            for sig in sigs[1:]:
                common &= set(sig)
            union = set(sigs[0])
            for sig in sigs[1:]:
                union |= set(sig)
            similarity = len(common) / len(union) if union else 0

            if similarity >= 0.8:
                react_name = to_pascal(base)
                instance_ids = []
                props_schema: dict[str, dict] = {}

                for key, info in family_members:
                    container = info.get("container")
                    if container:
                        instance_ids.append(container["id"])

                # Detect varying values as props
                # Compare text content across instances
                for suffix in common:
                    if suffix in ("bg", "border", "_self"):
                        continue
                    if "text" in suffix or "label" in suffix or "name" in suffix or "value" in suffix:
                        props_schema[suffix.replace("-", "_")] = {
                            "type": "string",
                            "required": True,
                        }
                    elif "icon" in suffix:
                        props_schema[suffix.replace("-", "_")] = {
                            "type": "icon",
                            "required": False,
                        }
                    elif "badge" in suffix or "status" in suffix:
                        props_schema[suffix.replace("-", "_")] = {
                            "type": "string",
                            "required": False,
                        }

                comp = {
                    "id": f"comp-{base}",
                    "reactName": react_name,
                    "description": f"Repeated {base} component with {len(family_members)} instances",
                    "detection": {
                        "method": "name-pattern",
                        "namePattern": f"{base}\\d+",
                        "instanceCount": len(family_members),
                        "instanceNodeIds": instance_ids,
                    },
                    "propsSchema": props_schema,
                    "_instances": family_members,
                    "_base_key": base,
                }
                components.append(comp)

    # Also detect same-prefix numbered shapes (usage-card-1, usage-card-2, etc.)
    # Group by shape name minus trailing digits
    shape_families: dict[str, list[dict]] = defaultdict(list)
    for s in all_shapes:
        name = s["norm_name"]
        # Match patterns like "usage-card-1", "tip-1-bg"
        match = re.match(r"^(.+?)[-_](\d+)$", name)
        if match:
            base_name = match.group(1)
            shape_families[base_name].append(s)

    for base_name, family in shape_families.items():
        if len(family) < 2:
            continue
        # Check if these are top-level containers (cards, not sub-elements)
        if any(kw in base_name for kw in ("card", "chip", "tip", "item")):
            # Check if already detected
            already = any(c["_base_key"] == base_name.replace("-", "") for c in components if "_base_key" in c)
            if not already:
                react_name = to_pascal(base_name)
                comp = {
                    "id": f"comp-{base_name.replace(' ', '-')}",
                    "reactName": react_name,
                    "description": f"Repeated {base_name} with {len(family)} instances",
                    "detection": {
                        "method": "name-pattern",
                        "namePattern": f"{re.escape(base_name)}-\\d+",
                        "instanceCount": len(family),
                        "instanceNodeIds": [s["id"] for s in family],
                    },
                    "propsSchema": {},
                    "_instances": [],
                    "_base_key": base_name,
                }
                components.append(comp)

    # Detect nav-item component (nav-* groups)
    nav_groups = [(k, v) for k, v in validated_groups.items() if k.startswith("nav-")]
    if len(nav_groups) >= 3:
        # Check structural similarity
        nav_sigs = []
        for key, info in nav_groups:
            sig = _compute_structural_signature(info["members"], key)
            nav_sigs.append(sig)

        if nav_sigs:
            common = set(nav_sigs[0])
            for sig in nav_sigs[1:]:
                common &= set(sig)
            union = set(nav_sigs[0])
            for sig in nav_sigs[1:]:
                union |= set(sig)
            similarity = len(common) / len(union) if union else 0

            if similarity >= 0.5:  # Nav items might have slight variations (active state)
                comp = {
                    "id": "comp-nav-item",
                    "reactName": "NavItem",
                    "description": f"Sidebar navigation item with {len(nav_groups)} instances",
                    "detection": {
                        "method": "name-pattern",
                        "namePattern": "nav-*-bg/icon/label",
                        "instanceCount": len(nav_groups),
                        "instanceNodeIds": [
                            info["container"]["id"]
                            for _, info in nav_groups
                            if info.get("container")
                        ],
                    },
                    "propsSchema": {
                        "label": {"type": "string", "required": True},
                        "icon": {"type": "icon", "required": True},
                        "active": {"type": "boolean", "required": False, "defaultValue": False},
                        "href": {"type": "string", "required": True},
                    },
                    "_instances": nav_groups,
                    "_base_key": "nav-item",
                }
                components.append(comp)

    return components


# ---------------------------------------------------------------------------
# PHASE 5: Layout Inference
# ---------------------------------------------------------------------------

def phase5_layout_inference(children: list[dict]) -> dict:
    """
    Infer layout (flex row/column/grid/absolute) from child positions.
    Returns LayoutSpec dict.
    """
    if not children:
        return {"display": "flex", "direction": "column"}

    if len(children) == 1:
        c = children[0]
        return {
            "display": "flex",
            "direction": "column",
            "width": {"mode": "fixed", "px": int(c["width"])},
            "height": {"mode": "fixed", "px": int(c["height"])},
        }

    # Sort by position for analysis
    by_y = sorted(children, key=lambda s: (s["y"], s["x"]))
    by_x = sorted(children, key=lambda s: (s["x"], s["y"]))

    # Check if all share same X (vertical column)
    if shapes_aligned_x(children):
        gaps = []
        for i in range(1, len(by_y)):
            gap = by_y[i]["y"] - (by_y[i - 1]["y"] + by_y[i - 1]["height"])
            if gap > 0:
                gaps.append(gap)
        return {
            "display": "flex",
            "direction": "column",
            "gap": int(median(gaps)) if gaps else 0,
        }

    # Check if all share same Y (horizontal row)
    if shapes_aligned_y(children):
        gaps = []
        for i in range(1, len(by_x)):
            gap = by_x[i]["x"] - (by_x[i - 1]["x"] + by_x[i - 1]["width"])
            if gap > 0:
                gaps.append(gap)
        return {
            "display": "flex",
            "direction": "row",
            "gap": int(median(gaps)) if gaps else 0,
        }

    # Check for grid pattern
    unique_xs = sorted(set(int(s["x"]) for s in children))
    unique_ys = sorted(set(int(s["y"]) for s in children))

    # Grid: multiple distinct X and Y positions with regularity
    if len(unique_xs) >= 2 and len(unique_ys) >= 2:
        # Check if shapes form a grid
        x_bins = _cluster_values([s["x"] for s in children], SPATIAL_TOLERANCE)
        y_bins = _cluster_values([s["y"] for s in children], SPATIAL_TOLERANCE)

        if len(x_bins) >= 2 and len(y_bins) >= 2 and len(children) >= len(x_bins) * len(y_bins) * 0.5:
            # Compute row/col gaps
            x_centers = sorted(x_bins)
            col_gaps = [x_centers[i + 1] - x_centers[i] for i in range(len(x_centers) - 1)]
            return {
                "display": "grid",
                "gridCols": len(x_bins),
                "gap": int(median(col_gaps)) if col_gaps else 0,
            }

    # Check for approximate column layout (items in 2-3 columns)
    x_bins = _cluster_values([s["x"] for s in children], SPATIAL_TOLERANCE * 4)
    if len(x_bins) >= 2:
        # Multi-column layout
        col_gaps = sorted(x_bins)
        gap_vals = [col_gaps[i + 1] - col_gaps[i] for i in range(len(col_gaps) - 1)]

        # Check if items within each column are vertically stacked
        return {
            "display": "flex",
            "direction": "column",
            "gap": int(median(gap_vals)) if gap_vals else 0,
        }

    # Fallback: absolute positioning
    return {"display": "absolute"}


def _cluster_values(values: list[float], tolerance: float) -> list[float]:
    """Cluster nearby values together, return cluster centers."""
    if not values:
        return []
    sorted_vals = sorted(values)
    clusters: list[list[float]] = [[sorted_vals[0]]]
    for v in sorted_vals[1:]:
        if v - clusters[-1][-1] <= tolerance:
            clusters[-1].append(v)
        else:
            clusters.append([v])
    return [sum(c) / len(c) for c in clusters]


def compute_padding(container: dict, children: list[dict]) -> dict | None:
    """Compute padding from container edges to children cluster."""
    if not children or not container:
        return None
    min_x = min(c["x"] for c in children)
    min_y = min(c["y"] for c in children)
    max_x = max(c["x"] + c["width"] for c in children)
    max_y = max(c["y"] + c["height"] for c in children)

    top = max(0, int(min_y - container["y"]))
    right = max(0, int((container["x"] + container["width"]) - max_x))
    bottom = max(0, int((container["y"] + container["height"]) - max_y))
    left = max(0, int(min_x - container["x"]))

    if top == 0 and right == 0 and bottom == 0 and left == 0:
        return None
    return {"top": top, "right": right, "bottom": bottom, "left": left}


# ---------------------------------------------------------------------------
# PHASE 6: Token Resolution
# ---------------------------------------------------------------------------

_design_tokens: dict | None = None


def load_design_tokens() -> dict | None:
    """Load design tokens if available."""
    global _design_tokens
    if _design_tokens is not None:
        return _design_tokens if _design_tokens else None
    if os.path.exists(TOKENS_PATH):
        with open(TOKENS_PATH) as f:
            _design_tokens = json.load(f)
        return _design_tokens
    _design_tokens = {}  # Mark as loaded (empty)
    return None


def resolve_color(hex_val: str, opacity: float = 1.0) -> dict:
    """Resolve hex color to ColorRef, with optional token binding."""
    tokens = load_design_tokens()
    result: dict[str, Any] = {"hex": hex_val}
    if opacity != 1.0:
        result["opacity"] = opacity
    if tokens:
        # Try to find matching token
        color_tokens = tokens.get("colors", {})
        for token_name, token_val in color_tokens.items():
            if isinstance(token_val, str) and token_val.lower() == hex_val.lower():
                result["token"] = token_name
                break
    return result


# ---------------------------------------------------------------------------
# PHASE 7: Semantic Type Detection
# ---------------------------------------------------------------------------

def phase7_detect_semantic_type(shape: dict, detail: dict | None) -> str:
    """Detect semantic type from shape name and geometry."""
    name = shape["norm_name"]
    typ = shape["type"]
    w, h = shape["width"], shape["height"]

    # Explicit text type from Penpot
    if typ == "text":
        return "text"

    # Button detection
    if any(kw in name for kw in ("btn", "button")):
        return "button"

    # Input detection
    if any(kw in name for kw in ("input", "select", "textarea")):
        return "input"

    # Badge detection
    if any(kw in name for kw in ("badge", "chip", "tag", "pill")):
        return "badge"

    # Table detection
    if any(kw in name for kw in ("table", "th-", "activity-row", "activity-table")):
        if "header" in name:
            return "table-header"
        if "row" in name and "border" not in name:
            return "table-row"
        if name.startswith("th-"):
            return "table-cell"
        return "table"

    # Divider detection (thin rect)
    if typ == "rect" and (h <= 2 or w <= 2):
        return "divider"
    if "border" in name or "divider" in name:
        return "divider"

    # Icon detection (small circle)
    if typ == "circle" and w <= 32 and h <= 32:
        return "icon"

    # Search bar
    if "search" in name and typ == "rect":
        return "input"

    # Avatar
    if "avatar" in name:
        return "icon"

    # Card / Container
    if any(kw in name for kw in ("card", "-bg")) and typ == "rect" and w > 100 and h > 50:
        return "shape"

    # Default: generic shape
    return "shape"


# ---------------------------------------------------------------------------
# IR Node Builder
# ---------------------------------------------------------------------------

def build_ir_node(
    shape: dict,
    detail: dict | None,
    children_ir: list[dict],
    zone: str | None = None,
    component_ref: str | None = None,
) -> dict:
    """Build an IRNode dict from shape data."""
    name = shape["norm_name"]
    sem_type = phase7_detect_semantic_type(shape, detail)

    # Override type for zone containers
    if zone and shape["depth"] <= 3:
        sem_type = "zone"

    # Build style
    style: dict[str, Any] = {}
    if detail:
        fills = detail.get("fills", [])
        if fills:
            fill = fills[0]
            hex_val = fill.get("fill-color")
            if hex_val:
                opacity = fill.get("fill-opacity", 1.0)
                style["bg"] = resolve_color(hex_val, opacity)

        br = get_border_radius(detail)
        if br:
            style["borderRadius"] = br

        strokes = detail.get("strokes", [])
        if strokes:
            stroke = strokes[0]
            s_color = stroke.get("stroke-color")
            s_width = stroke.get("stroke-width", 1)
            if s_color:
                style["border"] = {
                    "width": int(s_width),
                    "color": resolve_color(s_color),
                    "style": "solid",
                }

        op = detail.get("opacity")
        if op is not None and op != 1:
            style["opacity"] = op

        shadow_list = detail.get("shadow", [])
        if shadow_list:
            s = shadow_list[0]
            style["shadow"] = {
                "x": s.get("offset-x", 0),
                "y": s.get("offset-y", 0),
                "blur": s.get("blur", 0),
                "spread": s.get("spread", 0),
                "color": resolve_color(s.get("color", "#000000")),
            }

    # Build layout
    layout: dict[str, Any] = {"display": "flex", "direction": "column"}
    if children_ir:
        child_shapes = []
        for cir in children_ir:
            # Extract position from the IR node's layout
            ap = cir.get("layout", {}).get("absolutePosition", {})
            w = cir.get("layout", {}).get("width", {})
            h = cir.get("layout", {}).get("height", {})
            child_shapes.append({
                "x": ap.get("left", 0) if ap else 0,
                "y": ap.get("top", 0) if ap else 0,
                "width": w.get("px", 0) if isinstance(w, dict) else 0,
                "height": h.get("px", 0) if isinstance(h, dict) else 0,
            })
        if child_shapes and any(cs["width"] > 0 for cs in child_shapes):
            layout = phase5_layout_inference(child_shapes)

    layout["width"] = {"mode": "fixed", "px": int(shape["width"])}
    layout["height"] = {"mode": "fixed", "px": int(shape["height"])}

    # Add absolute position relative to parent
    if shape.get("x") is not None and shape.get("y") is not None:
        layout["absolutePosition"] = {
            "left": int(shape["x"]),
            "top": int(shape["y"]),
        }

    # Build content (for text nodes)
    content = None
    if detail and detail.get("type") == "text":
        text_info = extract_text_content(detail.get("content"))
        if text_info:
            content = {}
            if text_info.get("text"):
                content["text"] = text_info["text"]
            if text_info.get("fontSize"):
                content["fontSize"] = text_info["fontSize"]
            if text_info.get("fontWeight"):
                content["fontWeight"] = text_info["fontWeight"]
            if text_info.get("fontFamily"):
                content["fontFamily"] = text_info["fontFamily"]
            if text_info.get("textColor"):
                content["textColor"] = text_info["textColor"]
            if text_info.get("textAlign"):
                content["textAlign"] = text_info["textAlign"]

    # For input shapes, extract placeholder
    if sem_type == "input" and not content:
        content = {"placeholder": name.replace("-bg", "").replace("input-", "")}

    node: dict[str, Any] = {
        "id": shape["id"],
        "name": name,
        "type": sem_type,
        "sourceShapeIds": [shape["id"]],
        "layout": layout,
        "style": style,
        "children": children_ir,
    }

    if component_ref:
        node["componentRef"] = component_ref

    if content:
        node["content"] = content

    return node


# ---------------------------------------------------------------------------
# Tree Builder: assemble IR tree from zones and groups
# ---------------------------------------------------------------------------

def build_zone_tree(
    zone_shapes: list[dict],
    details: dict[str, dict],
    zone_name: str,
    components: list[dict],
) -> list[dict]:
    """Build IR nodes for shapes in a zone, organized by groups."""
    if not zone_shapes:
        return []

    # Phase 2: Group by name prefix
    groups = phase2_name_grouping(zone_shapes)
    groups = merge_singleton_groups(groups)

    # Phase 3: Spatial validation
    validated = phase3_spatial_validation(groups, details)

    # Build IR nodes for each group
    ir_nodes: list[dict] = []

    # Track which shapes have been placed in groups
    grouped_ids: set[str] = set()

    for key, info in validated.items():
        if key == "_ungrouped":
            continue

        container = info.get("container")
        members = info["members"]

        if not members:
            continue

        # Find matching component
        comp_ref = None
        for comp in components:
            if comp.get("_base_key") and key.startswith(comp["_base_key"]):
                comp_ref = comp["id"]
                break

        # Build children IR (non-container members)
        children_ir: list[dict] = []
        for m in members:
            grouped_ids.add(m["id"])
            if container and m["id"] == container["id"]:
                continue
            detail = details.get(m["id"])
            child_node = build_ir_node(m, detail, [], component_ref=None)
            children_ir.append(child_node)

        # Sort children by position (top-left to bottom-right)
        children_ir.sort(key=lambda n: (
            n["layout"].get("absolutePosition", {}).get("top", 0),
            n["layout"].get("absolutePosition", {}).get("left", 0),
        ))

        # Build container/group node
        if container:
            detail = details.get(container["id"])
            # Compute padding
            if children_ir and container:
                child_shapes_for_padding = [
                    m for m in members if m["id"] != container["id"]
                ]
                padding = compute_padding(container, child_shapes_for_padding)
            else:
                padding = None

            group_node = build_ir_node(container, detail, children_ir, component_ref=comp_ref)
            group_node["type"] = "component" if comp_ref else "group"
            group_node["sourceShapeIds"] = [m["id"] for m in members]
            if padding:
                group_node["layout"]["padding"] = padding
            # Re-infer layout from actual child positions
            if len(children_ir) >= 2:
                child_shapes_for_layout = [
                    m for m in members if m["id"] != container["id"]
                ]
                group_node["layout"].update(phase5_layout_inference(child_shapes_for_layout))
                group_node["layout"]["width"] = {"mode": "fixed", "px": int(container["width"])}
                group_node["layout"]["height"] = {"mode": "fixed", "px": int(container["height"])}
            ir_nodes.append(group_node)
        else:
            # No container — add children individually
            ir_nodes.extend(children_ir)

    # Add any ungrouped shapes
    for s in zone_shapes:
        if s["id"] not in grouped_ids:
            detail = details.get(s["id"])
            node = build_ir_node(s, detail, [])
            ir_nodes.append(node)

    # Sort by position
    ir_nodes.sort(key=lambda n: (
        n["layout"].get("absolutePosition", {}).get("top", 0),
        n["layout"].get("absolutePosition", {}).get("left", 0),
    ))

    return ir_nodes


# ---------------------------------------------------------------------------
# Table Detection & Assembly
# ---------------------------------------------------------------------------

def detect_and_build_tables(
    zone_shapes: list[dict],
    details: dict[str, dict],
) -> tuple[list[dict], set[str]]:
    """
    Detect table patterns and build table IR nodes.
    Returns (table_ir_nodes, consumed_shape_ids).
    """
    tables: list[dict] = []
    consumed: set[str] = set()

    # Find table header shapes
    header_shapes = [s for s in zone_shapes if "table-header" in s["norm_name"] or s["norm_name"].startswith("activity-table")]
    th_shapes = [s for s in zone_shapes if s["norm_name"].startswith("th-")]
    row_borders = sorted(
        [s for s in zone_shapes if "row" in s["norm_name"] and "border" in s["norm_name"]],
        key=lambda s: s["y"],
    )

    if not header_shapes and not th_shapes:
        return [], set()

    # Find all row data shapes (r1-*, r2-*, etc.)
    row_pattern = re.compile(r"^r(\d+)-(.+)$")
    rows_data: dict[int, list[dict]] = defaultdict(list)
    for s in zone_shapes:
        m = row_pattern.match(s["norm_name"])
        if m:
            row_num = int(m.group(1))
            rows_data[row_num].append(s)

    if not th_shapes and not rows_data:
        return [], set()

    # Build table header
    header_ir: dict[str, Any] | None = None
    if header_shapes:
        header_bg = header_shapes[0]
        consumed.add(header_bg["id"])

        th_children = []
        for th in sorted(th_shapes, key=lambda s: s["x"]):
            consumed.add(th["id"])
            detail = details.get(th["id"])
            th_node = build_ir_node(th, detail, [])
            th_node["type"] = "table-cell"
            th_children.append(th_node)

        detail = details.get(header_bg["id"])
        header_ir = build_ir_node(header_bg, detail, th_children)
        header_ir["type"] = "table-header"
        header_ir["layout"]["display"] = "flex"
        header_ir["layout"]["direction"] = "row"

    # Build table rows
    row_irs: list[dict] = []
    for row_num in sorted(rows_data.keys()):
        cells = sorted(rows_data[row_num], key=lambda s: s["x"])
        cell_irs = []
        for cell in cells:
            consumed.add(cell["id"])
            detail = details.get(cell["id"])
            cell_node = build_ir_node(cell, detail, [])
            cell_node["type"] = "table-cell"
            cell_irs.append(cell_node)

        if cell_irs:
            row_ir: dict[str, Any] = {
                "id": f"table-row-{row_num}",
                "name": f"row-{row_num}",
                "type": "table-row",
                "sourceShapeIds": [c["id"] for c in cells],
                "layout": {"display": "flex", "direction": "row",
                           "width": {"mode": "fill"}, "height": {"mode": "hug"}},
                "style": {},
                "children": cell_irs,
            }
            row_irs.append(row_ir)

    # Consume row borders
    for rb in row_borders:
        consumed.add(rb["id"])

    # Assemble table
    table_children: list[dict] = []
    if header_ir:
        table_children.append(header_ir)
    table_children.extend(row_irs)

    if table_children:
        # Find table bounds
        all_table_shapes = [s for s in zone_shapes if s["id"] in consumed]
        if all_table_shapes:
            min_x = min(s["x"] for s in all_table_shapes)
            min_y = min(s["y"] for s in all_table_shapes)
            max_x = max(s["x"] + s["width"] for s in all_table_shapes)
            max_y = max(s["y"] + s["height"] for s in all_table_shapes)

            table_ir: dict[str, Any] = {
                "id": "table-activity",
                "name": "activity-table",
                "type": "table",
                "sourceShapeIds": list(consumed),
                "layout": {
                    "display": "flex",
                    "direction": "column",
                    "width": {"mode": "fixed", "px": int(max_x - min_x)},
                    "height": {"mode": "fixed", "px": int(max_y - min_y)},
                    "absolutePosition": {"left": int(min_x), "top": int(min_y)},
                },
                "style": {},
                "children": table_children,
            }
            tables.append(table_ir)

    return tables, consumed


# ---------------------------------------------------------------------------
# Main Processor
# ---------------------------------------------------------------------------

def process_page(file_path: str, page_key: str) -> dict | None:
    """Process a single extracted JSON file into an IR document."""
    print(f"\nProcessing {page_key}...")

    with open(file_path) as f:
        data = json.load(f)

    tree = data["tree"]
    details = data.get("details", {})
    page_name = data.get("name", page_key)

    # Navigate to the actual page frame (skip Root Frame)
    page_frame = tree
    if tree.get("children"):
        page_frame = tree["children"][0]

    # Navigate to App Shell if present
    content_root = page_frame
    for child in page_frame.get("children", []):
        if "app shell" in child.get("name", "").lower() or "shell" in child.get("name", "").lower():
            content_root = child
            break

    # Flatten all shapes
    all_shapes = flatten_tree(content_root, depth=2)  # Start at depth 2 (inside AppShell)
    # Also get shapes that are direct children of page_frame but not in AppShell
    if content_root["id"] != page_frame["id"]:
        # Shapes might be outside App Shell
        for child in page_frame.get("children", []):
            if child["id"] != content_root["id"]:
                all_shapes.extend(flatten_tree(child, page_frame["id"], depth=2))

    # Filter out only the content root itself.
    # Some pages place real shapes directly at depth==2 under App Shell,
    # so using depth>2 drops entire pages (observed on R09-R14).
    content_shapes = [s for s in all_shapes if s["id"] != content_root["id"]]

    total_shapes = len(content_shapes)
    log(f"Phase 1: {total_shapes} shapes to classify...")

    # PHASE 1: Zone Classification
    zones, has_right_panel, right_panel_x = phase1_zone_classification(content_shapes)
    for zone_name, zone_shapes in zones.items():
        if zone_shapes:
            log(f"  {zone_name}: {len(zone_shapes)} shapes")

    # PHASE 2-3: Group & Validate (per zone)
    log(f"Phase 2-3: Grouping and spatial validation...")
    zone_groups: dict[str, dict[str, dict]] = {}
    for zone_name in ["HEADER", "SIDEBAR", "MAIN", "RIGHT_PANEL"]:
        zone_shapes = zones.get(zone_name, [])
        if not zone_shapes:
            continue
        groups = phase2_name_grouping(zone_shapes)
        groups = merge_singleton_groups(groups)
        validated = phase3_spatial_validation(groups, details)
        zone_groups[zone_name] = validated
        group_count = len([k for k in validated if k != "_ungrouped"])
        log(f"  {zone_name}: {group_count} groups found")

    # PHASE 4: Component Detection
    log(f"Phase 4: Detecting components...")
    all_validated = {}
    for zg in zone_groups.values():
        all_validated.update(zg)
    components = phase4_component_detection(all_validated, content_shapes)
    log(f"  {len(components)} component patterns detected")
    for comp in components:
        log(f"    {comp['reactName']} ({comp['detection']['instanceCount']} instances)")

    # PHASE 5-7: Build IR tree with layout and semantic types
    log(f"Phase 5-7: Building IR tree with layout, tokens, semantic types...")

    # Detect tables first (MAIN zone)
    table_nodes, table_consumed = detect_and_build_tables(
        zones.get("MAIN", []), details,
    )

    # Build zone IR nodes
    zone_ir: dict[str, list[dict]] = {}
    for zone_name in ["HEADER", "SIDEBAR", "MAIN", "RIGHT_PANEL"]:
        zone_shapes = zones.get(zone_name, [])
        if not zone_shapes:
            zone_ir[zone_name] = []
            continue

        # Filter out table-consumed shapes from MAIN
        if zone_name == "MAIN" and table_consumed:
            zone_shapes = [s for s in zone_shapes if s["id"] not in table_consumed]

        zone_ir[zone_name] = build_zone_tree(zone_shapes, details, zone_name, components)

    # Inject tables into MAIN zone
    if table_nodes:
        zone_ir.setdefault("MAIN", []).extend(table_nodes)
        # Re-sort MAIN by position
        zone_ir["MAIN"].sort(key=lambda n: (
            n["layout"].get("absolutePosition", {}).get("top", 0),
            n["layout"].get("absolutePosition", {}).get("left", 0),
        ))

    # Build app shell spec
    sidebar_shapes = zones.get("SIDEBAR", [])
    header_shapes = zones.get("HEADER", [])
    main_shapes = zones.get("MAIN", [])

    main_width = (right_panel_x - SIDEBAR_W) if right_panel_x else (CANVAS_W - SIDEBAR_W)

    app_shell: dict[str, Any] = {
        "header": {
            "x": 0, "y": 0,
            "width": CANVAS_W, "height": HEADER_H,
        } if header_shapes else None,
        "sidebar": {
            "x": 0, "y": HEADER_H,
            "width": SIDEBAR_W, "height": CANVAS_H - HEADER_H,
        } if sidebar_shapes else None,
        "main": {
            "x": SIDEBAR_W, "y": HEADER_H,
            "width": int(main_width), "height": CANVAS_H - HEADER_H,
        },
        "rightPanel": {
            "x": right_panel_x, "y": HEADER_H,
            "width": CANVAS_W - right_panel_x, "height": CANVAS_H - HEADER_H,
        } if has_right_panel and right_panel_x else None,
    }

    # Build root IR tree
    root_children: list[dict] = []

    # Header zone node
    if zone_ir.get("HEADER"):
        header_node: dict[str, Any] = {
            "id": "zone-header",
            "name": "header",
            "type": "zone",
            "sourceShapeIds": [s["id"] for s in header_shapes],
            "layout": {
                "display": "flex", "direction": "row",
                "alignItems": "center",
                "width": {"mode": "fixed", "px": CANVAS_W},
                "height": {"mode": "fixed", "px": HEADER_H},
                "absolutePosition": {"left": 0, "top": 0},
            },
            "style": {},
            "children": zone_ir["HEADER"],
        }
        root_children.append(header_node)

    # Sidebar zone node
    if zone_ir.get("SIDEBAR"):
        sidebar_node: dict[str, Any] = {
            "id": "zone-sidebar",
            "name": "sidebar",
            "type": "zone",
            "sourceShapeIds": [s["id"] for s in sidebar_shapes],
            "layout": {
                "display": "flex", "direction": "column",
                "width": {"mode": "fixed", "px": SIDEBAR_W},
                "height": {"mode": "fixed", "px": CANVAS_H - HEADER_H},
                "absolutePosition": {"left": 0, "top": HEADER_H},
            },
            "style": {},
            "children": zone_ir["SIDEBAR"],
        }
        root_children.append(sidebar_node)

    # Main zone node
    if zone_ir.get("MAIN"):
        main_node: dict[str, Any] = {
            "id": "zone-main",
            "name": "main",
            "type": "zone",
            "sourceShapeIds": [s["id"] for s in main_shapes],
            "layout": {
                "display": "flex", "direction": "column",
                "width": {"mode": "fixed", "px": int(main_width)},
                "height": {"mode": "fixed", "px": CANVAS_H - HEADER_H},
                "absolutePosition": {"left": SIDEBAR_W, "top": HEADER_H},
            },
            "style": {},
            "children": zone_ir["MAIN"],
        }
        root_children.append(main_node)

    # Right panel zone node
    if zone_ir.get("RIGHT_PANEL") and has_right_panel:
        rp_shapes = zones.get("RIGHT_PANEL", [])
        rp_x = int(right_panel_x) if right_panel_x is not None else RIGHT_PANEL_THRESHOLD
        rp_node: dict[str, Any] = {
            "id": "zone-right-panel",
            "name": "right-panel",
            "type": "zone",
            "sourceShapeIds": [s["id"] for s in rp_shapes],
            "layout": {
                "display": "flex", "direction": "column",
                "width": {"mode": "fixed", "px": CANVAS_W - rp_x},
                "height": {"mode": "fixed", "px": CANVAS_H - HEADER_H},
                "absolutePosition": {"left": rp_x, "top": HEADER_H},
            },
            "style": {},
            "children": zone_ir["RIGHT_PANEL"],
        }
        root_children.append(rp_node)

    # Root page node
    root_ir: dict[str, Any] = {
        "id": f"page-{page_key.lower()}",
        "name": page_key.lower(),
        "type": "page",
        "sourceShapeIds": [content_root["id"]],
        "layout": {
            "display": "flex",
            "direction": "column",
            "width": {"mode": "fixed", "px": CANVAS_W},
            "height": {"mode": "fixed", "px": CANVAS_H},
        },
        "style": {},
        "children": root_children,
    }

    # Clean component defs for output (remove internal keys)
    clean_components: list[dict] = []
    for comp in components:
        # Build a minimal template from first instance
        template: dict[str, Any] = {
            "id": f"template-{comp['id']}",
            "name": comp["reactName"],
            "type": "component",
            "sourceShapeIds": comp["detection"]["instanceNodeIds"][:1],
            "layout": {"display": "flex", "direction": "column"},
            "style": {},
            "children": [],
        }

        clean_comp = {
            "id": comp["id"],
            "reactName": comp["reactName"],
            "description": comp["description"],
            "detection": comp["detection"],
            "template": template,
            "propsSchema": comp["propsSchema"],
        }
        clean_components.append(clean_comp)

    # Build route path
    route_path = ROUTE_MAP.get(page_key, f"/{page_key.lower()}")

    # Assemble final IR document
    ir_doc: dict[str, Any] = {
        "$schema": "normalized_ir",
        "version": "1.0.0",
        "metadata": {
            "pageId": page_key.lower(),
            "pageName": page_name,
            "routePath": route_path,
            "sourceFile": f"extracted/{os.path.basename(file_path)}",
            "canvas": {"width": CANVAS_W, "height": CANVAS_H},
            "shapeCount": total_shapes,
            "componentCount": len(clean_components),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        },
        "appShell": app_shell,
        "root": root_ir,
        "components": clean_components,
    }

    log(f"Done: {total_shapes} shapes → {len(root_children)} zones, {len(clean_components)} components")
    return ir_doc


# ---------------------------------------------------------------------------
# File Discovery
# ---------------------------------------------------------------------------

def discover_pages(filter_keys: list[str] | None = None) -> list[tuple[str, str]]:
    """
    Discover extracted JSON files.
    Returns list of (page_key, file_path) tuples.
    """
    pages: list[tuple[str, str]] = []

    for fname in sorted(os.listdir(EXTRACTED_DIR)):
        if not fname.endswith("_details.json"):
            continue
        page_key = fname.replace("_details.json", "")

        if filter_keys and page_key not in filter_keys:
            continue

        file_path = os.path.join(EXTRACTED_DIR, fname)
        pages.append((page_key, file_path))

    return pages


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    """Main entry point."""
    # Parse CLI arguments
    filter_keys: list[str] | None = None
    if len(sys.argv) > 1:
        filter_keys = sys.argv[1:]
        print(f"Processing specific pages: {', '.join(filter_keys)}")
    else:
        print("Processing all pages...")

    # Ensure output directory exists
    os.makedirs(IR_DIR, exist_ok=True)

    # Discover pages
    pages = discover_pages(filter_keys)
    if not pages:
        print("No matching pages found in extracted/ directory.")
        sys.exit(1)

    print(f"Found {len(pages)} page(s) to process.\n")

    # Process each page
    results: list[dict[str, Any]] = []
    errors: list[str] = []

    for page_key, file_path in pages:
        try:
            ir_doc = process_page(file_path, page_key)
            if ir_doc:
                # Write IR file
                out_path = os.path.join(IR_DIR, f"{page_key}_ir.json")
                with open(out_path, "w") as f:
                    json.dump(ir_doc, f, indent=2, ensure_ascii=False)
                log(f"Written → {os.path.relpath(out_path, SCRIPT_DIR)}")
                results.append({
                    "page": page_key,
                    "shapes": ir_doc["metadata"]["shapeCount"],
                    "components": ir_doc["metadata"]["componentCount"],
                    "zones": len(ir_doc["root"]["children"]),
                    "route": ir_doc["metadata"]["routePath"],
                })
        except Exception as e:
            warn(f"FAILED processing {page_key}: {e}")
            errors.append(f"{page_key}: {e}")
            import traceback
            traceback.print_exc()

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"{'Page':<10} {'Shapes':>7} {'Comps':>6} {'Zones':>6}  Route")
    print("-" * 60)
    for r in results:
        print(f"{r['page']:<10} {r['shapes']:>7} {r['components']:>6} {r['zones']:>6}  {r['route']}")
    print("-" * 60)
    total_shapes = sum(r["shapes"] for r in results)
    total_comps = sum(r["components"] for r in results)
    print(f"{'TOTAL':<10} {total_shapes:>7} {total_comps:>6}")

    if errors:
        print(f"\n⚠ {len(errors)} error(s):")
        for e in errors:
            print(f"  - {e}")

    print(f"\nOutput directory: {os.path.relpath(IR_DIR, os.getcwd())}")


if __name__ == "__main__":
    main()
