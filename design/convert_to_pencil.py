#!/usr/bin/env python3
"""
Convert Penpot extracted data to Pencil batch_design DSL operations.
Outputs: {name}_ops.txt files ready for pencil_batch_design
"""
import json, sys, os, re

OUT_DIR = "/Users/mk-mac-391/project/mars/design/pencil_ops"
EXTRACTED_DIR = "/Users/mk-mac-391/project/mars/design/extracted"
os.makedirs(OUT_DIR, exist_ok=True)

# Y positions for each frame in Pencil canvas
Y_POSITIONS = {
    "Pilot": 0, "R01": 3000, "R02": 6200, "R03": 9400, "R04": 12600,
    "R05": 15800, "R06": 19000, "R07": 22200, "R08": 25400, "R09": 28600,
    "R10": 31800, "R11": 35000, "R12": 38200, "R13": 41400, "R14": 44600,
    "R15": 47800, "R16": 51000, "R17": 54200
}

def sanitize_binding(name, idx):
    """Create a safe binding name"""
    s = re.sub(r'[^a-zA-Z0-9]', '', name)[:12]
    return f"{s}_{idx}" if s else f"node_{idx}"

def escape_content(text):
    """Escape special chars for Pencil DSL"""
    if not text:
        return ""
    text = text.replace('\\', '\\\\')
    text = text.replace('"', '&quot;')
    text = text.replace('\n', ' ')
    return text

def extract_text_content(content_obj):
    """Extract plain text from Penpot's nested text content structure"""
    texts = []
    def walk(node):
        if isinstance(node, dict):
            if "text" in node and isinstance(node["text"], str):
                texts.append(node["text"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(content_obj)
    return " ".join(texts).strip()

def extract_text_style(content_obj):
    """Extract font properties from Penpot text content"""
    style = {"fontSize": 14, "fontWeight": "400", "fill": "#F1F5F9", "fontFamily": "Inter"}
    def walk(node):
        if isinstance(node, dict):
            if "font-size" in node:
                try:
                    style["fontSize"] = int(float(node["font-size"]))
                except:
                    pass
            if "font-weight" in node:
                style["fontWeight"] = str(node["font-weight"])
            if "fills" in node and isinstance(node["fills"], list) and node["fills"]:
                fc = node["fills"][0].get("fill-color")
                if fc:
                    style["fill"] = fc
            if "font-family" in node:
                ff = node["font-family"]
                # Map sourcesanspro → Inter
                if "source" in ff.lower() or "sans" in ff.lower():
                    style["fontFamily"] = "Inter"
                else:
                    style["fontFamily"] = "Inter"  # Default all to Inter
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(content_obj)
    return style

def get_fill(detail):
    """Extract fill color from shape"""
    fills = detail.get("fills", [])
    if fills and isinstance(fills, list) and fills:
        fc = fills[0].get("fill-color")
        fo = fills[0].get("fill-opacity", 1.0)
        if fc and fo > 0:
            return fc
    return None

def get_stroke(detail):
    """Extract stroke from shape"""
    strokes = detail.get("strokes", [])
    if strokes and isinstance(strokes, list) and strokes:
        sc = strokes[0].get("stroke-color")
        sw = strokes[0].get("stroke-width", 1)
        so = strokes[0].get("stroke-opacity", 1.0)
        if sc and so > 0:
            return sc, sw
    return None, None

def get_corner_radius(detail):
    """Extract corner radius"""
    r1 = detail.get("r1") or detail.get("rx") or 0
    r2 = detail.get("r2") or detail.get("rx") or 0
    r3 = detail.get("r3") or detail.get("rx") or 0
    r4 = detail.get("r4") or detail.get("rx") or 0
    if r1 or r2 or r3 or r4:
        return [int(r1), int(r2), int(r3), int(r4)]
    return None

def convert_shape(detail, frame_y_offset, parent_x, parent_y, binding_prefix, idx):
    """Convert a single Penpot shape to Pencil DSL operation"""
    shape_type = detail["type"]
    name = detail.get("name", f"shape_{idx}")
    
    # Relative position within the frame
    x = round(detail.get("x", 0) - parent_x)
    y = round(detail.get("y", 0) - parent_y)
    w = round(detail.get("width", 0))
    h = round(detail.get("height", 0))
    
    binding = sanitize_binding(name, idx)
    
    props = []
    props.append(f'name: "{escape_content(name)}"')
    props.append(f'x: {x}')
    props.append(f'y: {y}')
    props.append(f'width: {w}')
    props.append(f'height: {h}')
    
    if shape_type == "text":
        content = extract_text_content(detail.get("content", {}))
        style = extract_text_style(detail.get("content", {}))
        
        if not content:
            content = name  # Fallback to name
        
        props.append(f'content: "{escape_content(content)}"')
        props.append(f'fontSize: {style["fontSize"]}')
        props.append(f'fontFamily: "{style["fontFamily"]}"')
        props.append(f'fontWeight: {style["fontWeight"]}')
        props.append(f'fill: "{style["fill"]}"')
        
        return binding, f'{binding}=I(frame, {{type: "text", {", ".join(props)}}})'
    
    elif shape_type == "rect" or shape_type == "frame":
        fill = get_fill(detail)
        stroke_color, stroke_width = get_stroke(detail)
        corner_radius = get_corner_radius(detail)
        
        if fill:
            props.append(f'fill: "{fill}"')
        
        if stroke_color:
            props.append(f'stroke: "{stroke_color}"')
            props.append(f'strokeWidth: {int(stroke_width)}')
        
        if corner_radius:
            props.append(f'cornerRadius: {corner_radius}')
        
        opacity = detail.get("opacity", 1)
        if opacity < 1:
            props.append(f'opacity: {opacity}')
        
        return binding, f'{binding}=I(frame, {{type: "rectangle", {", ".join(props)}}})'
    
    elif shape_type == "circle":
        fill = get_fill(detail)
        stroke_color, stroke_width = get_stroke(detail)
        
        if fill:
            props.append(f'fill: "{fill}"')
        if stroke_color:
            props.append(f'stroke: "{stroke_color}"')
            props.append(f'strokeWidth: {int(stroke_width)}')
        
        return binding, f'{binding}=I(frame, {{type: "ellipse", {", ".join(props)}}})'
    
    else:
        # Default to rectangle
        fill = get_fill(detail)
        if fill:
            props.append(f'fill: "{fill}"')
        return binding, f'{binding}=I(frame, {{type: "rectangle", {", ".join(props)}}})'

def convert_file(name, data):
    """Convert an entire file's data to Pencil DSL operations"""
    tree = data["tree"]
    details = data["details"]
    
    y_offset = Y_POSITIONS.get(name, 0)
    
    # Find the root frame(s) - direct children of root
    root_children = tree.get("children", [])
    if not root_children:
        print(f"  No root children for {name}")
        return []
    
    all_ops_groups = []
    
    for rc in root_children:
        frame_id = rc["id"]
        frame_detail = details.get(frame_id, rc)
        
        frame_name = frame_detail.get("name", name)
        frame_x = frame_detail.get("x", 0)
        frame_y = frame_detail.get("y", 0)
        frame_w = round(frame_detail.get("width", 1440))
        frame_h = round(frame_detail.get("height", 900))
        
        fill = get_fill(frame_detail) or "#0B0D14"
        
        # Create frame operation
        frame_op = f'frame=I(document, {{type: "frame", name: "{escape_content(frame_name)}", x: 0, y: {y_offset}, width: {frame_w}, height: {frame_h}, fill: "{fill}", layout: "none", placeholder: false}})'
        
        # Collect all leaf shapes (flatten nested frames)
        ops = [frame_op]
        
        def process_children(children, parent_x, parent_y, depth=0):
            for i, child in enumerate(children):
                cid = child["id"]
                child_detail = details.get(cid)
                if not child_detail:
                    continue
                
                child_type = child_detail["type"]
                
                if child_type == "frame" and child.get("children"):
                    # Nested frame: emit as rectangle background, then process children
                    _, op = convert_shape(child_detail, y_offset, parent_x, parent_y, name, len(ops))
                    ops.append(op)
                    # Process nested children with the ORIGINAL parent coords (flat layout)
                    process_children(child.get("children", []), parent_x, parent_y, depth+1)
                else:
                    _, op = convert_shape(child_detail, y_offset, parent_x, parent_y, name, len(ops))
                    ops.append(op)
        
        process_children(rc.get("children", []), frame_x, frame_y)
        
        # Split into batches of 25 max
        batch_size = 24  # 24 + 1 frame = 25
        batches = []
        # First batch includes the frame creation + first 24 children
        first_batch = ops[:25]
        batches.append(first_batch)
        
        remaining = ops[25:]
        while remaining:
            batch = remaining[:25]
            batches.append(batch)
            remaining = remaining[25:]
        
        all_ops_groups.append({
            "name": frame_name,
            "batches": batches,
            "total_ops": len(ops)
        })
    
    return all_ops_groups

def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "all"
    
    pages = json.load(open("/Users/mk-mac-391/project/mars/design/all_pages.json"))
    
    for p in pages:
        name = p["name"]
        if target != "all" and name != target:
            continue
        
        detail_file = os.path.join(EXTRACTED_DIR, f"{name}_details.json")
        if not os.path.exists(detail_file):
            print(f"SKIP {name}: not yet extracted")
            continue
        
        print(f"\n=== Converting {name} ===")
        data = json.load(open(detail_file))
        groups = convert_file(name, data)
        
        for g in groups:
            out_file = os.path.join(OUT_DIR, f"{name}_ops.json")
            with open(out_file, "w") as f:
                json.dump(g, f, indent=2)
            print(f"  {g['name']}: {g['total_ops']} ops in {len(g['batches'])} batches → {out_file}")

if __name__ == "__main__":
    main()
