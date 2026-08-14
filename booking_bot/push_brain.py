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

import base64
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


def token_issued_at(auth):
    """`iat` out of a bearer's JWT payload, or 0 if it does not read as one."""
    try:
        payload = auth.split()[-1].split(".")[1]
        payload += "=" * (-len(payload) % 4)          # JWTs drop the padding
        return int(json.loads(base64.urlsafe_b64decode(payload)).get("iat", 0))
    except Exception:
        return 0


def load_servers():
    """Every n8n MCP credential in ~/.claude.json, newest token first.

    The server is configured for Claude Code rather than for this script, so it
    is read from there instead of being duplicated into .env. It has been
    registered at the top level and under several projects, under both `n8n` and
    `n8n-mcp`, and the stale entries are never cleaned up — reading one fixed
    name found a revoked token and answered 401 for two days while a working one
    sat in the same file under a different name.

    Newest first is a guess, not an answer: a token can authenticate perfectly
    and still belong to an n8n account that cannot see this workflow, which is
    exactly what the newest one does. `select_server` is what settles it.
    """
    with open(os.path.expanduser(r"~\.claude.json"), encoding="utf-8") as fh:
        cfg = json.load(fh)

    scopes = [cfg.get("mcpServers") or {}]
    scopes += [p.get("mcpServers") or {} for p in (cfg.get("projects") or {}).values()]

    found = []
    for servers in scopes:
        for name, srv in servers.items():
            if "n8n" not in name.lower() or not isinstance(srv, dict):
                continue
            auth = (srv.get("headers") or {}).get("Authorization")
            if srv.get("url") and auth:
                found.append((token_issued_at(auth), srv["url"], auth))
    if not found:
        raise SystemExit("no n8n MCP server with a bearer token in ~/.claude.json")
    return sorted(found, key=lambda f: f[0], reverse=True)


CANDIDATES = load_servers()
URL, AUTH = CANDIDATES[0][1], CANDIDATES[0][2]


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


def select_server():
    """Pick the credential that can actually reach THIS workflow.

    Authenticating is not the same as having access. On 2026-08-14 the newest
    token in the file authenticated fine, registered all 34 tools, and belonged
    to an n8n account with no workflows in it at all — `get_workflow_details`
    came back "Workflow not found or you don't have permission", which reads
    like a missing workflow and is really a wrong account.

    So each credential is tried against the workflow itself, newest first, and
    the first that can see it wins. If none can, the failure names every one
    that was tried rather than reporting whichever error came last.
    """
    global URL, AUTH
    tried = []
    for iat, url, auth in CANDIDATES:
        URL, AUTH = url, auth
        try:
            rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "push_brain", "version": "1"}})
            res = rpc("tools/call", {"name": "get_workflow_details",
                                     "arguments": {"workflowId": WORKFLOW_ID}})
            if not res.get("isError"):
                return
            why = "no access to this workflow"
        except urllib.error.HTTPError as exc:
            why = f"HTTP {exc.code}"
        except SystemExit as exc:
            why = str(exc)
        # ASCII only: this goes to stderr, which a Windows console prints in a
        # legacy codepage, and a mangled character in the one message that
        # explains the failure is a poor way to explain anything.
        tried.append(f"  token issued {iat}, ending {auth[-8:]}: {why}")

    raise SystemExit(
        f"no n8n credential in ~/.claude.json can reach workflow {WORKFLOW_ID}:\n"
        + "\n".join(tried)
        + "\n\nMint an MCP access token in the n8n account that OWNS this "
          "workflow, and put it in ~/.claude.json under an mcpServers entry "
          "whose name contains 'n8n'.")


def call_tool(name, args):
    res = rpc("tools/call", {"name": name, "arguments": args})
    text = "".join(c.get("text", "") for c in res.get("content", []))
    if res.get("isError"):
        raise SystemExit(f"{name} returned an error:\n{text}")
    return text


def main():
    select_server()

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
