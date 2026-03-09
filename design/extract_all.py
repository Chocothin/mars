#!/usr/bin/env python3
"""
Extract all shape details from all 18 Penpot files.
Produces deterministic, checksummed JSON with schema versioning.
"""
import requests, json, sys, time, os, hashlib, argparse
from datetime import datetime, timezone
from collections import OrderedDict

URL = "http://localhost:8787/mcp"
HEADERS = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
OUT_DIR = "/Users/mk-mac-391/project/mars/design/extracted"
CHECKSUMS_PATH = os.path.join(OUT_DIR, "checksums.json")

SCHEMA_ID = "mars-extract-v1"
FORMAT_VERSION = "1.0.0"
MAX_RETRIES = 3
RETRY_BACKOFF_S = 2

os.makedirs(OUT_DIR, exist_ok=True)


def init_session():
    r = requests.post(URL, headers=HEADERS, json={
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                   "clientInfo": {"name": "migrator", "version": "1.0"}}
    })
    sid = r.headers.get("mcp-session-id", "")
    HEADERS["Mcp-Session-Id"] = sid
    return sid


def call_tool(name, args, req_id=2):
    """Retry-enabled MCP tool call (3 retries, 2s exponential backoff)."""
    last_err = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = requests.post(URL, headers=HEADERS, json={
                "jsonrpc": "2.0", "id": req_id, "method": "tools/call",
                "params": {"name": name, "arguments": args}
            })
            r.raise_for_status()

            for line in r.text.split("\n"):
                if line.startswith("data: "):
                    data = json.loads(line[6:])
                    if data.get("result", {}).get("isError"):
                        return None
                    txt = data["result"]["content"][0]["text"]
                    return json.loads(txt)
            return None

        except (requests.RequestException, json.JSONDecodeError, KeyError) as e:
            last_err = e
            if attempt < MAX_RETRIES:
                wait = RETRY_BACKOFF_S * attempt
                print(f"    Retry {attempt}/{MAX_RETRIES} for {name} "
                      f"(waiting {wait}s): {e}", file=sys.stderr)
                time.sleep(wait)

    print(f"    FAILED {name} after {MAX_RETRIES} attempts: {last_err}",
          file=sys.stderr)
    return None


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def sort_tree(node):
    if isinstance(node, dict):
        children = node.get("children", [])
        if isinstance(children, list):
            children = sorted(children, key=lambda c: c.get("id", "") if isinstance(c, dict) else "")
            for child in children:
                sort_tree(child)
            node["children"] = children
    return node


def load_checksums():
    if os.path.exists(CHECKSUMS_PATH):
        with open(CHECKSUMS_PATH) as f:
            return json.load(f)
    return {}


def save_checksums(checksums):
    with open(CHECKSUMS_PATH, "w") as f:
        json.dump(checksums, f, sort_keys=True, indent=2)


def build_checksums_from_existing_files():
    checksums = {}
    for filename in sorted(os.listdir(OUT_DIR)):
        if not filename.endswith("_details.json"):
            continue
        filepath = os.path.join(OUT_DIR, filename)
        if not os.path.isfile(filepath):
            continue
        checksums[filename] = sha256_file(filepath)
    return checksums


def ensure_checksums_file():
    if os.path.exists(CHECKSUMS_PATH):
        return False
    checksums = build_checksums_from_existing_files()
    if not checksums:
        return False
    save_checksums(checksums)
    print(f"Generated {CHECKSUMS_PATH} from existing *_details.json files")
    return True


def verify_checksums():
    ensure_checksums_file()
    checksums = load_checksums()
    if not checksums:
        print("No checksums.json found. Run extraction first.")
        return False

    all_ok = True
    for filename, expected_hash in sorted(checksums.items()):
        filepath = os.path.join(OUT_DIR, filename)
        if not os.path.exists(filepath):
            print(f"  MISSING  {filename}")
            all_ok = False
            continue
        actual_hash = sha256_file(filepath)
        if actual_hash == expected_hash:
            print(f"  OK       {filename}")
        else:
            print(f"  MISMATCH {filename}")
            print(f"           expected: {expected_hash}")
            print(f"           actual:   {actual_hash}")
            all_ok = False

    return all_ok


def extract_file(name, file_id, page_id, force=False):
    outfile = os.path.join(OUT_DIR, f"{name}_details.json")
    if os.path.exists(outfile) and not force:
        print(f"  SKIP {name} (already extracted, use --force to re-extract)")
        return json.load(open(outfile))

    tree = call_tool("get_shape_tree", {
        "file_id": file_id, "page_id": page_id, "depth": 10
    })
    if not tree:
        print(f"  ERROR: failed to get tree for {name}")
        return None

    shape_ids = []
    def collect_ids(node):
        if node.get("id") and node["id"] != "00000000-0000-0000-0000-000000000000":
            shape_ids.append(node["id"])
        for child in node.get("children", []):
            collect_ids(child)
    collect_ids(tree)

    shape_ids.sort()

    print(f"  {name}: {len(shape_ids)} shapes to extract details for...")

    details = {}
    failed_count = 0
    for i, sid in enumerate(shape_ids):
        detail = call_tool("get_shape_details", {
            "file_id": file_id, "page_id": page_id, "shape_id": sid
        }, req_id=i + 10)
        if detail:
            details[sid] = detail
        else:
            failed_count += 1
        if (i + 1) % 50 == 0:
            print(f"    {i + 1}/{len(shape_ids)} done...")

    sorted_tree = sort_tree(tree)

    sorted_details = OrderedDict(
        (k, details[k]) for k in sorted(details.keys())
    )

    result = {
        "$schema": SCHEMA_ID,
        "version": FORMAT_VERSION,
        "extractedAt": datetime.now(timezone.utc).isoformat(),
        "details": sorted_details,
        "file_id": file_id,
        "name": name,
        "page_id": page_id,
        "tree": sorted_tree,
    }

    with open(outfile, "w") as f:
        json.dump(result, f, sort_keys=True, indent=2)

    extracted = len(details)
    total = len(shape_ids)
    print(f"  {name}: saved {extracted}/{total} shape details "
          f"({failed_count} failed) to {outfile}")
    return result


def main():
    parser = argparse.ArgumentParser(description="Extract Penpot shape details")
    parser.add_argument("target", nargs="?", default="all",
                        help="File name to extract (e.g. R01) or 'all'")
    parser.add_argument("--force", action="store_true",
                        help="Re-extract even if output file exists")
    parser.add_argument("--verify", action="store_true",
                        help="Verify checksums of extracted files and exit")
    args = parser.parse_args()

    if args.verify:
        print("Verifying checksums...")
        ok = verify_checksums()
        sys.exit(0 if ok else 1)

    pages = json.load(open("/Users/mk-mac-391/project/mars/design/all_pages.json"))

    init_session()

    checksums = load_checksums()

    if args.target == "all":
        for p in pages:
            print(f"\n=== Extracting {p['name']} ({p['objects']} objects) ===")
            result = extract_file(p["name"], p["file_id"], p["page_id"],
                                  force=args.force)
            if result:
                fname = f"{p['name']}_details.json"
                checksums[fname] = sha256_file(os.path.join(OUT_DIR, fname))
    else:
        found = False
        for p in pages:
            if p["name"] == args.target:
                found = True
                print(f"\n=== Extracting {p['name']} ({p['objects']} objects) ===")
                result = extract_file(p["name"], p["file_id"], p["page_id"],
                                      force=args.force)
                if result:
                    fname = f"{p['name']}_details.json"
                    checksums[fname] = sha256_file(os.path.join(OUT_DIR, fname))
                break
        if not found:
            print(f"ERROR: target '{args.target}' not found in all_pages.json",
                  file=sys.stderr)
            sys.exit(1)

    save_checksums(checksums)
    print(f"\nChecksums written to {CHECKSUMS_PATH}")
    print("Done!")


if __name__ == "__main__":
    main()
