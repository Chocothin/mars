#!/usr/bin/env python3
"""
Insert converted Pencil DSL operations into mars.pen via batch_design.
Usage: python3 insert_to_pencil.py <name> [--dry-run]

Strategy:
- Batch 1: Create frame + first 24 children → get frame ID
- Batch 2+: Use frame ID as parent for remaining children
"""
import json, sys, os

def load_ops(name):
    ops_file = f"/Users/mk-mac-391/project/mars/design/pencil_ops/{name}_ops.json"
    if not os.path.exists(ops_file):
        print(f"ERROR: {ops_file} not found")
        return None
    return json.load(open(ops_file))

def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "Pilot"
    dry_run = "--dry-run" in sys.argv
    
    data = load_ops(name)
    if not data:
        return
    
    print(f"Frame: {data['name']}")
    print(f"Total ops: {data['total_ops']}")
    print(f"Batches: {len(data['batches'])}")
    
    for i, batch in enumerate(data['batches']):
        print(f"\n--- Batch {i+1}: {len(batch)} ops ---")
        ops_str = "\n".join(batch)
        
        if dry_run:
            print(ops_str[:500])
            print("..." if len(ops_str) > 500 else "")
        else:
            print(f"Ready to insert via pencil_batch_design")
            print(f"Operations:\n{ops_str[:300]}...")

if __name__ == "__main__":
    main()
