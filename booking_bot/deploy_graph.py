"""
Apply this repo's graph shape to the live n8n workflow.

`push_brain.py` syncs code into nodes that already exist. This script owns the
*structure*: it adds the nodes and connections the 2026-08-08 hardening round
needs, and rewrites the two gate/session nodes whose behaviour changed. It is
idempotent — every step checks the live graph first, so re-running is a no-op.

    python booking_bot/deploy_graph.py            # apply to the draft
    python booking_bot/deploy_graph.py --publish  # apply, then activate
    python booking_bot/deploy_graph.py --offline  # merge into the file instead

`--offline` exists because the MCP endpoint is not always reachable — a middlebox
is terminating its TLS at the time of writing. It applies exactly the same
operations to `bookings-bot.workflow.json` on disk and writes
`bookings-bot.full.workflow.json`, which is the whole bot in one file: import
that by hand and there is nothing left for this script to do. Credentials are
NOT written into it — they are bound in the n8n UI after the import, and the
list of what to bind is printed.

What it sets up:

  * Config gains REPORT_GROUP_CHAT_ID.
  * "Needs Bookings?" also fires on NOTES, the turn that draws the booking
    confirmation, so the availability check has rows to look at.
  * "Needs Locations?" / "Read Locations": the availability tab A3:B, read only
    on the turns that draw an apartment keyboard.
  * A schedule branch: Report Schedule -> Report Config -> Fetch Report Locations
    -> Read Report Locations -> Read Report Formulas -> Read Report Values ->
    Build Reports -> Send Report.
  * No Postgres (2026-10-12), by `sheet_only_ops`: sessions are Data Table nodes,
    the lookups are Sheets-API reads turned into rows by Code nodes, and the
    shadow-write, snapshot, reconcile and mirror-append branches are removed. It
    is the one place a node's TYPE is changed (remove, add, rewire), and it runs
    in batches of 90 operations because the endpoint takes at most 100.

The 08:00 schedule posts TWO messages to REPORT_GROUP_CHAT_ID: 🏠 تقرير
الإتاحة — the occupied rooms, today's departures and the empty rooms — and
💰 تقرير المديونيات, the outstanding balances. Asked for on 2026-09-21 (one
message at first, split in two later the same day), and both are built by
`nodes/build_reports.js`. The old ☀️ digest stays switched off inside that file:
it arrived every morning whether or not there was anything in it, and nobody
asked for it back.

Per-booking announcements are unaffected — `Post To Group` is a different node,
a different chat and a different trigger.
"""

import json
import os
import sys

# Windows consoles default to a legacy codepage; this script prints Arabic and
# arrows, and a UnicodeEncodeError here would abort a half-applied deploy.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import push_brain as pb   # same directory; reuses its JSON-RPC plumbing
import build_workflow as bw   # the node parameter shapes, defined once

HERE = os.path.dirname(os.path.abspath(__file__))

SHEET_ID = "1CiHciOeeyRMx9vz5cP0Xlid-jqM_gVjW3sUfore84S8"
BOOKINGS_TAB = "إدخال الحجوزات"
EXPENSE_TAB = "مصروفات عامة"
# Kept for reference, no longer read by this script: the registry moved to the
# `apartments`/`rooms` tables at Phase 4b. The tab itself stays — it is a report
# people use, it just is not the bot's room registry any more.
AVAILABILITY_TAB = "الإتاحة"
REPORT_GROUP_CHAT_ID = "-5057362381"

SHEETS_CRED = ("googleSheetsOAuth2Api", "plB4FVxraemXQcRt", "Google Sheets account")
TELEGRAM_CRED = ("telegramApi", "bjQrxjNH2WgrghIQ", "Telegram account")

# The file `build_workflow.py` writes, and the merged one this script writes when
# it cannot reach n8n. Kept apart deliberately: regenerating the graph must not
# silently drop the twenty nodes added here.
OFFLINE_IN = os.path.join(HERE, "bookings-bot.workflow.json")
OFFLINE_OUT = os.path.join(HERE, "bookings-bot.full.workflow.json")

# States whose turn draws an apartment keyboard, and so needs the registry.
LOCATION_STATES = ["PHONE", "EXP_AMOUNT", "EDIT_MENU", "AI_TEXT", "AI_PICK"]
# States whose turn needs the bookings tab: the two lookup steps, plus NOTES —
# the turn that builds the confirmation, where the availability check runs.
# AI_TEXT / AI_PICK are the AI edit's lookup turns.
BOOKING_STATES = ["EDIT_FIND", "EDIT_PICK", "NOTES", "AI_TEXT", "AI_PICK"]


def state_conditions(states, from_session=False):
    # One definition, in build_workflow.py. It used to be a copy here, and a second
    # copy is how the registry gate would have kept its wrong default.
    return bw.state_conditions(states, from_session)


def sheets_read(tab, rng, formula=False, execute_once=False):
    options = {"dataLocationOnSheet": {"values": {
        "rangeDefinition": "specifyRangeA1", "range": rng}}}
    if formula:
        # FORMULA exposes the live =TODAY()-J that marks an open-ended stay.
        # FORMATTED_STRING keeps تاريخ البداية readable rather than a serial.
        options["outputFormatting"] = {"values": {
            "general": "FORMULA", "date": "FORMATTED_STRING"}}
    return {
        "documentId": {"__rl": True, "mode": "id", "value": SHEET_ID},
        "sheetName": {"__rl": True, "mode": "name", "value": tab},
        "options": options,
    }


def read_source(name):
    with open(os.path.join(HERE, "nodes", name), encoding="utf-8") as fh:
        return fh.read()


def apply_offline(wf, ops):
    """Run the operations against a workflow held in memory.

    The same five verbs the MCP endpoint understands, so the file this produces
    and the graph a successful `--publish` produces are the same graph. Anything
    else in `ops` is a verb this has not been taught and is refused loudly rather
    than skipped: a silently dropped operation is a node that quietly does not
    exist in the imported bot.
    """
    nodes = {n["name"]: n for n in wf["nodes"]}
    conns = wf.setdefault("connections", {})
    for op in ops:
        kind = op["type"]
        if kind == "addNode":
            node = dict(op["node"])
            node.setdefault("id", node["name"].lower().replace(" ", "-").replace("?", ""))
            wf["nodes"].append(node)
            nodes[node["name"]] = node
        elif kind == "removeNode":
            # Like the endpoint, this takes the node's own wires with it, in both
            # directions: nothing is left pointing at a node that is gone.
            name = op["nodeName"]
            wf["nodes"] = [n for n in wf["nodes"] if n["name"] != name]
            nodes.pop(name, None)
            conns.pop(name, None)
            for spec in conns.values():
                for branches in spec.values():
                    for br in branches:
                        br[:] = [c for c in br if c["node"] != name]
        elif kind == "removeConnection":
            ctype = op.get("connectionType", "main")
            branches = conns.get(op["source"], {}).get(ctype, [])
            i = op["sourceIndex"]
            if i < len(branches):
                branches[i] = [c for c in branches[i] if c["node"] != op["target"]]
        elif kind == "addConnection":
            ctype = op.get("connectionType", "main")
            group = conns.setdefault(op["source"], {}).setdefault(ctype, [])
            while len(group) <= op["sourceIndex"]:
                group.append([])
            wired = {c["node"] for c in group[op["sourceIndex"]]}
            if op["target"] not in wired:
                group[op["sourceIndex"]].append({"node": op["target"], "type": ctype,
                                                 "index": op.get("targetIndex", 0)})
        elif kind == "updateNodeParameters":
            nodes[op["nodeName"]]["parameters"].update(op["parameters"])
        elif kind == "setNodeSettings":
            nodes[op["nodeName"]].update(op["settings"])
        else:
            raise SystemExit(f"--offline cannot apply {kind!r}")
    return wf


# Nodes that existed only to feed the database. Removing a node takes its wires with
# it, so nothing is left pointing at them. (Write Line Id is NOT here: it stamps the
# marker build_reports.js uses to tell a payment line from a guest.)
RETIRED = ["Build Shadow Write", "Shadow Write", "Read Booking Id", "Write Booking Id",
           "Build Snapshot SQL", "Write Snapshot", "Read Discrepancies", "Build Reconcile Message",
           "Read Unmirrored Bookings", "Append Mirror Row", "Mark Mirrored"]

# Nodes whose TYPE changes (Postgres -> Data Table / Code). updateNodeParameters
# cannot change a node's type, so each is removed and added again, wires restored.
RETYPED = ["Load Session", "Save Session", "Clear Session", "Read Bookings For Edit", "Read Locations",
           "Read Next Booking ID", "Read Report Locations", "Read Availability Locations"]

# The lookups: (gate, gate output, fetch nodes in order, the Code node, what follows it).
# Each fetch chain goes between a gate and its Code node. The report entries have no
# Postgres twin to replace on a fresh file, so there the Code node is created too.
FETCHES = [
    ("Needs Bookings?", 0, ["Fetch Bookings Formulas", "Fetch Bookings Values"],
     "Read Bookings For Edit", "Needs Locations?"),
    ("Needs Locations?", 0, ["Fetch Locations"], "Read Locations", "Needs Booking ID?"),
    ("Needs Booking ID?", 0, ["Fetch Booking Ids"], "Read Next Booking ID", "Needs Expense Number?"),
    ("Report Config", 0, ["Fetch Report Locations"], "Read Report Locations", "Read Report Formulas"),
    ("Availability Config", 0, ["Fetch Availability Locations"], "Read Availability Locations",
     "Read Availability Formulas"),
]

# Where a node new to the live graph goes when the generator does not place it.
EXTRA_POSITIONS = {
    "Fetch Report Locations": [-960, 960], "Read Report Locations": [-840, 960],
    "Fetch Availability Locations": [1560, 1240], "Read Availability Locations": [1680, 1240],
}


def batches(ops, size=90):
    """The endpoint takes at most 100 operations per call, each call atomic."""
    return [ops[i:i + size] for i in range(0, len(ops), size)]


def sheet_only_ops(wf, target, sheets_cred, prior_ops=()):
    """Operations that turn `wf` into the sheet-only bot (no Postgres anywhere).

    `target` is the graph build_workflow.py builds. `prior_ops` are operations the
    caller has already queued for `wf`: they are applied to a private copy first, so
    this sees the nodes they add (the report chains are created by main(), not by the
    generator). Returns only the NEW operations.

    Idempotent: on a graph that is already migrated it returns parameter and setting
    updates and nothing structural. `sheets_cred` is (type, id, name) of the live
    Google credential, embedded in each HTTP node it adds — setNodeCredential refuses
    googleSheetsOAuth2Api on an HTTP node, an addNode that carries it does not (plan
    Task 1). None (offline) adds the nodes bare, to be bound in the UI.
    """
    sim = json.loads(json.dumps(wf))
    apply_offline(sim, list(prior_ops))
    want = {n["name"]: n for n in target["nodes"]}
    specs = bw.lookup_node_specs()
    new_ops = []

    def emit(op):
        new_ops.append(op)
        apply_offline(sim, [op])

    def present():
        return {n["name"]: n for n in sim["nodes"]}

    def has_edge(src, tgt, index=0, kind="main"):
        brs = sim["connections"].get(src, {}).get(kind, [])
        return index < len(brs) and any(c["node"] == tgt for c in brs[index])

    def link(src, tgt, index=0, kind="main"):
        if has_edge(src, tgt, index, kind):
            return
        op = {"type": "addConnection", "source": src, "target": tgt,
              "sourceIndex": index, "targetIndex": 0}
        if kind != "main":
            op["connectionType"] = kind
        emit(op)

    def unlink(src, tgt, index=0):
        if has_edge(src, tgt, index):
            emit({"type": "removeConnection", "source": src, "target": tgt,
                  "sourceIndex": index, "targetIndex": 0})

    def spec_of(name):
        """(type, typeVersion, parameters, settings, needs sheets credential)."""
        if name in specs:
            ntype, tv, params, settings, cred = specs[name]
            return ntype, tv, params, dict(settings), bool(cred)
        n = want[name]
        keep = ("alwaysOutputData", "executeOnce", "onError", "retryOnFail", "maxTries", "waitBetweenTries")
        return n["type"], n["typeVersion"], n["parameters"], {k: n[k] for k in keep if k in n}, False

    def add(name):
        ntype, tv, params, settings, wants_sheets = spec_of(name)
        pos = (want.get(name) or {}).get("position") or EXTRA_POSITIONS.get(name) or [0, 0]
        node = {"name": name, "type": ntype, "typeVersion": tv,
                "parameters": json.loads(json.dumps(params)), "position": list(pos)}
        if wants_sheets and sheets_cred:
            node["credentials"] = {sheets_cred[0]: {"id": sheets_cred[1], "name": sheets_cred[2]}}
        emit({"type": "addNode", "node": node})
        if settings:        # addNode does not carry node-level settings
            emit({"type": "setNodeSettings", "nodeName": name, "settings": settings})

    def refresh(name):
        ntype, tv, params, settings, _ = spec_of(name)
        emit({"type": "updateNodeParameters", "nodeName": name, "parameters": params})
        if settings:
            emit({"type": "setNodeSettings", "nodeName": name, "settings": settings})

    # 1. Retire the database feeders first, so every edge read below is already clean.
    for name in RETIRED:
        if name in present():
            emit({"type": "removeNode", "nodeName": name})

    # 2. Retype Postgres -> Data Table / Code. A gate's wire straight to a lookup is
    #    not restored: step 3 puts the fetch in front of it.
    gate_wires = {(gate, idx, reader) for gate, idx, _, reader, _ in FETCHES}
    for name in RETYPED:
        if name not in present():
            continue
        if present()[name]["type"] == spec_of(name)[0]:
            refresh(name)
            continue
        inc = [(s, i, k) for s, spec in sim["connections"].items() for k, brs in spec.items()
               for i, br in enumerate(brs) for c in br if c["node"] == name]
        out = [(i, c["node"], k) for k, brs in sim["connections"].get(name, {}).items()
               for i, br in enumerate(brs) for c in br]
        emit({"type": "removeNode", "nodeName": name})
        add(name)
        for src, i, k in inc:
            if (src, i, name) not in gate_wires and src in present():
                link(src, name, i, k)
        for i, tgt, k in out:
            if tgt in present():
                link(name, tgt, i, k)

    # 3. The fetches, and the wires that put them between a gate and its Code node.
    for gate, idx, fetches, reader, downstream in FETCHES:
        if gate not in present():
            continue
        for f in fetches:
            if f in present():
                refresh(f)
            else:
                add(f)
        if reader not in present():       # a fresh file: no Postgres twin to retype
            add(reader)
        chain = [gate] + fetches + [reader]
        for a, b in zip(chain, chain[1:]):
            link(a, b, idx if a == gate else 0)
        unlink(gate, reader, idx)
        if downstream and downstream in present():
            link(reader, downstream)

    # 4. Branch ORDER. n8n runs the branches of one output in the order they were
    #    connected, and addConnection can only append — so a node that was removed
    #    and added again comes back LAST. Save Session did (execution 7820, the
    #    first live Confirm): it ran after Clear Session and put the finished session
    #    back to EDIT_CONFIRM, which left an old Confirm card able to save the same
    #    payment again. The generator's order wins for the nodes it knows; anything
    #    only the live graph has (the availability tap, say) stays after them.
    for src, spec in target["connections"].items():
        for idx, branch in enumerate(spec.get("main", [])):
            cur_brs = sim["connections"].get(src, {}).get("main", [])
            if len(branch) < 2 or idx >= len(cur_brs):
                continue
            cur = [c["node"] for c in cur_brs[idx]]
            desired = [c["node"] for c in branch]
            ranked = [n for n in desired if n in cur] + [n for n in cur if n not in desired]
            if cur == ranked:
                continue
            first = next(i for i, (a, b) in enumerate(zip(cur, ranked)) if a != b)
            for n in cur[first:]:
                unlink(src, n, idx)
            for n in ranked[first:]:
                link(src, n, idx)
    return new_ops


def ai_branch_ops(have, conns, anthropic):
    """Operations that add the AI edit: a gate and an extractor in front of the
    Brain, and the chat model plugged into the extractor.

    Idempotent against `have` (live node names) and `conns` (live connections).
    Returns (ops, bindings); a binding is (node, credential key, id, name) and is
    applied after its node exists.

    With no Anthropic credential on the instance the branch is skipped: wiring the
    Brain through an extractor that cannot authenticate would make the bot look
    dead, whereas without the nodes the Brain answers "unavailable" by itself.
    """
    ops, bindings = [], []
    if anthropic is None:
        print("  ! AI edit skipped — no Anthropic credential on the instance."
              " Create one in n8n (Credentials -> Anthropic) and run this again.")
        return ops, bindings

    def link(src, tgt, index=0, kind="main"):
        existing = [c["node"] for br in conns.get(src, {}).get(kind, [])[index:index + 1]
                    for c in br]
        if tgt in existing:
            return
        op = {"type": "addConnection", "source": src, "target": tgt,
              "sourceIndex": index, "targetIndex": 0}
        if kind != "main":
            op["connectionType"] = kind
        ops.append(op)

    def unlink(src, tgt, index=0):
        branches = conns.get(src, {}).get("main", [])
        if index < len(branches) and any(c["node"] == tgt for c in branches[index]):
            ops.append({"type": "removeConnection", "source": src, "target": tgt,
                        "sourceIndex": index, "targetIndex": 0})

    specs = (
        ("Needs AI?", "n8n-nodes-base.if", 2.3, bw.needs_ai_params(), [800, 640]),
        ("AI Extract", "@n8n/n8n-nodes-langchain.informationExtractor", 1.2,
         bw.ai_extract_params(), [1040, 640]),
        ("Anthropic Chat Model", "@n8n/n8n-nodes-langchain.lmChatAnthropic", 1.6,
         bw.ai_model_params(), [1040, 820]),
    )
    for name, ntype, tv, params, pos in specs:
        if name in have:
            ops.append({"type": "updateNodeParameters", "nodeName": name, "parameters": params})
            print(f"  ~ {name}")
            continue
        ops.append({"type": "addNode", "node": {
            "name": name, "type": ntype, "typeVersion": tv, "parameters": params,
            "position": pos}})
        print(f"  + {name}")
        if name == "Anthropic Chat Model":
            bindings.append((name, "anthropicApi", anthropic["id"], anthropic["name"]))
    # addNode does not carry node-level settings, so pin them separately.
    ops.append({"type": "setNodeSettings", "nodeName": "AI Extract",
                "settings": dict(bw.AI_EXTRACT_SETTINGS)})

    # Both ways into the Brain used to come straight from the expense-number gate.
    unlink("Needs Expense Number?", "Brain", 1)
    unlink("Read Expense Numbers", "Brain")
    link("Needs Expense Number?", "Needs AI?", 1)
    link("Read Expense Numbers", "Needs AI?")
    link("Needs AI?", "AI Extract", 0)
    link("Needs AI?", "Brain", 1)
    link("AI Extract", "Brain")
    link("Anthropic Chat Model", "AI Extract", kind="ai_languageModel")
    return ops, bindings


def main():
    # Applying the same operations to the file instead of the endpoint, for when
    # the endpoint cannot be reached. Nothing about the graph changes.
    offline = "--offline" in sys.argv
    offline_creds = []

    if offline:
        with open(OFFLINE_IN, encoding="utf-8") as fh:
            wf = json.load(fh)
        # No credential ids offline: they are bound in the UI after the import,
        # and inventing an id here would produce a node that silently fails to
        # authenticate rather than one n8n asks you to fix.
        anthropic = {"id": None, "name": "Anthropic account"}
        print(f"offline: {os.path.basename(OFFLINE_IN)}, {len(wf['nodes'])} nodes")
    else:
        # Picks the credential that can reach this workflow, not merely one that
        # authenticates — see push_brain.select_server.
        pb.require_workflow_id()
        pb.select_server()
        wf = json.loads(pb.call_tool("get_workflow_details",
                                     {"workflowId": pb.WORKFLOW_ID}))["workflow"]
        live_creds = json.loads(pb.call_tool("list_credentials", {"limit": 100}))["data"]
        anthropic = next((c for c in live_creds if c["type"] == "anthropicApi"), None)
        print(f"live: {len(wf['nodes'])} nodes")

    # The Sheets credential the live graph already uses. SHEETS_CRED's id dates
    # from before the workflow was rebuilt, and binding a new node to it fails
    # the whole batch ("credential ... not found", 2026-10-01).
    global SHEETS_CRED
    live_sheets = next((n["credentials"]["googleSheetsOAuth2Api"] for n in wf["nodes"]
                        if (n.get("credentials") or {}).get("googleSheetsOAuth2Api", {}).get("id")),
                       None)
    if live_sheets:
        SHEETS_CRED = ("googleSheetsOAuth2Api", live_sheets["id"],
                       live_sheets.get("name", SHEETS_CRED[2]))
    # Telegram's id went stale the same way (2026-10-08, adding Send
    # Availability Report).
    global TELEGRAM_CRED
    live_tg = next((n["credentials"]["telegramApi"] for n in wf["nodes"]
                    if (n.get("credentials") or {}).get("telegramApi", {}).get("id")),
                   None)
    if live_tg:
        TELEGRAM_CRED = ("telegramApi", live_tg["id"],
                         live_tg.get("name", TELEGRAM_CRED[2]))

    have = {n["name"] for n in wf["nodes"]}
    conns = wf.get("connections", {})

    ops = []
    creds = []

    def add_node(name, ntype, tv, params, pos, cred=None, settings=None):
        node = {"name": name, "type": ntype, "typeVersion": tv,
                "parameters": params, "position": pos}
        if settings:
            node.update(settings)
        ops.append({"type": "addNode", "node": node})
        if cred:
            key, cid, cname = cred
            if offline:
                offline_creds.append((name, key, cname))
            else:
                creds.append({"type": "setNodeCredential", "nodeName": name,
                              "credentialKey": key, "credentialId": cid,
                              "credentialName": cname})

    def connect(src, tgt, index=0):
        existing = [c["node"] for br in conns.get(src, {}).get("main", [])[index:index + 1]
                    for c in br]
        if tgt in existing:
            return
        ops.append({"type": "addConnection", "source": src, "target": tgt,
                    "sourceIndex": index, "targetIndex": 0})

    # ── Config: the reports group ─────────────────────────────────────────────
    cfg = next(n for n in wf["nodes"] if n["name"] == "Config")
    assigns = cfg["parameters"]["assignments"]["assignments"]
    if not any(a["name"] == "REPORT_GROUP_CHAT_ID" for a in assigns):
        assigns.append({"id": "report_group", "name": "REPORT_GROUP_CHAT_ID",
                        "value": REPORT_GROUP_CHAT_ID, "type": "string"})
        ops.append({"type": "updateNodeParameters", "nodeName": "Config",
                    "parameters": {"assignments": {"assignments": assigns}}})
        print("  + Config.REPORT_GROUP_CHAT_ID")
    # The registry tab the Telegram branch's Fetch Locations reads (2026-10-12).
    if not any(a["name"] == "AVAILABILITY_TAB" for a in assigns):
        assigns.append({"id": "avail_tab", "name": "AVAILABILITY_TAB",
                        "value": AVAILABILITY_TAB, "type": "string"})
        ops.append({"type": "updateNodeParameters", "nodeName": "Config",
                    "parameters": {"assignments": {"assignments": assigns}}})
        print("  + Config.AVAILABILITY_TAB")

    # ── The availability check needs rows on the NOTES turn ───────────────────
    ops.append({"type": "updateNodeParameters", "nodeName": "Needs Bookings?",
                "parameters": {"conditions": state_conditions(BOOKING_STATES)}})
    print("  ~ Needs Bookings? fires on", ", ".join(BOOKING_STATES))
    # The registry gate was only ever created, never updated, so the states the AI
    # edit added would not reach a live instance that already has it.
    ops.append({"type": "updateNodeParameters", "nodeName": "Needs Locations?",
                "parameters": {"conditions": state_conditions(LOCATION_STATES,
                                                              from_session=True)}})
    print("  ~ Needs Locations? fires on", ", ".join(LOCATION_STATES))

    # ── Apartment/room registry ───────────────────────────────────────────────
    if "Needs Locations?" not in have:
        add_node("Needs Locations?", "n8n-nodes-base.if", 2.3,
                 {"conditions": state_conditions(LOCATION_STATES, from_session=True),
                  "looseTypeValidation": True, "options": {}},
                 [-544, 560])
        print("  + Needs Locations?")
    # ── The lookups are sheet reads (sheet_only_ops, below) ───────────────────
    #
    # Bookings, the room registry and the next booking ID are fetched from the
    # Sheets API in the turn that needs them and turned into rows by a Code node.
    # They were Postgres reads until 2026-10-12, and the wires from their gates are
    # made by sheet_only_ops() once every node it needs exists.

    def disconnect(src, tgt, index=0):
        """Drop a connection only if it is actually there — n8n errors otherwise,
        which would make a second run of this script fail."""
        branches = conns.get(src, {}).get("main", [])
        if index < len(branches) and any(c["node"] == tgt for c in branches[index]):
            ops.append({"type": "removeConnection", "source": src, "target": tgt,
                        "sourceIndex": index, "targetIndex": 0})

    # Both existing paths into the Brain now pass through the locations gate.
    disconnect("Needs Bookings?", "Brain", index=1)
    disconnect("Read Bookings For Edit", "Brain", index=0)
    connect("Needs Bookings?", "Needs Locations?", index=1)
    connect("Read Bookings For Edit", "Needs Locations?")

    # ── The suggested booking ID and expense number (2026-10-01) ──────────────
    #
    # Two more gated reads between the locations gate and the Brain, each for
    # the one turn that asks its question: the booking ID is asked on the turn
    # that answers بوكنج ID, the expense number on the tap of 💸 مصروف. The
    # gates read Load Session / the trigger by name, because by here $json is
    # whatever the previous read returned. executeOnce on both reads: the
    # locations read hands on 26 items, and each would otherwise run 26 times.
    #
    # The booking ID comes from the bookings tab's own ID column (the numbering
    # restarts with the month); the expense number from the expense tab itself.
    for gate, expr, pos in (
        ("Needs Booking ID?",
         "={{ $('Load Session').first().json.state === 'BOOKING_ID' }}", [-64, 560]),
        ("Needs Expense Number?",
         "={{ ($('Telegram Trigger').first().json.callback_query || {}).data"
         " === 'choice_expense' }}", [416, 560]),
    ):
        params = {"conditions": {
            "options": {"caseSensitive": True, "leftValue": "",
                        "typeValidation": "loose", "version": 1},
            "conditions": [{"id": gate, "leftValue": expr, "rightValue": "",
                            "operator": {"type": "boolean", "operation": "true",
                                         "singleValue": True}}],
            "combinator": "and"}, "looseTypeValidation": True, "options": {}}
        if gate not in have:
            add_node(gate, "n8n-nodes-base.if", 2.3, params, pos)
            print(f"  + {gate}")
        else:
            ops.append({"type": "updateNodeParameters", "nodeName": gate,
                        "parameters": params})
    if "Read Expense Numbers" not in have:
        add_node("Read Expense Numbers", "n8n-nodes-base.googleSheets", 4.7,
                 sheets_read(EXPENSE_TAB, "A1:H2000"), [656, 480], cred=SHEETS_CRED)
        print("  + Read Expense Numbers")
    # A failed read must still reach the Brain, which then asks the plain
    # question; an empty tab must too, which is what alwaysOutputData is for.
    ops.append({"type": "setNodeSettings", "nodeName": "Read Expense Numbers",
                "settings": {"executeOnce": True, "alwaysOutputData": True,
                             "onError": "continueRegularOutput",
                             "retryOnFail": True, "maxTries": 2}})

    disconnect("Needs Locations?", "Brain", index=1)
    disconnect("Read Locations", "Brain")
    connect("Needs Locations?", "Needs Booking ID?", index=1)
    connect("Read Locations", "Needs Booking ID?")
    connect("Needs Booking ID?", "Needs Expense Number?", index=1)
    connect("Read Next Booking ID", "Needs Expense Number?")
    connect("Needs Expense Number?", "Read Expense Numbers", index=0)
    # No wires into the Brain from here: they go through the AI gate now (see
    # ai_branch_ops). Re-adding the direct ones on every run would undo that move
    # on the second deploy and, offline, leave the Brain wired twice — two replies
    # per turn and every save written twice.

    # ── Undo: park the pre-image instead of blanking `data` ───────────────────
    #
    # Clear Session used to be rewritten here to park the last edit's pre-image,
    # which is what /undo read. Undo was removed on 2026-08-22, so the node is
    # left exactly as build_workflow.py builds it: state cleared, `data` blank.

    # ── Scheduled reports ─────────────────────────────────────────────────────
    if "Report Schedule" not in have:
        add_node("Report Schedule", "n8n-nodes-base.scheduleTrigger", 1.2,
                 {"rule": {"interval": [{"field": "days", "triggerAtHour": 8,
                                         "triggerAtMinute": 0}]}},
                 [-1200, 800])
        print("  + Report Schedule (08:00 daily)")
    if "Report Config" not in have:
        add_node("Report Config", "n8n-nodes-base.set", 3.4,
                 {"assignments": {"assignments": [
                     {"id": "tz", "name": "TIMEZONE", "value": "Africa/Cairo", "type": "string"},
                     {"id": "grp", "name": "REPORT_GROUP_CHAT_ID",
                      "value": REPORT_GROUP_CHAT_ID, "type": "string"},
                 ]}, "options": {}},
                 [-960, 800])
        print("  + Report Config")
    # The room registry, for 🔓 الغرف الفارغة. The bookings tab only knows which
    # rooms are slept in; naming the empty ones needs the list of rooms that
    # exist, which is the same read the Telegram branch's Read Locations runs
    # (Fetch Report Locations -> Read Report Locations, added by sheet_only_ops).
    # It sits at the HEAD of the chain: one item in from Report Config is one
    # read, whereas hanging it off either sheet read would fire it once per row.
    if "Read Report Formulas" not in have:
        add_node("Read Report Formulas", "n8n-nodes-base.googleSheets", 4.7,
                 sheets_read(BOOKINGS_TAB, "A:U", formula=True),
                 [-720, 800], cred=SHEETS_CRED,
                 settings={"executeOnce": True})
        print("  + Read Report Formulas (executeOnce)")
    if "Read Report Values" not in have:
        # executeOnce: the formulas read hands it N items, and without this the
        # Sheets node would re-read the whole tab once per row.
        add_node("Read Report Values", "n8n-nodes-base.googleSheets", 4.7,
                 sheets_read(BOOKINGS_TAB, "A:U"),
                 [-480, 800], cred=SHEETS_CRED, settings={"executeOnce": True})
        print("  + Read Report Values (executeOnce)")
    # Both report reads cover A:U, which includes column U: build_reports.js reads
    # the `<row>-<seq>` marker there to tell a payment line from a guest. They
    # address columns by header name, so the extra one is inert for the rest.
    for node, formula in (("Read Report Formulas", True), ("Read Report Values", False)):
        if node in have:
            ops.append({"type": "updateNodeParameters", "nodeName": node,
                        "parameters": sheets_read(BOOKINGS_TAB, "A:U", formula=formula)})
            print(f"  ~ {node} reads A:U")

    if "Build Reports" not in have:
        add_node("Build Reports", "n8n-nodes-base.code", 2,
                 {"jsCode": read_source("build_reports.js")}, [-240, 800])
        print("  + Build Reports")
    else:
        ops.append({"type": "updateNodeParameters", "nodeName": "Build Reports",
                    "parameters": {"jsCode": read_source("build_reports.js")}})
        print("  ~ Build Reports code")
    if "Send Report" not in have:
        add_node("Send Report", "n8n-nodes-base.telegram", 1.2,
                 {"chatId": "={{ $json.chat_id }}", "text": "={{ $json.text }}",
                  "additionalFields": {"appendAttribution": False, "parse_mode": "Markdown"}},
                 [0, 800], cred=TELEGRAM_CRED)
        print("  + Send Report")

    # addNode does not carry node-level settings, so pin executeOnce separately.
    ops.append({"type": "setNodeSettings", "nodeName": "Read Report Values",
                "settings": {"executeOnce": True}})
    # Read Report Formulas needs it too, since 2026-09-21: the registry read now
    # feeds it 26 items, and without this it would re-read the whole tab 26
    # times — 26 Sheets calls for one report, and a rate limit on a busy day.
    ops.append({"type": "setNodeSettings", "nodeName": "Read Report Formulas",
                "settings": {"executeOnce": True}})

    connect("Report Schedule", "Report Config")
    # Report Config -> Fetch Report Locations -> Read Report Locations -> Read Report
    # Formulas (the three middle wires come from sheet_only_ops). The direct wire is
    # cut first: leaving it would fire the formulas read twice, once from each
    # parent, and the second run would overwrite the first's items.
    disconnect("Report Config", "Read Report Formulas")
    connect("Read Report Formulas", "Read Report Values")
    connect("Read Report Values", "Build Reports")
    # The daily report is POSTED again (user, 2026-09-21: "every day a message
    # with the occupied rooms and the clients that have dept to be sent to the
    # updates group"). It goes to REPORT_GROUP_CHAT_ID, which is the group the
    # schedule branch has always been configured for.
    #
    # (A reconcile message used to share this node and arrived unasked every
    # morning; that branch is gone with the database.)
    #
    # This does NOT touch the per-booking announcements. Those go to
    # GROUP_CHAT_ID / EXPENSE_GROUP_CHAT_ID through `Post To Group`, are a
    # receptionist's confirmation that a save landed, and were never part of the
    # 08:00 schedule.
    connect("Build Reports", "Send Report")

    # ── The availability report, on demand ────────────────────────────────────
    #
    # The 🏠 تقرير الإتاحة button (user, 2026-10-08: "a button in the bot to
    # send the availability message when needed"). The Brain raises
    # `hasAvailability`; this chain builds the same report the 08:00 schedule
    # does, with the same code, and posts it to the same group.
    #
    # It has its own twins of the schedule's reads rather than wiring into
    # Report Config, so a tap does not also run the morning's schedule. And
    # build_reports.js tells the two chains apart by which Config ran, and sends
    # only the availability report from this one.
    if "Wants Availability?" not in have:
        add_node("Wants Availability?", "n8n-nodes-base.if", 2.3,
                 {"conditions": bw.flag_condition("={{ $json.hasAvailability }}",
                                                  "wants-availability"),
                  "looseTypeValidation": True, "options": {}},
                 [1200, 1100])
        print("  + Wants Availability?")
    if "Availability Config" not in have:
        add_node("Availability Config", "n8n-nodes-base.set", 3.4,
                 {"assignments": {"assignments": [
                     {"id": "tz", "name": "TIMEZONE", "value": "Africa/Cairo", "type": "string"},
                     {"id": "grp", "name": "REPORT_GROUP_CHAT_ID",
                      "value": REPORT_GROUP_CHAT_ID, "type": "string"},
                 ]}, "options": {}},
                 [1440, 1100])
        print("  + Availability Config")
    # Its registry (Fetch / Read Availability Locations) is added by sheet_only_ops.
    for node, formula, pos in (("Read Availability Formulas", True, [1920, 1100]),
                               ("Read Availability Values", False, [2160, 1100])):
        if node not in have:
            add_node(node, "n8n-nodes-base.googleSheets", 4.7,
                     sheets_read(BOOKINGS_TAB, "A:U", formula=formula),
                     pos, cred=SHEETS_CRED)
            print(f"  + {node}")
        else:
            ops.append({"type": "updateNodeParameters", "nodeName": node,
                        "parameters": sheets_read(BOOKINGS_TAB, "A:U", formula=formula)})
        # One read per tap: the registry hands the formulas read one item per
        # room, and the formulas read hands the values read one per row.
        ops.append({"type": "setNodeSettings", "nodeName": node,
                    "settings": {"executeOnce": True, "retryOnFail": True,
                                 "maxTries": 2}})
    if "Build Availability Report" not in have:
        add_node("Build Availability Report", "n8n-nodes-base.code", 2,
                 {"jsCode": read_source("build_reports.js")}, [2400, 1100])
        print("  + Build Availability Report")
    else:
        ops.append({"type": "updateNodeParameters", "nodeName": "Build Availability Report",
                    "parameters": {"jsCode": read_source("build_reports.js")}})
        print("  ~ Build Availability Report code")
    if "Send Availability Report" not in have:
        add_node("Send Availability Report", "n8n-nodes-base.telegram", 1.2,
                 {"chatId": "={{ $json.chat_id }}", "text": "={{ $json.text }}",
                  "additionalFields": {"appendAttribution": False, "parse_mode": "Markdown"}},
                 [2640, 1100], cred=TELEGRAM_CRED)
        print("  + Send Availability Report")
    connect("Brain", "Wants Availability?")
    connect("Wants Availability?", "Availability Config", index=0)
    connect("Read Availability Formulas", "Read Availability Values")
    connect("Read Availability Values", "Build Availability Report")
    connect("Build Availability Report", "Send Availability Report")

    # ── A payment receipt sent as a file ──────────────────────────────────────
    #
    # The add-payment flow takes an image or PDF sent as a FILE as well as a
    # photo (2026-10-10). A file's id is refused by sendPhoto, so the Brain
    # marks `save.receiptKind` and files go out through sendDocument instead.
    # Every other flow leaves receiptKind unset and keeps the photo path.
    if "Receipt Is Document?" not in have:
        add_node("Receipt Is Document?", "n8n-nodes-base.if", 2.3, {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "",
                            "typeValidation": "loose", "version": 1},
                "conditions": [{
                    "id": "receipt-is-document",
                    "leftValue": "={{ $('Brain').first().json.save.receiptKind }}",
                    "rightValue": "document",
                    "operator": {"type": "string", "operation": "equals"}}],
                "combinator": "and"},
            "looseTypeValidation": True, "options": {},
        }, [2460, 780])
        print("  + Receipt Is Document?")
    if "Post Receipt File To Group" not in have:
        photo_node = next(n for n in wf["nodes"] if n["name"] == "Post Receipt To Group")
        params = json.loads(json.dumps(photo_node["parameters"]))
        params["operation"] = "sendDocument"
        add_node("Post Receipt File To Group", photo_node["type"], photo_node["typeVersion"],
                 params, [2760, 900], cred=TELEGRAM_CRED)
        print("  + Post Receipt File To Group")
    # A setting op, not a key on addNode: the endpoint drops `onError` there
    # (seen 2026-10-10). Same reason as the other posters — the save is done
    # by now, and a failed post must not mark the execution failed.
    if next((n for n in wf["nodes"] if n["name"] == "Post Receipt File To Group"),
            {}).get("onError") != "continueRegularOutput":
        ops.append({"type": "setNodeSettings", "nodeName": "Post Receipt File To Group",
                    "settings": {"onError": "continueRegularOutput"}})
    disconnect("Has Receipt?", "Post Receipt To Group", index=0)
    connect("Has Receipt?", "Receipt Is Document?", index=0)
    connect("Receipt Is Document?", "Post Receipt File To Group", index=0)
    connect("Receipt Is Document?", "Post Receipt To Group", index=1)

    # ── No Postgres (2026-10-12) ──────────────────────────────────────────────
    #
    # Sessions become Data Table nodes, the lookups become sheet reads, and the
    # shadow-write and reconcile branches are removed. It runs last of the graph
    # edits so it sees the report chains' gates, which are added above, and it is
    # idempotent: on a migrated workflow it only refreshes parameters.
    sheet_ops = sheet_only_ops(wf, bw.workflow(bw.build()), None if offline else SHEETS_CRED,
                               prior_ops=ops)
    ops.extend(sheet_ops)
    if offline:
        specs = bw.lookup_node_specs()
        offline_creds.extend((o["node"]["name"], specs[o["node"]["name"]][4][0], specs[o["node"]["name"]][4][2])
                             for o in sheet_ops if o["type"] == "addNode" and o["node"]["name"] in specs
                             and specs[o["node"]["name"]][4])
    for o in sheet_ops:
        if o["type"] == "addNode":
            print(f"  + {o['node']['name']}")
        elif o["type"] == "removeNode":
            print(f"  - {o['nodeName']}")

    # ── The AI edit (2026-10-12) ──────────────────────────────────────────────
    #
    # The two gates above already carry AI_TEXT and AI_PICK. This adds the
    # extractor in front of the Brain and the chat model plugged into it. The
    # credential has to exist first: it is created in the n8n UI, never from here.
    ai_ops, ai_bindings = ai_branch_ops(have, conns, anthropic)
    ops.extend(ai_ops)
    for name, key, cid, cname in ai_bindings:
        if offline:
            offline_creds.append((name, key, cname))
        else:
            creds.append({"type": "setNodeCredential", "nodeName": name,
                          "credentialKey": key, "credentialId": cid, "credentialName": cname})

    ops.extend(creds)          # credentials bind after their node exists
    if not ops:
        print("nothing to do")
        return

    if offline:
        apply_offline(wf, ops)
        blob = json.dumps(wf, ensure_ascii=False, indent=2)
        with open(OFFLINE_OUT, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(blob + "\n")
        print(f"\napplied {len(ops)} operations to the file")
        print(f"wrote {os.path.basename(OFFLINE_OUT)}: {len(wf['nodes'])} nodes,"
              f" {len(blob) // 1024} KB")
        if offline_creds:
            print("\ncredentials to bind in the UI, on top of the ones the base"
                  " file already needs:")
            for name, key, cname in offline_creds:
                print(f"  {name:24} {key} ({cname})")
        return

    if "--dry-run" in sys.argv:
        # Nothing is sent. The operations are applied to a private copy of the live
        # graph, which is then checked, so a migration is verified against the REAL
        # workflow before the draft is touched.
        import copy
        import tempfile
        import validate_workflow as vw
        sim = apply_offline(copy.deepcopy(wf), [o for o in ops if o["type"] != "setNodeCredential"])
        out = os.path.join(os.environ.get("CLAUDE_JOB_DIR", tempfile.gettempdir()), "live-dry-run.workflow.json")
        with open(out, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(sim, fh, ensure_ascii=False, indent=2)
        pg_left = [n["name"] for n in sim["nodes"] if n["type"].endswith("postgres")]
        print(f"\ndry run: {len(ops)} operations in {len(batches(ops))} batch(es);"
              f" {len(wf['nodes'])} -> {len(sim['nodes'])} nodes")
        print("postgres nodes left:", pg_left or "none")
        print("validator:", vw.check(sim) or "clean")
        print("wrote", out)
        return

    # In batches, each atomic: the endpoint takes at most 100 operations a call and
    # the no-Postgres migration is more than that. A failed batch leaves the draft
    # half-migrated; nothing is live until --publish, and restore_workflow_version
    # puts the recorded version back.
    for i, batch in enumerate(batches(ops)):
        print(f"\napplying operations {i * 90 + 1}-{i * 90 + len(batch)} of {len(ops)}…")
        print(pb.call_tool("update_workflow",
                           {"workflowId": pb.WORKFLOW_ID, "operations": batch})[:400])

    if "--publish" in sys.argv:
        print(pb.call_tool("publish_workflow", {"workflowId": pb.WORKFLOW_ID}))


if __name__ == "__main__":
    main()
