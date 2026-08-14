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

# This script's own messages are ASCII, but --check prints workflow names and
# those are Arabic. A Windows console defaults to a codepage that cannot encode
# them, and the run would die printing its own answer.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
BRAIN_PATH = os.path.join(HERE, "brain.js")

# The workflow these scripts push into. It is NOT a constant any more: the
# instance holding `2H97FsGnzwmzl7YE` was destroyed on 2026-08-14, so the id is
# whatever the rebuilt workflow gets when it is imported, and hard-coding a dead
# one means every run fails in a way that looks like a permissions problem.
#
#   N8N_WORKFLOW_ID=...        for one run
#   booking_bot/.workflow_id   written once after the import, git-ignored
WORKFLOW_ID_PATH = os.path.join(HERE, ".workflow_id")


def load_workflow_id():
    env = os.environ.get("N8N_WORKFLOW_ID", "").strip()
    if env:
        return env
    if os.path.exists(WORKFLOW_ID_PATH):
        with open(WORKFLOW_ID_PATH, encoding="utf-8") as fh:
            return fh.read().strip()
    return ""


WORKFLOW_ID = load_workflow_id()

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
            # A bearer is optional. `claude mcp add` registers a server without
            # one, and an n8n whose MCP endpoint does not demand a token is a
            # perfectly usable server — requiring a header here skipped exactly
            # the entry that was meant to replace the revoked ones.
            auth = (srv.get("headers") or {}).get("Authorization", "")
            if srv.get("url"):
                found.append((token_issued_at(auth), srv["url"], auth))
    if not found:
        raise SystemExit("no n8n MCP server in ~/.claude.json")
    return sorted(found, key=lambda f: f[0], reverse=True)


CANDIDATES = load_servers()
URL, AUTH = CANDIDATES[0][1], CANDIDATES[0][2]


def rpc(method, params=None):
    """One JSON-RPC call. The endpoint answers with SSE framing, not plain JSON."""
    global _id
    _id += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _id, "method": method,
                       "params": params or {}}).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": UA,
    }
    # Sent only when there is one. An empty Authorization header is not the same
    # as no header: some gateways reject it outright.
    if AUTH:
        headers["Authorization"] = AUTH
    req = urllib.request.Request(URL, data=body, method="POST", headers=headers)
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

    Before the rebuilt workflow has been imported there is no id to probe with,
    so the test falls back to "can this server list workflows at all" — which is
    enough to create one, and creating one is the next thing that has to happen.
    """
    global URL, AUTH
    tried = []
    want = f"workflow {WORKFLOW_ID}" if WORKFLOW_ID else "any workflow"
    for iat, url, auth in CANDIDATES:
        URL, AUTH = url, auth
        try:
            rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "push_brain", "version": "1"}})
            if WORKFLOW_ID:
                res = rpc("tools/call", {"name": "get_workflow_details",
                                         "arguments": {"workflowId": WORKFLOW_ID}})
                why = "no access to this workflow"
            else:
                res = rpc("tools/call", {"name": "search_workflows", "arguments": {}})
                why = "cannot list workflows"
            if not res.get("isError"):
                return
        except urllib.error.HTTPError as exc:
            why = f"HTTP {exc.code}"
        except urllib.error.URLError as exc:
            # A TLS failure is the one worth naming outright. On 2026-08-14 this
            # host sat behind a FortiGate doing TLS inspection, and every request
            # through it would have handed the appliance the bearer in clear.
            why = f"connection failed: {exc.reason}"
        except SystemExit as exc:
            why = str(exc)
        # ASCII only: this goes to stderr, which a Windows console prints in a
        # legacy codepage, and a mangled character in the one message that
        # explains the failure is a poor way to explain anything.
        label = f"ending {auth[-8:]}" if auth else "no bearer"
        tried.append(f"  {label}, issued {iat}: {why}")

    raise SystemExit(
        f"no n8n server in ~/.claude.json can reach {want}:\n"
        + "\n".join(tried)
        + "\n\nEither the server needs an MCP access token from the n8n account "
          "that owns it, or booking_bot/.workflow_id names a workflow that no "
          "longer exists — clear it to probe for any workflow instead.")


def require_workflow_id():
    if WORKFLOW_ID:
        return WORKFLOW_ID
    raise SystemExit(
        "no workflow id. The instance holding 2H97FsGnzwmzl7YE was destroyed, so\n"
        "there is nothing to push into until the rebuilt graph has been imported:\n\n"
        "    python booking_bot/build_workflow.py\n"
        "    # import bookings-bot.workflow.json into n8n\n"
        f"    echo <new-id> > {os.path.relpath(WORKFLOW_ID_PATH, os.path.dirname(HERE))}\n\n"
        "or set N8N_WORKFLOW_ID for a single run.")


def check():
    """Report what this machine can reach, and push nothing.

    The first question in any session is whether the endpoint is usable at all —
    and answering it by running a deploy means finding out half way through.
    """
    print(f"workflow id: {WORKFLOW_ID or '(unset — nothing imported yet)'}")
    print(f"candidates:  {len(CANDIDATES)}")
    select_server()
    print(f"reachable:   {URL}")
    print(f"bearer:      {'yes, ending ' + AUTH[-8:] if AUTH else 'none'}")
    got = call_tool("search_workflows", {})
    data = json.loads(got).get("data", [])
    print(f"workflows:   {len(data)}")
    for wf in data[:10]:
        print(f"  {wf.get('id')}  {wf.get('name')}"
              f"  active={wf.get('active')}")


def call_tool(name, args):
    res = rpc("tools/call", {"name": name, "arguments": args})
    text = "".join(c.get("text", "") for c in res.get("content", []))
    if res.get("isError"):
        raise SystemExit(f"{name} returned an error:\n{text}")
    return text


def main():
    if "--check" in sys.argv:
        check()
        return

    require_workflow_id()
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
