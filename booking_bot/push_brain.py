"""
Push booking_bot/brain.js (and the Config access lists) into the live n8n workflow.

An MCP tool call cannot carry the ~41 KB Brain jsCode — it would have to be typed
out. This speaks the same MCP endpoint over JSON-RPC instead, reading the file
straight off disk.

    python push_brain.py            # update the draft only
    python push_brain.py --publish  # update, then activate the new version

Notes:
  * the bearer token is read from ~/.claude.json and never printed;
  * Cloudflare 1010-bans urllib's default user-agent, so a browser UA is set;
  * n8n refuses the update while the workflow is open in a browser tab.
"""

import json
import os
import sys
import urllib.request

WORKFLOW_ID = "2H97FsGnzwmzl7YE"
HERE = os.path.dirname(os.path.abspath(__file__))
BRAIN_PATH = os.path.join(HERE, "brain.js")

ADMIN_USERS = "7941350507,@AbdulrahmanMohamed5,1226903540,5793725130"
CASHIER_USERS = "@Seifgamal24,@seiiffseiif"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

_id = 0


def load_server():
    with open(os.path.expanduser(r"~\.claude.json"), encoding="utf-8") as fh:
        cfg = json.load(fh)
    srv = cfg["mcpServers"]["n8n-mcp"]
    return srv["url"], srv["headers"]["Authorization"]


URL, AUTH = load_server()


def rpc(method, params=None):
    """One JSON-RPC call. The endpoint answers with SSE framing, not plain JSON."""
    global _id
    _id += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _id, "method": method,
                       "params": params or {}}).encode("utf-8")
    req = urllib.request.Request(URL, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": AUTH,
        "User-Agent": UA,
    })
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read().decode("utf-8")
    for line in raw.splitlines():
        if line.startswith("data:"):
            raw = line[5:].strip()
            break
    out = json.loads(raw)
    if "error" in out:
        raise SystemExit(f"{method} failed: {out['error']}")
    return out.get("result", {})


def call_tool(name, args):
    res = rpc("tools/call", {"name": name, "arguments": args})
    text = "".join(c.get("text", "") for c in res.get("content", []))
    if res.get("isError"):
        raise SystemExit(f"{name} returned an error:\n{text}")
    return text


def main():
    rpc("initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "push_brain", "version": "1.0"},
    })

    with open(BRAIN_PATH, encoding="utf-8") as fh:
        brain = fh.read()
    print(f"brain.js: {len(brain)} chars")

    detail = json.loads(call_tool("get_workflow_details", {"workflowId": WORKFLOW_ID}))
    wf = detail["workflow"]
    print(f"workflow: {wf['name']} — active={wf['active']} nodes={len(wf['nodes'])}")

    config = next(n for n in wf["nodes"] if n["name"] == "Config")
    assignments = config["parameters"]["assignments"]["assignments"]

    # Rewrite the two access-list entries in place, keeping every other value
    # (including BOT_TOKEN) exactly as the live workflow has it — the token is
    # never read into this script's own source or its output.
    renames = {"BOOKING_USER_IDS": ("ADMIN_USERS", ADMIN_USERS),
               "EXPENSE_USERNAMES": ("CASHIER_USERS", CASHIER_USERS)}
    seen = set()
    for a in assignments:
        if a["name"] in renames:
            a["name"], a["value"] = renames[a["name"]]
            seen.add(a["name"])
        elif a["name"] in ("ADMIN_USERS", "CASHIER_USERS"):
            a["value"] = ADMIN_USERS if a["name"] == "ADMIN_USERS" else CASHIER_USERS
            seen.add(a["name"])
    for missing, value in (("ADMIN_USERS", ADMIN_USERS), ("CASHIER_USERS", CASHIER_USERS)):
        if missing not in seen:
            assignments.append({"id": missing.lower(), "name": missing,
                                "value": value, "type": "string"})
    print("config keys:", ", ".join(a["name"] for a in assignments))

    ops = [
        {"type": "updateNodeParameters", "nodeName": "Brain",
         "parameters": {"jsCode": brain}},
        {"type": "updateNodeParameters", "nodeName": "Config",
         "parameters": {"assignments": {"assignments": assignments}}},
    ]
    print(call_tool("update_workflow", {"workflowId": WORKFLOW_ID, "operations": ops}))

    if "--publish" in sys.argv:
        print(call_tool("publish_workflow", {"workflowId": WORKFLOW_ID}))


if __name__ == "__main__":
    main()
