#!/usr/bin/env python3
"""MARS Design Token Extractor — Step 2b. Scans 18 Penpot JSONs → design_tokens.json."""

import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


EXTRACTED_DIR = Path(__file__).resolve().parent.parent / "extracted"
OUTPUT_PATH = Path(__file__).resolve().parent / "design_tokens.json"

FILE_NAMES = [
    "Pilot", "R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08",
    "R09", "R10", "R11", "R12", "R13", "R14", "R15", "R16", "R17",
]

TAILWIND_COLORS = {
    "#0B0D14": "mars-bg",
    "#111524": "mars-surface",
    "#0E1019": "mars-canvas",
    "#1A1F35": "mars-card",
    "#1E293B": "mars-border",
    "#2A2F42": "mars-border-subtle",
    "#6366F1": "accent-primary",
    "#10B981": "accent-green",
    "#F59E0B": "accent-amber",
    "#EF4444": "accent-red",
    "#06B6D4": "accent-cyan",
    "#EC4899": "accent-pink",
    "#F97316": "accent-orange",
    "#8B5CF6": "accent-purple",
    "#F1F5F9": "text-primary",
    "#94A3B8": "text-secondary",
    "#64748B": "text-muted",
    "#4B5563": "text-dim",
    "#FFFFFF": "text-white",
    "#132A20": "badge-green",
    "#2A2410": "badge-amber",
    "#2A1414": "badge-red",
    "#1E1E3F": "badge-primary",
    "#0D2A2F": "badge-cyan",
}

SEMANTIC_NAMES = {
    "#0B0D14": "bg-app",
    "#111524": "surface-primary",
    "#0E1019": "surface-secondary",
    "#1A1F35": "surface-card",
    "#1E293B": "border-default",
    "#2A2F42": "border-subtle",
    "#6366F1": "accent-primary",
    "#10B981": "accent-success",
    "#F59E0B": "accent-warning",
    "#EF4444": "accent-error",
    "#06B6D4": "accent-info",
    "#EC4899": "accent-pink",
    "#F97316": "accent-orange",
    "#8B5CF6": "accent-purple",
    "#F1F5F9": "text-primary",
    "#94A3B8": "text-secondary",
    "#64748B": "text-muted",
    "#4B5563": "text-dim",
    "#FFFFFF": "text-white",
    "#132A20": "badge-green-bg",
    "#2A2410": "badge-amber-bg",
    "#2A1414": "badge-red-bg",
    "#1E1E3F": "badge-primary-bg",
    "#0D2A2F": "badge-cyan-bg",
}

SPACING_GRID = [4, 8, 12, 16, 20, 24, 32, 40, 48]
SPACING_NAMES = {4: "xs", 8: "sm", 12: "md", 16: "lg", 20: "xl", 24: "2xl", 32: "3xl"}


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def rgb_to_hex(r: int, g: int, b: int) -> str:
    return f"#{r:02X}{g:02X}{b:02X}"


def max_channel_distance(hex_a: str, hex_b: str) -> float:
    ra, ga, ba = hex_to_rgb(hex_a)
    rb, gb, bb = hex_to_rgb(hex_b)
    return max(abs(ra - rb), abs(ga - gb), abs(ba - bb))


def quantize_to_grid(value: float, grid: list[int]) -> int:
    return min(grid, key=lambda g: abs(g - value))


def quantize_radius(value: float) -> int:
    targets = [2, 4, 6, 8, 10, 11, 12, 16]
    if value >= 50:
        return 9999
    return min(targets, key=lambda t: abs(t - value))


def tailwind_class_for_color(semantic_name: str) -> str:
    prefix_map = [
        ("bg-", "bg-mars-", "bg-"),
        ("surface-", "bg-mars-", "surface-"),
        ("border-", "border-mars-", "border-"),
        ("text-", "text-mars-", "text-"),
        ("accent-", "text-mars-", ""),
        ("badge-", "bg-mars-", ""),
    ]
    for prefix, tw_prefix, strip in prefix_map:
        if semantic_name.startswith(prefix):
            return f"{tw_prefix}{semantic_name.replace(strip, '', 1) if strip else semantic_name}"
    return f"mars-{semantic_name}"


def css_variable_for_color(semantic_name: str) -> str:
    return f"--color-{semantic_name}"


def load_all_files() -> list[dict]:
    files = []
    for name in FILE_NAMES:
        path = EXTRACTED_DIR / f"{name}_details.json"
        if not path.exists():
            print(f"  WARNING: {path} not found, skipping", file=sys.stderr)
            continue
        with open(path) as f:
            data = json.load(f)
        data["_source"] = name
        files.append(data)
    return files



def walk_text_content(node: dict, collector: Counter):
    if isinstance(node, dict):
        for fill in node.get("fills") or []:
            c = fill.get("fill-color")
            if c:
                collector[c.upper()] += 1
        for child in node.get("children") or []:
            walk_text_content(child, collector)


def walk_text_fonts(node: dict, collector: Counter):
    if isinstance(node, dict):
        fs = node.get("font-size")
        fw = node.get("font-weight")
        ff = node.get("font-family")
        lh = node.get("line-height")
        if fs:
            collector[(str(fs), str(fw), str(ff), str(lh))] += 1
        for child in node.get("children") or []:
            walk_text_fonts(child, collector)


def extract_colors(files: list[dict]) -> dict:
    fill_colors = Counter()
    stroke_colors = Counter()
    text_colors = Counter()
    color_files: dict[str, set[str]] = defaultdict(set)

    for file_data in files:
        source = file_data["_source"]
        for _uuid, detail in file_data.get("details", {}).items():
            for fill in detail.get("fills") or []:
                c = fill.get("fill-color")
                if c:
                    c = c.upper()
                    fill_colors[c] += 1
                    color_files[c].add(source)

            for stroke in detail.get("strokes") or []:
                c = stroke.get("stroke-color")
                if c:
                    c = c.upper()
                    stroke_colors[c] += 1
                    color_files[c].add(source)

            if detail.get("type") == "text" and detail.get("content"):
                tc = Counter()
                walk_text_content(detail["content"], tc)
                for c, count in tc.items():
                    text_colors[c] += count
                    color_files[c].add(source)

    return {
        "fill": fill_colors,
        "stroke": stroke_colors,
        "text": text_colors,
        "files": color_files,
    }


def cluster_colors(
    all_colors: dict[str, int], threshold: int = 3
) -> list[dict]:
    sorted_colors = sorted(all_colors.items(), key=lambda x: -x[1])
    clusters: list[dict] = []
    assigned: set[str] = set()

    for hex_color, count in sorted_colors:
        if hex_color in assigned:
            continue
        cluster = {
            "representative": hex_color,
            "members": [(hex_color, count)],
            "total_count": count,
        }
        assigned.add(hex_color)

        for other_hex, other_count in sorted_colors:
            if other_hex in assigned:
                continue
            if max_channel_distance(hex_color, other_hex) < threshold:
                cluster["members"].append((other_hex, other_count))
                cluster["total_count"] += other_count
                assigned.add(other_hex)

        clusters.append(cluster)

    return clusters


def build_color_tokens(color_data: dict) -> dict:
    all_colors = Counter()
    for source in ["fill", "stroke", "text"]:
        all_colors.update(color_data[source])

    clusters = cluster_colors(all_colors, threshold=3)

    tokens = {}
    for cluster in clusters:
        hex_color = cluster["representative"]
        total = cluster["total_count"]
        rgb = hex_to_rgb(hex_color)

        semantic = SEMANTIC_NAMES.get(hex_color)
        if not semantic:
            for member_hex, _ in cluster["members"]:
                semantic = SEMANTIC_NAMES.get(member_hex)
                if semantic:
                    break

        if not semantic:
            if total < 3:
                continue
            r, g, b = rgb
            if r < 50 and g < 50 and b < 50:
                semantic = f"dark-{hex_color[1:].lower()}"
            else:
                semantic = f"color-{hex_color[1:].lower()}"

        fill_count = sum(
            color_data["fill"].get(m, 0) for m, _ in cluster["members"]
        )
        stroke_count = sum(
            color_data["stroke"].get(m, 0) for m, _ in cluster["members"]
        )
        text_count = sum(
            color_data["text"].get(m, 0) for m, _ in cluster["members"]
        )

        file_set: set[str] = set()
        for m, _ in cluster["members"]:
            file_set.update(color_data["files"].get(m, set()))

        tw_ref = TAILWIND_COLORS.get(hex_color, "")

        tokens[semantic] = {
            "hex": hex_color,
            "rgb": list(rgb),
            "tailwindClass": tailwind_class_for_color(semantic),
            "cssVariable": css_variable_for_color(semantic),
            "tailwindRef": tw_ref,
            "occurrences": total,
            "usedIn": {
                "fills": fill_count,
                "strokes": stroke_count,
                "texts": text_count,
            },
            "filesUsed": len(file_set),
            "clusteredFrom": [m for m, _ in cluster["members"]]
            if len(cluster["members"]) > 1
            else [],
        }

    return tokens



def extract_typography(files: list[dict]) -> dict:
    font_specs = Counter()

    for file_data in files:
        for _uuid, detail in file_data.get("details", {}).items():
            if detail.get("type") == "text" and detail.get("content"):
                walk_text_fonts(detail["content"], font_specs)

    size_groups: dict[int, list[dict]] = defaultdict(list)
    for (fs, fw, ff, lh), count in font_specs.items():
        size = int(fs)
        size_groups[size].append(
            {
                "fontSize": size,
                "fontWeight": int(fw) if fw and fw != "None" else 400,
                "fontFamily": ff if ff and ff != "None" else "sourcesanspro",
                "lineHeight": float(lh) if lh and lh != "None" else 1.2,
                "occurrences": count,
            }
        )

    scale_map = {
        "heading-xl": lambda s: s >= 24,
        "heading-lg": lambda s: 20 <= s < 24,
        "heading-md": lambda s: 16 <= s < 20,
        "body-lg": lambda s: s == 14,
        "body": lambda s: s == 13,
        "body-sm": lambda s: s == 12,
        "label": lambda s: s == 11,
        "caption": lambda s: s == 10,
        "caption-xs": lambda s: s < 10,
    }

    tw_size_map = {
        "heading-xl": "text-2xl",
        "heading-lg": "text-xl",
        "heading-md": "text-lg",
        "body-lg": "text-base",
        "body": "text-[13px]",
        "body-sm": "text-sm",
        "label": "text-mono",
        "caption": "text-xs",
        "caption-xs": "text-[8px]",
    }

    tw_weight_map = {
        400: "font-normal",
        500: "font-medium",
        600: "font-semibold",
        700: "font-bold",
    }

    tokens = {}
    for sizes in sorted(size_groups.keys(), reverse=True):
        entries = size_groups[sizes]
        scale_name = None
        for name, predicate in scale_map.items():
            if predicate(sizes):
                scale_name = name
                break
        if not scale_name:
            continue

        weight_counts = Counter()
        total_occ = 0
        families = Counter()
        for entry in entries:
            weight_counts[entry["fontWeight"]] += entry["occurrences"]
            families[entry["fontFamily"]] += entry["occurrences"]
            total_occ += entry["occurrences"]

        dominant_weight = weight_counts.most_common(1)[0][0]
        dominant_family = families.most_common(1)[0][0]

        family_display = "Source Sans Pro" if "sourcesans" in dominant_family.lower() else dominant_family

        tw_size = tw_size_map.get(scale_name, f"text-[{sizes}px]")
        tw_weight = tw_weight_map.get(dominant_weight, f"font-[{dominant_weight}]")

        base_token = {
            "fontSize": sizes,
            "fontWeight": dominant_weight,
            "lineHeight": 1.2,
            "fontFamily": family_display,
            "tailwindClasses": f"{tw_size} {tw_weight}",
            "cssProperties": {
                "font-size": f"{sizes}px",
                "font-weight": str(dominant_weight),
                "line-height": "1.2",
                "font-family": f"'{family_display}', system-ui, sans-serif",
            },
            "occurrences": total_occ,
        }

        variants = {}
        for weight, count in weight_counts.most_common():
            if count >= 5:
                vw = tw_weight_map.get(weight, f"font-[{weight}]")
                variant_name = vw.replace("font-", "")
                variants[variant_name] = {
                    "fontWeight": weight,
                    "tailwindClasses": f"{tw_size} {vw}",
                    "occurrences": count,
                }

        if len(variants) > 1:
            base_token["variants"] = variants

        if scale_name in tokens and tokens[scale_name]["occurrences"] > total_occ:
            continue
        tokens[scale_name] = base_token

    return tokens



def extract_spacing(files: list[dict]) -> dict:
    raw_gaps = Counter()

    for file_data in files:
        details = file_data.get("details", {})

        by_parent: dict[str, list[dict]] = defaultdict(list)
        for _uuid, detail in details.items():
            pid = detail.get("parent_id")
            if pid:
                by_parent[pid].append(detail)

        for _pid, siblings in by_parent.items():
            if len(siblings) < 2:
                continue
            sorted_siblings = sorted(
                siblings, key=lambda s: (s.get("y") or 0)
            )
            for i in range(len(sorted_siblings) - 1):
                a = sorted_siblings[i]
                b = sorted_siblings[i + 1]
                ay = (a.get("y") or 0) + (a.get("height") or 0)
                by_val = b.get("y") or 0
                gap = by_val - ay
                if 1 <= gap <= 80:
                    raw_gaps[round(gap)] += 1

        for _pid, siblings in by_parent.items():
            if len(siblings) < 2:
                continue
            sorted_siblings = sorted(
                siblings, key=lambda s: (s.get("x") or 0)
            )
            for i in range(len(sorted_siblings) - 1):
                a = sorted_siblings[i]
                b = sorted_siblings[i + 1]
                ax = (a.get("x") or 0) + (a.get("width") or 0)
                bx = b.get("x") or 0
                gap = bx - ax
                if 1 <= gap <= 80:
                    raw_gaps[round(gap)] += 1

    quantized = Counter()
    for gap, count in raw_gaps.items():
        q = quantize_to_grid(gap, SPACING_GRID)
        quantized[q] += count

    tokens = {}
    for q_val in sorted(quantized.keys()):
        count = quantized[q_val]
        if count < 5:
            continue
        name = SPACING_NAMES.get(q_val, f"{q_val}px")
        tokens[name] = {
            "value": q_val,
            "px": f"{q_val}px",
            "rem": f"{q_val / 16:.3f}rem",
            "tailwindClass": f"gap-{q_val // 4}" if q_val % 4 == 0 else f"gap-[{q_val}px]",
            "occurrences": count,
        }

    return tokens



def extract_radius(files: list[dict]) -> dict:
    raw_radius = Counter()

    for file_data in files:
        for _uuid, detail in file_data.get("details", {}).items():
            r1 = detail.get("r1")
            if r1 is not None and r1 != 0:
                raw_radius[float(r1)] += 1

    quantized = Counter()
    for val, count in raw_radius.items():
        q = quantize_radius(val)
        quantized[q] += count

    radius_names = {
        2: "xs",
        4: "sm",
        6: "md",
        8: "lg",
        10: "xl",
        11: "badge",
        12: "2xl",
        16: "3xl",
        9999: "full",
    }

    tokens = {}
    for val in sorted(quantized.keys()):
        count = quantized[val]
        name = radius_names.get(val, f"{val}px")
        tokens[name] = {
            "value": val,
            "px": f"{val}px" if val < 9999 else "9999px",
            "rem": f"{val / 16:.3f}rem" if val < 9999 else "9999px",
            "tailwindClass": (
                f"rounded-[{val}px]" if val < 9999 else "rounded-full"
            ),
            "occurrences": count,
        }

    return tokens



def build_tailwind_mapping(color_tokens: dict) -> dict:
    css_variables = {}
    tailwind_extend = {"colors": {"mars": {}}}

    for name, token in color_tokens.items():
        css_variables[token["cssVariable"]] = token["hex"]

        parts = name.split("-", 1)
        if len(parts) == 2:
            group, sub = parts
            if group not in tailwind_extend["colors"]:
                tailwind_extend["colors"][group] = {}
            tailwind_extend["colors"][group][sub] = f"var({token['cssVariable']})"
        else:
            tailwind_extend["colors"]["mars"][name] = f"var({token['cssVariable']})"

    return {
        "cssVariables": css_variables,
        "tailwindExtend": tailwind_extend,
    }



def main():
    print("=" * 60)
    print("MARS Design Token Extractor — Step 2b")
    print("=" * 60)

    print(f"\n[1/5] Loading {len(FILE_NAMES)} extracted files...")
    files = load_all_files()
    print(f"  Loaded {len(files)} files")

    total_details = sum(
        len(f.get("details", {})) for f in files
    )
    print(f"  Total details across all files: {total_details}")

    print("\n[2/5] Extracting colors...")
    color_data = extract_colors(files)
    color_tokens = build_color_tokens(color_data)
    print(f"  Unique fill colors: {len(color_data['fill'])}")
    print(f"  Unique stroke colors: {len(color_data['stroke'])}")
    print(f"  Unique text colors: {len(color_data['text'])}")
    print(f"  Final color tokens: {len(color_tokens)}")

    print("\n[3/5] Extracting typography...")
    typo_tokens = extract_typography(files)
    print(f"  Typography scale entries: {len(typo_tokens)}")
    for name, tok in sorted(typo_tokens.items(), key=lambda x: -x[1]["fontSize"]):
        print(
            f"    {name}: {tok['fontSize']}px / {tok['fontWeight']} "
            f"({tok['occurrences']} uses)"
        )

    print("\n[4/5] Extracting spacing...")
    spacing_tokens = extract_spacing(files)
    print(f"  Spacing scale entries: {len(spacing_tokens)}")
    for name, tok in sorted(spacing_tokens.items(), key=lambda x: x[1]["value"]):
        print(f"    {name}: {tok['value']}px ({tok['occurrences']} uses)")

    print("\n[5/5] Extracting border radius...")
    radius_tokens = extract_radius(files)
    print(f"  Radius scale entries: {len(radius_tokens)}")
    for name, tok in sorted(radius_tokens.items(), key=lambda x: x[1]["value"]):
        print(f"    {name}: {tok['value']}px ({tok['occurrences']} uses)")

    tw_mapping = build_tailwind_mapping(color_tokens)

    output = {
        "$schema": "mars-tokens-v1",
        "version": "1.0.0",
        "extractedFrom": [f["_source"] for f in files],
        "extractedAt": datetime.now(timezone.utc).isoformat(),
        "stats": {
            "totalFiles": len(files),
            "totalDetails": total_details,
            "totalColorTokens": len(color_tokens),
            "totalTypographyTokens": len(typo_tokens),
            "totalSpacingTokens": len(spacing_tokens),
            "totalRadiusTokens": len(radius_tokens),
        },
        "colors": color_tokens,
        "typography": typo_tokens,
        "spacing": {name: tok["value"] for name, tok in sorted(spacing_tokens.items(), key=lambda x: x[1]["value"])},
        "spacingDetailed": spacing_tokens,
        "radius": {name: tok["value"] for name, tok in sorted(radius_tokens.items(), key=lambda x: x[1]["value"])},
        "radiusDetailed": radius_tokens,
        "tailwindMapping": tw_mapping,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n{'=' * 60}")
    print(f"Output written to: {OUTPUT_PATH}")
    print(f"{'=' * 60}")

    print("\n--- TOKEN SUMMARY ---")
    print(f"  Colors:     {len(color_tokens)} tokens")
    print(f"  Typography: {len(typo_tokens)} scale entries")
    print(f"  Spacing:    {len(spacing_tokens)} values")
    print(f"  Radius:     {len(radius_tokens)} values")
    print()

    print("--- TAILWIND CROSS-REFERENCE ---")
    tw_colors_found = set()
    for name, tok in color_tokens.items():
        ref = tok.get("tailwindRef")
        if ref:
            tw_colors_found.add(ref)
            print(f"  {name} ({tok['hex']}) → tailwind: {ref}")
    missing = set(TAILWIND_COLORS.values()) - tw_colors_found
    if missing:
        print(f"\n  Tailwind colors NOT in design: {missing}")
    else:
        print(f"\n  All {len(TAILWIND_COLORS)} tailwind colors accounted for!")


if __name__ == "__main__":
    main()
