"""
Push named nodes from the generated workflow file into the live n8n workflow.

`push_brain.py` syncs the Brain and the Config lists; `deploy_graph.py` creates
the twenty nodes of its own branch. Neither owns the nodes that
`build_workflow.py` generates, so when a fix lands in the repo and the workflow
is already running, there was no way to move it across short of re-importing all
54 nodes and rebinding 31 credentials by hand. That is what this is for.

    python sync_nodes.py                    # what differs, pushes nothing
    python sync_nodes.py --diff             # every differing node, not just the default set
    python sync_nodes.py --apply            # update the draft
    python sync_nodes.py --apply --publish  # update, then activate
    python sync_nodes.py --apply "Route Save" "Answer Callback"

With no names it syncs DEFAULT_NODES: whichever nodes carry a fix that has not
reached the instance yet. It is edited as fixes land and clear — see the note
beside it for what is in it today and why.

Nodes it will not touch without being named outright (NEVER_DEFAULT):

  * Config holds BOT_TOKEN, the sheet gid and the real group chat ids. The
    committed file has placeholders in all of them, and pushing it would take
    the bot off the air.
  * Brain belongs to push_brain.py, which reads brain.js rather than the
    workflow file.
  * `Write Booking Row` carries a `columns.schema` that n8n fills in from the
    live tab — 3,900 characters the generated file does not have. Pushing it
    would drop what the node learned about the sheet.

    It is the only Sheets writer left. `Write Edit Row` and `Write Expense Row`
    are the same node type and carry the same learned schema, so naming either
    on the command line would strip it — they are simply not in NEVER_DEFAULT
    because nothing has needed to sync them. `Write Line Rows` stopped being a
    Sheets node on 2026-08-21 and has no schema to lose.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import push_brain as pb   # same directory; reuses its JSON-RPC plumbing

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "bookings-bot.full.workflow.json")

# The column-U write, which cost 24.6 s through the Sheets node and becomes one
# HTTP PUT, and the callback answer that now tells the user it is working.
DEFAULT_NODES = ["Write Booking Id", "Answer Callback", "Has Group?"]

# `Write Booking Id` is NOT here any more. It was, for the reason `Write Booking
# Row` still is — a Sheets writer carries a `columns.schema` that n8n learned
# from the live tab and the generated file does not have. As an httpRequest it
# has no schema to lose, so the reason expired with the node type.
NEVER_DEFAULT = {"Config", "Brain", "Write Booking Row"}


def load_source():
    with open(SOURCE, encoding="utf-8") as fh:
        wf = json.load(fh)
    return {n["name"]: n for n in wf["nodes"]}


# Node SETTINGS, which live beside `parameters` rather than inside it. They are
# not cosmetic: `executeOnce` is what stops a node running once per item, and
# `onError` is what keeps a failed group post from taking the whole save with
# it. Until 2026-08-18 nothing here compared them, so a fix that changed only a
# setting was invisible to --diff and unreachable by --apply — which is exactly
# what the `Has Group?` double-post fix was.
SETTING_KEYS = ("alwaysOutputData", "executeOnce", "retryOnFail", "maxTries",
                "waitBetweenTries", "onError")


def settings_diff(live, want):
    """Settings the generated file states and the instance does not match.

    Only keys the FILE declares. n8n omits a setting that equals its default,
    and the UI may have set others on purpose, so a key the file is silent
    about is the instance's business — the same reasoning that keeps Config and
    the Sheets writers out of a default run.
    """
    return {k: want[k] for k in SETTING_KEYS
            if k in want and live.get(k) != want[k]}


def differs(live, want):
    return (live["type"] != want["type"]
            or live.get("typeVersion") != want.get("typeVersion")
            or live.get("parameters") != want.get("parameters")
            or bool(settings_diff(live, want)))


def edges(conns, name):
    """Every connection touching `name`, as (source, sourceIndex, target)."""
    out = []
    for src, byType in conns.items():
        for branches in (byType.get("main") or [],):
            for i, branch in enumerate(branches or []):
                for c in branch or []:
                    if src == name or c["node"] == name:
                        out.append((src, i, c["node"], c.get("index", 0)))
    return out


def main():
    apply_ = "--apply" in sys.argv
    names = [a for a in sys.argv[1:] if not a.startswith("--")]

    pb.require_workflow_id()
    pb.select_server()
    wf = json.loads(pb.call_tool("get_workflow_details",
                                 {"workflowId": pb.WORKFLOW_ID}))["workflow"]
    live = {n["name"]: n for n in wf["nodes"]}
    conns = wf.get("connections", {})
    source = load_source()
    print(f"live: {wf['name']} — active={wf['active']} nodes={len(live)}")

    if "--diff" in sys.argv:
        for name, want in source.items():
            if name in live and differs(live[name], want):
                if live[name]["type"] != want["type"]:
                    mark = "TYPE"
                elif live[name].get("parameters") != want.get("parameters"):
                    mark = "params"
                else:
                    mark = "set"
                note = "  (not synced unless named)" if name in NEVER_DEFAULT else ""
                print(f"  {mark:6} {name}{note}")
        return

    if not names:
        names = DEFAULT_NODES
    missing = [n for n in names if n not in source or n not in live]
    if missing:
        raise SystemExit("not in both the file and the workflow: " + ", ".join(missing))

    # Credentials are bound in the UI and the committed file cannot know their
    # ids, so it carries REPLACE_ME. Resolve by type against the live instance.
    by_type = {}
    for c in json.loads(pb.call_tool("list_credentials", {"limit": 100}))["data"]:
        by_type.setdefault(c["type"], c)

    ops = []
    for name in names:
        want, have = source[name], live[name]
        if not differs(have, want):
            print(f"  same   {name}")
            continue

        if have["type"] != want["type"] or have.get("typeVersion") != want.get("typeVersion"):
            # A node's type cannot be edited in place. Remove it, add it back
            # under the same name, and restore every connection it had —
            # position included, so the canvas does not rearrange itself.
            print(f"  TYPE   {name}: {have['type']} -> {want['type']}")
            wires = edges(conns, name)
            ops.append({"type": "removeNode", "nodeName": name})
            node = {"name": name, "type": want["type"],
                    "typeVersion": want["typeVersion"],
                    "parameters": want["parameters"],
                    "position": have.get("position") or want.get("position")}
            ops.append({"type": "addNode", "node": node})
            for src, idx, tgt, tidx in wires:
                ops.append({"type": "addConnection", "source": src, "target": tgt,
                            "sourceIndex": idx, "targetIndex": tidx})
            for key in (want.get("credentials") or {}):
                cred = by_type.get(key)
                if not cred:
                    raise SystemExit(f"{name} needs a {key} credential and this "
                                     "account has none")
                ops.append({"type": "setNodeCredential", "nodeName": name,
                            "credentialKey": key, "credentialId": cred["id"],
                            "credentialName": cred["name"]})
            # maxTries and waitBetweenTries belong here too: retryOnFail without
            # them silently reverts to n8n's default count, so a node the file
            # says retries twice would retry three times on the instance.
            settings = {k: want[k] for k in SETTING_KEYS if k in want}
            if settings:
                ops.append({"type": "setNodeSettings", "nodeName": name,
                            "settings": settings})
        else:
            keys = [k for k in set(want["parameters"]) | set(have.get("parameters") or {})
                    if want["parameters"].get(k) != (have.get("parameters") or {}).get(k)]
            if keys:
                print(f"  params {name}: {', '.join(sorted(keys))}")
                ops.append({"type": "updateNodeParameters", "nodeName": name,
                            "parameters": want["parameters"], "replace": True})
            # Settings on their own, without a type change to carry them. A node
            # whose only difference is `executeOnce` used to reach this branch,
            # find no differing parameter, and push an identical parameter block
            # while the setting that mattered stayed as it was.
            changed = settings_diff(have, want)
            if changed:
                print(f"  set    {name}: "
                      + ', '.join(f"{k}={v}" for k, v in sorted(changed.items())))
                ops.append({"type": "setNodeSettings", "nodeName": name,
                            "settings": changed})

    if not ops:
        print("nothing to do")
        return
    if not apply_:
        print(f"\n{len(ops)} operations. Re-run with --apply to push them.")
        return

    print(pb.call_tool("update_workflow", {
        "workflowId": pb.WORKFLOW_ID, "operations": ops,
        "versionName": "sync_nodes: " + ", ".join(names),
    }))
    if "--publish" in sys.argv:
        print(pb.call_tool("publish_workflow", {"workflowId": pb.WORKFLOW_ID}))


if __name__ == "__main__":
    main()
