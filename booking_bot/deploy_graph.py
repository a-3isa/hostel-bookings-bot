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
  * "Clear Session" parks the undo pre-image instead of blanking `data`.
  * A schedule branch: Report Schedule -> Report Config -> Read Report Formulas
    -> Read Report Values -> Build Reports -> Send Report.
"""

import json
import os
import sys

# Windows consoles default to a legacy codepage; this script prints Arabic and
# arrows, and a UnicodeEncodeError here would abort a half-applied deploy.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import push_brain as pb   # same directory; reuses its JSON-RPC plumbing

HERE = os.path.dirname(os.path.abspath(__file__))

SHEET_ID = "1CiHciOeeyRMx9vz5cP0Xlid-jqM_gVjW3sUfore84S8"
BOOKINGS_TAB = "إدخال الحجوزات"
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
LOCATION_STATES = ["PHONE", "EXP_AMOUNT", "EDIT_MENU"]
# States whose turn needs the bookings tab: the two lookup steps, plus NOTES —
# the turn that builds the confirmation, where the availability check runs.
BOOKING_STATES = ["EDIT_FIND", "EDIT_PICK", "NOTES"]


def state_conditions(states):
    return {
        "options": {"caseSensitive": True, "leftValue": "",
                    "typeValidation": "loose", "version": 1},
        "conditions": [
            {"id": f"is-{s.lower()}", "leftValue": "={{ $json.state }}", "rightValue": s,
             "operator": {"type": "string", "operation": "equals"}}
            for s in states
        ],
        "combinator": "or",
    }


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

    The same four verbs the MCP endpoint understands, so the file this produces
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
        elif kind == "addConnection":
            main = conns.setdefault(op["source"], {}).setdefault("main", [])
            while len(main) <= op["sourceIndex"]:
                main.append([])
            wired = {c["node"] for c in main[op["sourceIndex"]]}
            if op["target"] not in wired:
                main[op["sourceIndex"]].append({"node": op["target"], "type": "main",
                                                "index": op.get("targetIndex", 0)})
        elif kind == "updateNodeParameters":
            nodes[op["nodeName"]]["parameters"].update(op["parameters"])
        elif kind == "setNodeSettings":
            nodes[op["nodeName"]].update(op["settings"])
        else:
            raise SystemExit(f"--offline cannot apply {kind!r}")
    return wf


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
        pg = {"id": None, "name": "Supabase Postgres"}
        print(f"offline: {os.path.basename(OFFLINE_IN)}, {len(wf['nodes'])} nodes")
    else:
        # Picks the credential that can reach this workflow, not merely one that
        # authenticates — see push_brain.select_server.
        pb.require_workflow_id()
        pb.select_server()
        wf = json.loads(pb.call_tool("get_workflow_details",
                                     {"workflowId": pb.WORKFLOW_ID}))["workflow"]
        # Fetched once and shared: since Phase 4b the two reads are Postgres
        # nodes too, not just the shadow write.
        pg = next((c for c in json.loads(
            pb.call_tool("list_credentials", {"limit": 100}))["data"]
            if c["type"] == "postgres"), None)
        print(f"live: {len(wf['nodes'])} nodes")

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

    # ── The availability check needs rows on the NOTES turn ───────────────────
    ops.append({"type": "updateNodeParameters", "nodeName": "Needs Bookings?",
                "parameters": {"conditions": state_conditions(BOOKING_STATES)}})
    print("  ~ Needs Bookings? fires on", ", ".join(BOOKING_STATES))

    # ── Apartment/room registry ───────────────────────────────────────────────
    if "Needs Locations?" not in have:
        add_node("Needs Locations?", "n8n-nodes-base.if", 2.3,
                 {"conditions": state_conditions(LOCATION_STATES),
                  "looseTypeValidation": True, "options": {}},
                 [-544, 560])
        print("  + Needs Locations?")
    # ── The two reads, from Postgres since Phase 4b ───────────────────────────
    #
    # Both used to be googleSheets nodes; the swap is what removed the ~0.4–2 s
    # mid-conversation wait. Their SQL aliases the sheet's own Arabic headers, so
    # brain.js consumes them unchanged — see the .sql files for why each query is
    # shaped the way it is.
    #
    # alwaysOutputData is load-bearing, the same lesson as *Read Discrepancies*:
    # a query returning no rows would otherwise stop the branch before the Brain
    # ever ran, and the bot would answer nothing at all.
    def postgres_read(name, sql_file, pos):
        settings = {"alwaysOutputData": True, "onError": "continueRegularOutput",
                    "retryOnFail": True, "maxTries": 2}
        params = {"operation": "executeQuery", "query": read_source(sql_file),
                  "options": {}}
        if name not in have:
            if not pg:
                print(f"  ! {name} skipped — no postgres credential")
                return
            add_node(name, "n8n-nodes-base.postgres", 2.6, params, pos,
                     cred=("postgres", pg["id"], pg["name"]))
            print(f"  + {name}  (credential: {pg['name']})")
        else:
            # Updating parameters cannot change a node's TYPE. A node still left
            # as googleSheets from before Phase 4b would take an executeQuery
            # `query` parameter it has no idea what to do with, and the result
            # runs but reads nothing. Say so rather than reporting success.
            live = next((n for n in wf["nodes"] if n["name"] == name), {})
            if not live.get("type", "").endswith("postgres"):
                print(f"  ! {name} is a {live.get('type', '?')} node, not postgres —"
                      " delete it and re-run, or rebuild from build_workflow.py")
                return
            ops.append({"type": "updateNodeParameters", "nodeName": name,
                        "parameters": params})
            print(f"  ~ {name} query")
        ops.append({"type": "setNodeSettings", "nodeName": name, "settings": settings})

    postgres_read("Read Bookings For Edit", "read_bookings_for_edit.sql", [-304, 240])
    postgres_read("Read Locations", "read_locations.sql", [-304, 480])

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
    connect("Needs Locations?", "Read Locations", index=0)
    connect("Needs Locations?", "Brain", index=1)
    connect("Read Locations", "Brain")

    # ── Undo: park the pre-image instead of blanking `data` ───────────────────
    clear = next(n for n in wf["nodes"] if n["name"] == "Clear Session")
    cols = json.loads(json.dumps(clear["parameters"]["columns"]))
    # lastAppend is derived from the flow, not from "there is no undo record".
    # An undo is itself an edit with no record of its own, and the two must not
    # look alike: a second /undo should say "nothing to undo", not send the user
    # off to إلغاء الحجز.
    cols["value"]["data"] = (
        "={{ JSON.stringify({ lastWrite: $('Brain').first().json.save.undo || null,"
        " lastAppend: ['booking','expense'].includes($('Brain').first().json.save.flow) }) }}"
    )
    ops.append({"type": "updateNodeParameters", "nodeName": "Clear Session",
                "parameters": {"columns": cols}})
    print("  ~ Clear Session parks the undo record")

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
    if "Read Report Formulas" not in have:
        add_node("Read Report Formulas", "n8n-nodes-base.googleSheets", 4.7,
                 sheets_read(BOOKINGS_TAB, "A:U", formula=True),
                 [-720, 800], cred=SHEETS_CRED)
        print("  + Read Report Formulas")
    if "Read Report Values" not in have:
        # executeOnce: the formulas read hands it N items, and without this the
        # Sheets node would re-read the whole tab once per row.
        add_node("Read Report Values", "n8n-nodes-base.googleSheets", 4.7,
                 sheets_read(BOOKINGS_TAB, "A:U"),
                 [-480, 800], cred=SHEETS_CRED, settings={"executeOnce": True})
        print("  + Read Report Values (executeOnce)")
    # Both report reads widened A:T -> A:U so the snapshot carries column U, the
    # booking id. That is what lets the daily reconcile key on the BOOKING
    # rather than on the row it happens to sit on: an inserted row renumbers
    # every row beneath it, and keying on sheet_row turned that into a wall of
    # differences that were not real. Nothing else about the reports changes —
    # they address columns by header name, so an extra one is inert.
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
    # "Read Locations" used to be re-pinned to the الإتاحة range here. Since
    # Phase 4b it is a Postgres node owned by postgres_read() above, and leaving
    # this line in would quietly turn it back into a Sheets read on the next
    # deploy — reintroducing the mid-conversation wait and nothing else.

    connect("Report Schedule", "Report Config")
    connect("Report Config", "Read Report Formulas")
    connect("Read Report Formulas", "Read Report Values")
    connect("Read Report Values", "Build Reports")
    connect("Build Reports", "Send Report")

    # ── Phase 2: dual-write to Supabase ──────────────────────────────────────
    #
    # Hangs off "Clear Session", which runs only after the sheet write actually
    # succeeded, and in parallel with the existing path — so the receptionist's
    # ✅ does not wait on Postgres and cannot be turned into an error by it.
    if "Build Shadow Write" not in have:
        add_node("Build Shadow Write", "n8n-nodes-base.code", 2,
                 {"jsCode": read_source("build_shadow_write.js")}, [3056, 448])
        print("  + Build Shadow Write")
    else:
        ops.append({"type": "updateNodeParameters", "nodeName": "Build Shadow Write",
                    "parameters": {"jsCode": read_source("build_shadow_write.js")}})
        print("  ~ Build Shadow Write code")

    if pg:
        if "Shadow Write" not in have:
            add_node("Shadow Write", "n8n-nodes-base.postgres", 2.6,
                     {"operation": "executeQuery", "query": "={{ $json.sql }}",
                      "options": {}},
                     [3296, 448],
                     cred=("postgres", pg["id"], pg["name"]),
                     # The whole point of the trust period: Supabase being down,
                     # asleep or wrong must never surface to a receptionist.
                     settings={"onError": "continueRegularOutput", "retryOnFail": True,
                               "maxTries": 2, "alwaysOutputData": True})
            print(f"  + Shadow Write  (credential: {pg['name']})")
        connect("Clear Session", "Build Shadow Write")
        connect("Build Shadow Write", "Shadow Write")
        ops.append({"type": "setNodeSettings", "nodeName": "Shadow Write",
                    "settings": {"onError": "continueRegularOutput",
                                 "retryOnFail": True, "maxTries": 2}})

        # ── Stamp the booking's id back into column U ─────────────────────────
        #
        # The first write that goes Postgres -> sheet, and the seed of the
        # mirror. Column U is the stable key (write_sheet_ids.py put it there),
        # but a row the bot appends has no id in it until something writes one —
        # which until now meant waiting for reindex.py to be run by hand.
        #
        # The flow test is baked into the SQL rather than costing an IF node:
        # the expression renders to `and true` or `and false`, and `and false`
        # returns no rows, which stops the branch before the Sheets write. That
        # matters because expenses live on a different tab and their sheet_row
        # numbering overlaps the bookings tab's — writing row 5's id onto the
        # expenses sheet would be a quiet corruption.
        id_sql = (
            "=select sheet_row as row_number, id::text as \"معرف النظام\""
            " from bookings where sheet_row ="
            " {{ $('Build Shadow Write').first().json.sheet_row }}"
            " and {{ ['booking','edit','cancel']"
            ".includes($('Build Shadow Write').first().json.flow) }};")
        if "Read Booking Id" not in have:
            add_node("Read Booking Id", "n8n-nodes-base.postgres", 2.6,
                     {"operation": "executeQuery", "query": id_sql, "options": {}},
                     [3536, 448], cred=("postgres", pg["id"], pg["name"]))
            print("  + Read Booking Id")
        else:
            ops.append({"type": "updateNodeParameters", "nodeName": "Read Booking Id",
                        "parameters": {"operation": "executeQuery", "query": id_sql,
                                       "options": {}}})
            print("  ~ Read Booking Id query")

        if "Write Booking Id" not in have:
            add_node("Write Booking Id", "n8n-nodes-base.googleSheets", 4.7,
                     {"operation": "update",
                      "documentId": {"__rl": True, "mode": "id", "value": SHEET_ID},
                      "sheetName": {"__rl": True, "mode": "name", "value": BOOKINGS_TAB},
                      "columns": {"mappingMode": "autoMapInputData",
                                  "matchingColumns": ["row_number"],
                                  "attemptToConvertTypes": False,
                                  "convertFieldsToString": True},
                      "options": {}},
                     [3776, 448], cred=SHEETS_CRED)
            print("  + Write Booking Id")

        connect("Shadow Write", "Read Booking Id")
        connect("Read Booking Id", "Write Booking Id")
        # Neither may ever surface to a receptionist: the ✅ has already been
        # sent by the time this branch runs, and a missing id in U is something
        # reindex.py fixes on its next pass.
        for node in ("Read Booking Id", "Write Booking Id"):
            ops.append({"type": "setNodeSettings", "nodeName": node,
                        "settings": {"onError": "continueRegularOutput",
                                     "retryOnFail": True, "maxTries": 2}})
    else:
        print("\n  ! No Postgres credential in n8n, so the shadow write is not wired up.")
        print("    Create one (Credentials -> New -> Postgres) and re-run this script:")
        print("      Host     aws-1-eu-west-1.pooler.supabase.com")
        print("      Database postgres")
        print("      User     postgres.<project-ref>")
        print("      Password <the one in SUPABASE_DB_URL>")
        print("      Port     6543          SSL: require\n")

    # ── Phase 3: the daily reconcile ─────────────────────────────────────────
    #
    # Hangs off the same read the reports already do, so it costs no extra Sheets
    # call: snapshot the sheet, ask the database where the two disagree, post the
    # answer. It posts even when clean — a report that only appears on trouble is
    # indistinguishable from one that has quietly stopped running.
    if pg:
        for name, src, pos in (("Build Snapshot SQL", "build_snapshot_sql.js", [-240, 1040]),
                               ("Build Reconcile Message", "build_reconcile_message.js", [480, 1040])):
            if name not in have:
                add_node(name, "n8n-nodes-base.code", 2, {"jsCode": read_source(src)}, pos)
                print(f"  + {name}")
            else:
                ops.append({"type": "updateNodeParameters", "nodeName": name,
                            "parameters": {"jsCode": read_source(src)}})
                print(f"  ~ {name} code")

        if "Write Snapshot" not in have:
            add_node("Write Snapshot", "n8n-nodes-base.postgres", 2.6,
                     {"operation": "executeQuery", "query": "={{ $json.sql }}", "options": {}},
                     [0, 1040], cred=("postgres", pg["id"], pg["name"]),
                     settings={"onError": "continueRegularOutput", "alwaysOutputData": True})
            print("  + Write Snapshot")
        if "Read Discrepancies" not in have:
            add_node("Read Discrepancies", "n8n-nodes-base.postgres", 2.6,
                     {"operation": "executeQuery",
                      "query": "select * from reconcile_bookings order by sheet_row;",
                      "options": {}},
                     [240, 1040], cred=("postgres", pg["id"], pg["name"]),
                     # alwaysOutputData: agreement returns no rows, and without
                     # this the branch would stop and never post the all-clear.
                     settings={"onError": "continueRegularOutput", "alwaysOutputData": True})
            print("  + Read Discrepancies")

        # addNode does not carry node-level settings, so pin them separately —
        # the same trap executeOnce fell into. alwaysOutputData on Read
        # Discrepancies is load-bearing: agreement returns zero rows, and without
        # it the branch simply stops and the all-clear is never posted. A report
        # that only appears on trouble cannot be told apart from a dead one.
        for node in ("Write Snapshot", "Read Discrepancies", "Shadow Write"):
            ops.append({"type": "setNodeSettings", "nodeName": node,
                        "settings": {"onError": "continueRegularOutput",
                                     "alwaysOutputData": True}})

        connect("Read Report Values", "Build Snapshot SQL")
        connect("Build Snapshot SQL", "Write Snapshot")
        connect("Write Snapshot", "Read Discrepancies")
        connect("Read Discrepancies", "Build Reconcile Message")
        connect("Build Reconcile Message", "Send Report")

        # ── Phase 4c: publish DB-born bookings into the sheet ─────────────────
        #
        # A booking created in the web UI has no sheet row, so it is invisible to
        # the spreadsheet, to the nine tabs of formulas that read it, and to the
        # daily report. This appends those rows once a day, right after the
        # reconcile, so nobody has to remember to run the mirror by hand.
        #
        # Only the APPEND half of mirror.py runs here on purpose. Updating
        # existing rows needs the hand-edit guard (mirror_payload) and the
        # formula-cell protection, and those stay in the script until they have
        # been watched for a while — appending a row that does not exist yet can
        # not overwrite anybody's work.
        #
        # `mirrored_at is null` is what stops it appending the same booking every
        # morning: the row number is not known here (an append does not report
        # where it landed), so the stamp is the marker, and `reindex.py` learns
        # the real sheet_row from column U on its next pass.
        if "Read Unmirrored Bookings" not in have:
            add_node("Read Unmirrored Bookings", "n8n-nodes-base.postgres", 2.6,
                     {"operation": "executeQuery", "options": {},
                      "query": read_source("read_unmirrored.sql")},
                     [720, 1200], cred=("postgres", pg["id"], pg["name"]))
            print("  + Read Unmirrored Bookings")
        else:
            ops.append({"type": "updateNodeParameters",
                        "nodeName": "Read Unmirrored Bookings",
                        "parameters": {"operation": "executeQuery", "options": {},
                                       "query": read_source("read_unmirrored.sql")}})
            print("  ~ Read Unmirrored Bookings query")

        # update, NOT append. Google's append writes a full-width row and blanks
        # every column the mapping does not mention, which would destroy the
        # per-row formulas in N, P, R and S on whichever row it landed on. K
        # survives an append because it is an array formula; those four are not.
        # The row number is computed in the query instead.
        mirror_write = {
            "operation": "update",
            "documentId": {"__rl": True, "mode": "id", "value": SHEET_ID},
            "sheetName": {"__rl": True, "mode": "name", "value": BOOKINGS_TAB},
            "columns": {"mappingMode": "autoMapInputData",
                        "matchingColumns": ["row_number"],
                        "attemptToConvertTypes": False,
                        "convertFieldsToString": True},
            "options": {},
        }
        if "Append Mirror Row" not in have:
            add_node("Append Mirror Row", "n8n-nodes-base.googleSheets", 4.7,
                     mirror_write, [960, 1200], cred=SHEETS_CRED)
            print("  + Append Mirror Row")
        else:
            ops.append({"type": "updateNodeParameters",
                        "nodeName": "Append Mirror Row",
                        "parameters": mirror_write})
            print("  ~ Append Mirror Row writes one row, never appends")

        if "Mark Mirrored" not in have:
            add_node("Mark Mirrored", "n8n-nodes-base.postgres", 2.6,
                     {"operation": "executeQuery", "options": {},
                      "query": "update bookings set mirrored_at = now(),"
                               " sheet_row = {{ $json.row_number }}"
                               " where id = {{ $json.booking_id }};"},
                     [1200, 1200], cred=("postgres", pg["id"], pg["name"]))
            print("  + Mark Mirrored")
        else:
            ops.append({"type": "updateNodeParameters", "nodeName": "Mark Mirrored",
                        "parameters": {"operation": "executeQuery", "options": {},
                                       "query": "update bookings set mirrored_at = now()"
                                                " where id = {{ $json.booking_id }};"}})

        connect("Build Reconcile Message", "Read Unmirrored Bookings")
        connect("Read Unmirrored Bookings", "Append Mirror Row")
        connect("Append Mirror Row", "Mark Mirrored")
        # Nothing here may break the reconcile that runs before it, and an empty
        # result is the normal case — most mornings there is nothing to publish.
        for node in ("Read Unmirrored Bookings", "Append Mirror Row", "Mark Mirrored"):
            ops.append({"type": "setNodeSettings", "nodeName": node,
                        "settings": {"onError": "continueRegularOutput"}})

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

    print(f"\napplying {len(ops)} operations…")
    print(pb.call_tool("update_workflow",
                       {"workflowId": pb.WORKFLOW_ID, "operations": ops})[:400])

    if "--publish" in sys.argv:
        print(pb.call_tool("publish_workflow", {"workflowId": pb.WORKFLOW_ID}))


if __name__ == "__main__":
    main()
