#!/bin/bash
# Penpot MCP Helper Script
# Usage: ./penpot-mcp.sh <tool_name> '<json_args>'

PENPOT_URL="http://localhost:8787/mcp"

# Initialize session
SESSION=$(curl -sv -X POST "$PENPOT_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"migrator","version":"1.0"}}}' 2>&1 | grep "mcp-session-id" | awk '{print $3}' | tr -d '\r')

if [ -z "$SESSION" ]; then
  echo "ERROR: Failed to get session" >&2
  exit 1
fi

TOOL_NAME="$1"
TOOL_ARGS="$2"

# Call tool
RESPONSE=$(curl -s -X POST "$PENPOT_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL_NAME\",\"arguments\":$TOOL_ARGS}}" 2>&1)

# Extract the text content from the SSE response
echo "$RESPONSE" | sed 's/^event: message$//' | sed 's/^data: //' | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if 'result' in data:
        for c in data['result'].get('content', []):
            if c.get('type') == 'text':
                print(c['text'])
    elif 'error' in data:
        print(json.dumps(data['error'], indent=2))
except Exception as e:
    print(f'Parse error: {e}', file=sys.stderr)
    sys.stdin.seek(0)
    print(sys.stdin.read())
"
