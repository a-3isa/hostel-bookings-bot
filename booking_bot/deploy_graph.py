"""
Apply this repo's graph shape to the live n8n workflow.

`push_brain.py` syncs code into nodes that already exist. This script owns the
*structure*: it adds the nodes and connections the 2026-08-08 hardening round
needs, and rewrites the two gate/session nodes whose behaviour changed. It is
idempotent — every step checks the live graph first, so re-running is a no-op.

    python booking_bot/deploy_graph.py            # apply to the draft
    python booking_bot/deploy_graph.py --publish  # apply, then activate

What it sets up:

  * Config gains REPORT_GROUP_CHAT_ID.
  * "Needs Bookings?" also fires on NOTES, the turn that draws the booking
    confirmation, so the availability check has rows to look at.
  * "Needs Locations?" / "Read Locations" — الإتاحة!A5:B, read only on the turns
    that draw an apartment keyboard.
  * "Clear Session" parks the undo pre-image instead of blanking `data`.
  * A schedule branch: Report Schedule → Report Config → Read Report Formulas →
    Read Report Values → Build Reports → Send Report.
"""

import json
import os
import sys

import push_brain as pb   # same directory; reuses its JSON-RPC plumbing

HERE = os.path.dirname(os.path.abspath(__file__))

SHEET_ID = "1CiHciOeeyRMx9vz5cP0Xlid-jqM_gVjW3sUfore84S8"
BOOKINGS_TAB = "إدخال الحجوزات"
AVAILABILITY_TAB = "الإتاحة"
REPORT_GROUP_CHAT_ID = "-5057362381"

SHEETS_CRED = ("googleSheetsOAuth2Api", "plB4FVxraemXQcRt", "Google Sheets account")
TELEGRAM_CRED = ("telegramApi", "bjQrxjNH2WgrghIQ", "Telegram account")

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


def main():
    pb.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                          "clientInfo": {"name": "deploy_graph", "version": "1.0"}})
    wf = json.loads(pb.call_tool("get_workflow_details",
                                 {"workflowId": pb.WORKFLOW_ID}))["workflow"]
    have = {n["name"] for n in wf["nodes"]}
    conns = wf.get("connections", {})
    print(f"live: {len(have)} nodes")

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
            creds.append({"type": "setNodeCredential", "nodeName": name,
                          "credentialKey": key, "credentialId": cid, "credentialName": cname})

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
    if "Read Locations" not in have:
        # A3 is the header row (الشقة | الغرفة), so the Sheets node names the
        # columns properly. Row 4 is the tab's own date strip and arrives as a
        # row with no room number, which the registry builder drops.
        add_node("Read Locations", "n8n-nodes-base.googleSheets", 4.7,
                 sheets_read(AVAILABILITY_TAB, "A3:B200"),
                 [-304, 480], cred=SHEETS_CRED)
        print("  + Read Locations")

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
    cols["value"]["data"] = (
        "={{ JSON.stringify({ lastWrite: $('Brain').first().json.save.undo || null,"
        " lastAppend: !$('Brain').first().json.save.undo }) }}"
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
                 sheets_read(BOOKINGS_TAB, "A:T", formula=True),
                 [-720, 800], cred=SHEETS_CRED)
        print("  + Read Report Formulas")
    if "Read Report Values" not in have:
        # executeOnce: the formulas read hands it N items, and without this the
        # Sheets node would re-read the whole tab once per row.
        add_node("Read Report Values", "n8n-nodes-base.googleSheets", 4.7,
                 sheets_read(BOOKINGS_TAB, "A:T"),
                 [-480, 800], cred=SHEETS_CRED, settings={"executeOnce": True})
        print("  + Read Report Values (executeOnce)")
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
    ops.append({"type": "updateNodeParameters", "nodeName": "Read Locations",
                "parameters": sheets_read(AVAILABILITY_TAB, "A3:B200")})

    connect("Report Schedule", "Report Config")
    connect("Report Config", "Read Report Formulas")
    connect("Read Report Formulas", "Read Report Values")
    connect("Read Report Values", "Build Reports")
    connect("Build Reports", "Send Report")

    ops.extend(creds)          # credentials bind after their node exists
    if not ops:
        print("nothing to do")
        return

    print(f"\napplying {len(ops)} operations…")
    print(pb.call_tool("update_workflow",
                       {"workflowId": pb.WORKFLOW_ID, "operations": ops})[:400])

    if "--publish" in sys.argv:
        print(pb.call_tool("publish_workflow", {"workflowId": pb.WORKFLOW_ID}))


if __name__ == "__main__":
    main()
