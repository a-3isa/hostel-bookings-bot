"""
Check bookings-bot.workflow.json before n8n ever sees it.

n8n imports a broken graph quite happily: a connection naming a node that does
not exist is dropped silently, and an orphan node simply never runs. Both look
exactly like "the bot ignored me" from Telegram, which is the most expensive
kind of bug this project has — the first symptom is a receptionist saying the
buttons stopped working.

So the structural claims are checked here, where they are cheap:

  * every connection endpoint names a node that exists;
  * every node except the triggers is reachable from a trigger;
  * every node name referenced by a Code node's `$('...')` exists, because that
    is a runtime error n8n cannot catch at import;
  * the Sheets `append` operation appears nowhere — it writes empty strings into
    the sheet's formula columns and destroys them.

    python booking_bot/validate_workflow.py
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WF_PATH = os.path.join(HERE, "bookings-bot.workflow.json")

TRIGGER_TYPES = ("Trigger", "trigger")

NODE_REF = re.compile(r"\$\(\s*'([^']+)'\s*\)")


CFG_KEY = re.compile(r"\bCFG\.([A-Z][A-Z0-9_]*)")
SAVE_FLOW = re.compile(r"flow:\s*'([a-z_]+)'")


def js_sources():
    """brain.js and every node body, as text. The graph's real contract."""
    out = [os.path.join(HERE, "brain.js")]
    nodes_dir = os.path.join(HERE, "nodes")
    if os.path.isdir(nodes_dir):
        out += [os.path.join(nodes_dir, f) for f in sorted(os.listdir(nodes_dir))
                if f.endswith(".js")]
    for path in out:
        with open(path, encoding="utf-8") as fh:
            yield os.path.basename(path), fh.read()


def cfg_keys_used():
    """Every CFG.* the JS reads, across the Brain and the node bodies."""
    keys = set()
    for _name, src in js_sources():
        keys.update(CFG_KEY.findall(src))
    return keys


def brain_flows():
    """Every save.flow literal brain.js can emit."""
    with open(os.path.join(HERE, "brain.js"), encoding="utf-8") as fh:
        return set(SAVE_FLOW.findall(fh.read()))


def load():
    """The generated graph, or whichever file was named on the command line.

    `deploy_graph.py --offline` writes a second file with its twenty nodes
    merged in, and that is the one that gets imported by hand — so it has to be
    checkable by the same rules, not taken on trust because it was generated.
    """
    path = next((a for a in sys.argv[1:] if not a.startswith("-")), WF_PATH)
    if not os.path.exists(path):
        sys.exit(f"{path} does not exist — run build_workflow.py first")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    wf = load()
    nodes = {n["name"]: n for n in wf["nodes"]}
    conns = wf.get("connections", {})
    problems = []

    # 1. Connection endpoints.
    for src, spec in conns.items():
        if src not in nodes:
            problems.append(f"connection from unknown node {src!r}")
        for branch in spec.get("main", []):
            for link in branch:
                if link["node"] not in nodes:
                    problems.append(f"{src} -> unknown node {link['node']!r}")

    # 2. Reachability. A node nothing reaches never runs, and n8n will not say so.
    triggers = [n for n in wf["nodes"] if any(t in n["type"] for t in TRIGGER_TYPES)]
    if not triggers:
        problems.append("no trigger node — nothing can start this workflow")
    seen = set()
    queue = [t["name"] for t in triggers]
    while queue:
        cur = queue.pop()
        if cur in seen:
            continue
        seen.add(cur)
        for branch in conns.get(cur, {}).get("main", []):
            queue += [l["node"] for l in branch if l["node"] in nodes]
    for name in nodes:
        if name not in seen:
            problems.append(f"orphan: {name!r} is not reachable from any trigger")

    # 3. Node names referenced from inside Code nodes. `$('Brain')` is resolved
    #    at runtime, so a rename that misses one fails only when that branch is
    #    first exercised — which for the edit flow could be days later.
    for node in wf["nodes"]:
        code = node.get("parameters", {}).get("jsCode")
        if not code:
            continue
        for ref in sorted(set(NODE_REF.findall(code))):
            if ref not in nodes:
                problems.append(f"{node['name']}: $('{ref}') names no node")

    # 4. Config covers every key the JS reads. `CFG.GROUP_CHAT_ID` on a Config
    #    node that has no such assignment is `undefined`, which reaches Telegram
    #    as the string "undefined" and posts the announcement into nothing.
    cfg = nodes.get("Config")
    if cfg is None:
        problems.append("no Config node")
    else:
        have = {a["name"] for a in
                cfg["parameters"]["assignments"]["assignments"]}
        for key in sorted(cfg_keys_used()):
            if key not in have:
                problems.append(f"Config has no {key}, and the JS reads CFG.{key}")

    # 5. Every save.flow the Brain can emit has somewhere to go. Adding a flow
    #    to brain.js and forgetting the route means that save silently does
    #    nothing — the switch drops it, since fallbackOutput is none.
    flows = brain_flows()
    route = nodes.get("Route Save")
    if route is None:
        problems.append("no Route Save node")
    elif flows:
        keys = {r.get("outputKey") for r in
                route["parameters"]["rules"]["values"]}
        for flow in sorted(flows - keys):
            problems.append(f"brain.js emits save.flow {flow!r} and Route Save "
                            "has no output for it")
        for extra in sorted(keys - flows):
            problems.append(f"Route Save routes {extra!r}, which brain.js never emits")

    # 6. The append ban.
    for node in wf["nodes"]:
        if node["type"].endswith("googleSheets"):
            op = node.get("parameters", {}).get("operation")
            if op == "append" or op == "appendOrUpdate":
                problems.append(
                    f"{node['name']}: Sheets operation {op!r} — this writes empty "
                    "strings into the formula columns (K, N, P, R, S, T)")

    # 7. Telegram send-a-file operations carry the file in `file`.
    #
    #    The property is NOT called `photo`, `document` or `video` — the node
    #    names all of them `file`, and n8n silently drops a property it does not
    #    recognise. The request then reaches Telegram with nothing attached and
    #    comes back "Bad Request: there is no photo in the request", which is
    #    what happened on 2026-08-15 and took the rest of the turn with it.
    FILE_OPS = {"sendPhoto", "sendDocument", "sendVideo", "sendAudio",
                "sendAnimation", "sendSticker"}
    for node in wf["nodes"]:
        if not node["type"].endswith("telegram"):
            continue
        params = node.get("parameters", {})
        if params.get("operation") not in FILE_OPS:
            continue
        if params.get("binaryData"):
            continue
        if not params.get("file"):
            problems.append(
                f"{node['name']}: {params['operation']} has no 'file' parameter"
                " — the file id belongs in `file`, and any other name is dropped")

    print(f"{wf['name']}: {len(nodes)} nodes, {len(conns)} with outgoing connections")
    if problems:
        print(f"\n{len(problems)} problem(s):")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)
    print("no dangling connections, no orphans, no banned operations")


if __name__ == "__main__":
    main()
