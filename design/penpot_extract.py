#!/usr/bin/env python3
"""
Penpot MCP extraction: single-file shape extractor.
Produces deterministic, sorted JSON output with schema versioning.
"""
import requests, json, sys, time
from datetime import datetime, timezone

PENPOT_URL = "http://localhost:8787/mcp"
HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
}

SCHEMA_ID = "mars-extract-v1"
FORMAT_VERSION = "1.0.0"
MAX_RETRIES = 3
RETRY_BACKOFF_S = 2


def init_session():
    r = requests.post(PENPOT_URL, headers=HEADERS, json={
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                   "clientInfo": {"name": "migrator", "version": "1.0"}}
    })
    return r.headers.get("mcp-session-id")


def call_tool(session, tool_name, args):
    """Call an MCP tool with retry logic (3 retries, 2s backoff)."""
    h = {**HEADERS, "Mcp-Session-Id": session}
    last_err = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = requests.post(PENPOT_URL, headers=h, json={
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {"name": tool_name, "arguments": args}
            })
            r.raise_for_status()

            for line in r.text.strip().split("\n"):
                if line.startswith("data: "):
                    data = json.loads(line[6:])
                    if "result" in data:
                        for c in data["result"].get("content", []):
                            if c.get("type") == "text":
                                return json.loads(c["text"])
            return None

        except (requests.RequestException, json.JSONDecodeError, KeyError) as e:
            last_err = e
            if attempt < MAX_RETRIES:
                wait = RETRY_BACKOFF_S * attempt
                print(f"  Retry {attempt}/{MAX_RETRIES} for {tool_name} "
                      f"(waiting {wait}s): {e}", file=sys.stderr)
                time.sleep(wait)

    print(f"  FAILED {tool_name} after {MAX_RETRIES} attempts: {last_err}",
          file=sys.stderr)
    return None


def sort_objects(objects):
    if isinstance(objects, list):
        return sorted(objects, key=lambda o: o.get("id", "") if isinstance(o, dict) else "")
    return objects


def extract_frame(file_id, output_path):
    session = init_session()
    pages = call_tool(session, "get_file_pages", {"file_id": file_id})
    if not pages:
        print(f"No pages found for {file_id}", file=sys.stderr)
        return
    page_id = pages[0]["id"]
    page_name = pages[0]["name"]
    print(f"Page: {page_name} ({page_id}), objects: {pages[0]['object_count']}")

    objects = call_tool(session, "get_page_objects", {"file_id": file_id, "page_id": page_id})
    if not objects:
        print("No objects found", file=sys.stderr)
        return

    objects = sort_objects(objects)

    result = {
        "$schema": SCHEMA_ID,
        "version": FORMAT_VERSION,
        "extractedAt": datetime.now(timezone.utc).isoformat(),
        "file_id": file_id,
        "page_id": page_id,
        "page_name": page_name,
        "objects": objects,
    }

    with open(output_path, "w") as f:
        json.dump(result, f, sort_keys=True, indent=2)
    print(f"Saved {len(objects)} objects to {output_path}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 penpot_extract.py <file_id> <output.json>")
        sys.exit(1)
    extract_frame(sys.argv[1], sys.argv[2])
