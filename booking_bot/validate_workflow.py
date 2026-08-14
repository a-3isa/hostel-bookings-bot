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


def load():
    if not os.path.exists(WF_PATH):
        sys.exit(f"{WF_PATH} does not exist — run build_workflow.py first")
    with open(WF_PATH, encoding="utf-8") as fh:
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

    # 4. The append ban.
    for node in wf["nodes"]:
        if node["type"].endswith("googleSheets"):
            op = node.get("parameters", {}).get("operation")
            if op == "append" or op == "appendOrUpdate":
                problems.append(
                    f"{node['name']}: Sheets operation {op!r} — this writes empty "
                    "strings into the formula columns (K, N, P, R, S, T)")

    print(f"{wf['name']}: {len(nodes)} nodes, {len(conns)} with outgoing connections")
    if problems:
        print(f"\n{len(problems)} problem(s):")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)
    print("no dangling connections, no orphans, no banned operations")


if __name__ == "__main__":
    main()
