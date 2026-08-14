"""
Render the whole bookings-bot graph as importable n8n workflow JSON.

This exists because the original one did not. The live workflow was built in the
n8n editor and pushed from a generator that was never committed; when that n8n
instance was destroyed on 2026-08-14 the graph went with it, and the repo could
rebuild only the twenty nodes `deploy_graph.py` happens to create. Everything
else — the trigger, the session store, the Brain's wiring, the whole write path —
existed nowhere but inside the running instance.

So the graph lives here now, in version control, and the instance is downstream
of it rather than the other way round.

    python booking_bot/build_workflow.py                  # write the JSON
    python booking_bot/build_workflow.py --print          # to stdout instead
    python booking_bot/validate_workflow.py               # check it

The output is `bookings-bot.workflow.json`, for n8n's *Import from File*. After
importing, three things are needed and none of them can come from this file:

  1. **Credentials.** A fresh instance has none, and credential ids are
     per-instance. The ids below are placeholders — every node that needs one is
     listed by `--creds`, and n8n will show them as unset after the import.
  2. **The `bookings_bot_sessions` data table**, with columns `chat_id` (string),
     `state` (string), `data` (string), `updated_at` (number). The session nodes
     address it by name.
  3. **`Config.BOT_TOKEN`**, deliberately empty here. It is the one secret the
     graph carries, and a generator that writes it into a committed file is a
     generator that commits a bot token.

Then, in this order:

    python booking_bot/deploy_graph.py --publish   # the reports/shadow/mirror branch
    python booking_bot/push_brain.py   --publish   # brain.js + the Config lists

`deploy_graph.py` adds the twenty nodes it owns on top of this base and expects
`Brain`, `Config`, `Clear Session`, `Needs Bookings?`, `Read Bookings For Edit`
and `Read Locations` to exist — they are built here, which is what makes the two
scripts compose.

## What the graph is

A Telegram turn arrives, the session for that chat is loaded, two optional
lookups run only on the turns that need them, and the Brain decides everything
else. The Brain is a pure function of (update, session, lookups) and returns one
object:

    { chatId, callbackQueryId, hasCallback,
      hasReply, reply,        -> Send Reply
      hasSave,  save,         -> Route Save -> one of three write branches
      sessionState, sessionData }  -> Save Session

`save.flow` is `booking`, `expense`, `edit` or `cancel`. The first two append to
their tab by finding the true last row from a formula-free key column; the last
two update a row the lookup already identified. No path uses the Sheets `append`
operation: it writes empty strings into the sheet's formula columns (K, N, P, R,
S, T) and destroys them.
"""

import argparse
import json
import os
import sys

# Every tab name, guest prompt and group message in this graph is Arabic, and a
# Windows console defaults to a codepage that cannot encode any of it.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(HERE, "bookings-bot.workflow.json")

WORKFLOW_NAME = "Bookings Bot (Telegram - Google Sheets)"

SHEET_ID = "1CiHciOeeyRMx9vz5cP0Xlid-jqM_gVjW3sUfore84S8"
BOOKINGS_TAB = "إدخال الحجوزات"
EXPENSE_TAB = "مصروفات عامة"

GROUP_CHAT_ID = "-4809181011"
EXPENSE_GROUP_CHAT_ID = "-4809181011"
REPORT_GROUP_CHAT_ID = "-5057362381"
TIMEZONE = "Africa/Cairo"

ADMIN_USERS = "7941350507,@AbdulrahmanMohamed5,1226903540,5793725130"
CASHIER_USERS = "@Seifgamal24,@seiiffseiif"

SESSION_TABLE = "bookings_bot_sessions"

# Placeholders. Credential ids are per-instance and a fresh n8n has none of
# these — the import will show every one of them as unset, which is the correct
# and visible outcome rather than a silent binding to something that is not there.
TELEGRAM_CRED = ("telegramApi", "REPLACE_ME", "Telegram account")
SHEETS_CRED = ("googleSheetsOAuth2Api", "REPLACE_ME", "Google Sheets account")

# The key column of each tab: hand-typed, carrying no fill-down formula, so its
# length is the true last data row. C اسم المقيم for bookings, B البند for
# expenses. Reading a formula column instead would count the sheet's own filled
# tail and append far below the data.
BOOKING_KEY_RANGE = "C2:C2000"
EXPENSE_KEY_RANGE = "B2:B2000"

# States whose turn needs a lookup before the Brain runs. Kept identical to
# deploy_graph.py, which rewrites the same two gates — see BOOKING_STATES and
# LOCATION_STATES there. NOTES is in the booking list because that is the turn
# which draws the confirmation, where the availability check needs rows.
BOOKING_STATES = ["EDIT_FIND", "EDIT_PICK", "NOTES"]
LOCATION_STATES = ["PHONE", "EXP_AMOUNT", "EDIT_MENU"]


def read_source(name):
    with open(os.path.join(HERE, "nodes", name), encoding="utf-8") as fh:
        return fh.read()


def brain_source():
    with open(os.path.join(HERE, "brain.js"), encoding="utf-8") as fh:
        return fh.read()


class Graph:
    """Nodes and connections, accumulated in the order they are declared."""

    def __init__(self):
        self.nodes = []
        self.connections = {}
        self._creds = []

    def node(self, name, ntype, tv, params, pos, cred=None, **settings):
        node = {
            "id": name.lower().replace(" ", "-").replace("?", ""),
            "name": name,
            "type": ntype,
            "typeVersion": tv,
            "position": list(pos),
            "parameters": params,
        }
        node.update(settings)
        if cred:
            key, cid, cname = cred
            node["credentials"] = {key: {"id": cid, "name": cname}}
            self._creds.append((name, key, cname))
        self.nodes.append(node)
        return name

    def connect(self, src, tgt, index=0):
        """Wire src output `index` to tgt input 0."""
        main = self.connections.setdefault(src, {}).setdefault("main", [])
        while len(main) <= index:
            main.append([])
        main[index].append({"node": tgt, "type": "main", "index": 0})

    def credentials_needed(self):
        return self._creds


def state_conditions(states):
    """An IF that fires when the loaded session state is any of `states`."""
    return {
        "options": {"caseSensitive": True, "leftValue": "",
                    "typeValidation": "loose", "version": 1},
        "conditions": [
            {"id": f"is-{s.lower()}", "leftValue": "={{ $json.state }}",
             "rightValue": s, "operator": {"type": "string", "operation": "equals"}}
            for s in states
        ],
        "combinator": "or",
    }


def flag_condition(expr, cid):
    """An IF on a single boolean the Brain emitted."""
    return {
        "options": {"caseSensitive": True, "leftValue": "",
                    "typeValidation": "loose", "version": 1},
        "conditions": [
            {"id": cid, "leftValue": expr, "rightValue": "",
             "operator": {"type": "boolean", "operation": "true", "singleValue": True}}
        ],
        "combinator": "and",
    }


def sheets_read(tab, rng):
    return {
        "documentId": {"__rl": True, "mode": "id", "value": SHEET_ID},
        "sheetName": {"__rl": True, "mode": "name", "value": tab},
        "options": {"dataLocationOnSheet": {"values": {
            "rangeDefinition": "specifyRangeA1", "range": rng}}},
    }


def sheets_update(tab):
    """Update matched on row_number, mapping whatever the row builder emitted.

    `autoMapInputData` is what keeps this safe: only the columns present in the
    item are written, so the sheet's formula columns survive untouched. The
    `append` operation is never used anywhere in this graph — it writes an empty
    string into every unmapped column, which is how K, N, P, R, S and T get
    destroyed.
    """
    return {
        "operation": "update",
        "documentId": {"__rl": True, "mode": "id", "value": SHEET_ID},
        "sheetName": {"__rl": True, "mode": "name", "value": tab},
        "columns": {
            "mappingMode": "autoMapInputData",
            "matchingColumns": ["row_number"],
            "value": {},
        },
        "options": {},
    }


def telegram_send(text_expr, chat_expr):
    return {
        "chatId": chat_expr,
        "text": text_expr,
        "additionalFields": {"parse_mode": "Markdown", "appendAttribution": False},
    }


def build():
    g = Graph()

    # ── The turn arrives ─────────────────────────────────────────────────────
    #
    # Both update kinds land here. A callback_query is how every keyboard tap
    # comes back, and the Brain reads them through $('Telegram Trigger').
    g.node("Telegram Trigger", "n8n-nodes-base.telegramTrigger", 1.2,
           {"updates": ["message", "callback_query"], "additionalFields": {}},
           (-460, 300), cred=TELEGRAM_CRED, webhookId="bookings-bot-telegram")

    # ── Config ───────────────────────────────────────────────────────────────
    #
    # Every tunable the Brain reads, in one Set node, because that is where a
    # person changes them without touching code. push_brain.py rewrites
    # ADMIN_USERS and CASHIER_USERS here and deploy_graph.py appends
    # REPORT_GROUP_CHAT_ID, so the names must match theirs exactly.
    #
    # BOT_TOKEN is deliberately empty: it is the one secret the graph carries,
    # and this file is committed.
    g.node("Config", "n8n-nodes-base.set", 3.4, {
        "assignments": {"assignments": [
            {"id": "admins", "name": "ADMIN_USERS", "value": ADMIN_USERS, "type": "string"},
            {"id": "cashiers", "name": "CASHIER_USERS", "value": CASHIER_USERS,
             "type": "string"},
            {"id": "tz", "name": "TIMEZONE", "value": TIMEZONE, "type": "string"},
            {"id": "group", "name": "GROUP_CHAT_ID", "value": GROUP_CHAT_ID,
             "type": "string"},
            {"id": "exp_group", "name": "EXPENSE_GROUP_CHAT_ID",
             "value": EXPENSE_GROUP_CHAT_ID, "type": "string"},
            {"id": "report_group", "name": "REPORT_GROUP_CHAT_ID",
             "value": REPORT_GROUP_CHAT_ID, "type": "string"},
            {"id": "bookings_tab", "name": "BOOKINGS_TAB", "value": BOOKINGS_TAB,
             "type": "string"},
            {"id": "expense_tab", "name": "EXPENSE_TAB", "value": EXPENSE_TAB,
             "type": "string"},
            {"id": "sheet", "name": "SHEET_ID", "value": SHEET_ID, "type": "string"},
            {"id": "token", "name": "BOT_TOKEN", "value": "", "type": "string"},
        ]},
        "options": {},
    }, (-260, 300))

    # ── The session ──────────────────────────────────────────────────────────
    #
    # One row per chat in the `bookings_bot_sessions` data table.
    # `alwaysOutputData` is what lets a chat with no row through as an empty
    # item — the Brain's readSession() treats that as "no session", and without
    # it a first-time user would simply stop here.
    g.node("Load Session", "n8n-nodes-base.dataTable", 1, {
        "operation": "get",
        "dataTableId": {"__rl": True, "mode": "name", "value": SESSION_TABLE},
        "filters": {"conditions": [
            {"keyName": "chat_id", "condition": "eq",
             "keyValue": "={{ $('Telegram Trigger').first().json.message"
                         "?.chat?.id ?? $('Telegram Trigger').first().json"
                         ".callback_query.message.chat.id }}"}
        ]},
        "options": {},
    }, (-60, 300), alwaysOutputData=True)

    # ── The two gated lookups ────────────────────────────────────────────────
    #
    # Each costs a query, so each runs only on the turns that need it. The Brain
    # references both inside a try/catch precisely because they are unexecuted
    # on every other turn — see bookingRows() and the registry loader.
    #
    # deploy_graph.py rewrites both gates and replaces the two reads with
    # Postgres nodes; they are declared here so the base graph is connected and
    # importable on its own.
    g.node("Needs Bookings?", "n8n-nodes-base.if", 2.3,
           {"conditions": state_conditions(BOOKING_STATES), "options": {}},
           (160, 300))
    g.node("Read Bookings For Edit", "n8n-nodes-base.googleSheets", 4.7,
           sheets_read(BOOKINGS_TAB, "A1:U2000"), (360, 180), cred=SHEETS_CRED)
    g.node("Needs Locations?", "n8n-nodes-base.if", 2.3,
           {"conditions": state_conditions(LOCATION_STATES), "options": {}},
           (560, 300))
    g.node("Read Locations", "n8n-nodes-base.googleSheets", 4.7,
           sheets_read("الإتاحة", "A3:B300"), (760, 180), cred=SHEETS_CRED)

    g.connect("Telegram Trigger", "Config")
    g.connect("Config", "Load Session")
    g.connect("Load Session", "Needs Bookings?")
    # true -> look the bookings up first; false -> straight on to the next gate.
    g.connect("Needs Bookings?", "Read Bookings For Edit", index=0)
    g.connect("Needs Bookings?", "Needs Locations?", index=1)
    g.connect("Read Bookings For Edit", "Needs Locations?")
    g.connect("Needs Locations?", "Read Locations", index=0)

    # ── The Brain ────────────────────────────────────────────────────────────
    g.node("Brain", "n8n-nodes-base.code", 2, {"jsCode": brain_source()}, (960, 300))
    g.connect("Read Locations", "Brain")
    g.connect("Needs Locations?", "Brain", index=1)

    # ── Answering the turn ───────────────────────────────────────────────────
    #
    # Every keyboard tap must be acknowledged or Telegram leaves the button
    # spinning, so this runs on any update that carried a callback_query,
    # whether or not the turn produced anything else.
    g.node("Has Callback?", "n8n-nodes-base.if", 2.3,
           {"conditions": flag_condition("={{ $json.hasCallback }}", "has-callback"),
            "options": {}}, (1160, 120))
    g.node("Answer Callback", "n8n-nodes-base.telegram", 1.2, {
        "resource": "callback",
        "operation": "answerQuery",
        "queryId": "={{ $json.callbackQueryId }}",
        "additionalFields": {},
    }, (1360, 120), cred=TELEGRAM_CRED)

    # Send Reply is the one HTTP Request node in the graph and cannot become a
    # Telegram node: the Telegram node's inlineKeyboard is a fixed collection,
    # so the NUMBER of rows and buttons is set at design time. The calendar, the
    # apartment/room grid and the nights pad all vary in size, and the Brain
    # already emits a complete sendMessage body — reply_markup included.
    g.node("Has Reply?", "n8n-nodes-base.if", 2.3,
           {"conditions": flag_condition("={{ $json.hasReply }}", "has-reply"),
            "options": {}}, (1160, 300))
    g.node("Send Reply", "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST",
        "url": "=https://api.telegram.org/bot"
               "{{ $('Config').first().json.BOT_TOKEN }}/sendMessage",
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json.reply) }}",
        "options": {},
    }, (1360, 300))

    g.connect("Brain", "Has Callback?")
    g.connect("Brain", "Has Reply?")
    g.connect("Brain", "Save Session")
    g.connect("Has Callback?", "Answer Callback", index=0)
    g.connect("Has Reply?", "Send Reply", index=0)

    # ── The session, written back ────────────────────────────────────────────
    #
    # Always, on every turn. The Brain defaults sessionState/sessionData to what
    # it loaded, so a turn that changes nothing rewrites the same values rather
    # than needing a branch to skip it.
    g.node("Save Session", "n8n-nodes-base.dataTable", 1, {
        "operation": "upsert",
        "dataTableId": {"__rl": True, "mode": "name", "value": SESSION_TABLE},
        "filters": {"conditions": [
            {"keyName": "chat_id", "condition": "eq",
             "keyValue": "={{ $json.chatId }}"}
        ]},
        "columns": {"mappingMode": "defineBelow", "value": {
            "chat_id": "={{ $json.chatId }}",
            "state": "={{ $json.sessionState }}",
            "data": "={{ $json.sessionData }}",
            "updated_at": "={{ Date.now() }}",
        }},
        "options": {},
    }, (1160, 480))

    # ── The write path ───────────────────────────────────────────────────────
    g.node("Has Save?", "n8n-nodes-base.if", 2.3,
           {"conditions": flag_condition("={{ $json.hasSave }}", "has-save"),
            "options": {}}, (1160, 660))
    g.connect("Brain", "Has Save?")

    # Four flows, three writers. booking and expense append to different tabs —
    # one Sheets node's column mapping is bound to one sheet's headers, so they
    # cannot share a node. edit and cancel both update a row the lookup already
    # found, and differ only in what they say afterwards.
    g.node("Route Save", "n8n-nodes-base.switch", 3.2, {
        "rules": {"values": [
            {"conditions": {
                "options": {"caseSensitive": True, "leftValue": "",
                            "typeValidation": "loose", "version": 1},
                "conditions": [{"id": f"is-{flow}",
                                "leftValue": "={{ $json.save.flow }}",
                                "rightValue": flow,
                                "operator": {"type": "string", "operation": "equals"}}],
                "combinator": "and"},
             "outputKey": flow}
            for flow in ("booking", "expense", "edit", "cancel")
        ]},
        "options": {"fallbackOutput": "none"},
    }, (1360, 660))
    g.connect("Has Save?", "Route Save", index=0)

    # booking: find the last row from the key column, then write only the input
    # columns onto row_number.
    g.node("Read Booking Key", "n8n-nodes-base.googleSheets", 4.7,
           sheets_read(BOOKINGS_TAB, BOOKING_KEY_RANGE), (1560, 480),
           cred=SHEETS_CRED, alwaysOutputData=True)
    g.node("Build Booking Row", "n8n-nodes-base.code", 2,
           {"jsCode": read_source("build_booking_row.js")}, (1760, 480))
    g.node("Write Booking Row", "n8n-nodes-base.googleSheets", 4.7,
           sheets_update(BOOKINGS_TAB), (1960, 480), cred=SHEETS_CRED)

    # expense: the same shape against the other tab and its own key column.
    g.node("Read Expense Key", "n8n-nodes-base.googleSheets", 4.7,
           sheets_read(EXPENSE_TAB, EXPENSE_KEY_RANGE), (1560, 660),
           cred=SHEETS_CRED, alwaysOutputData=True)
    g.node("Build Expense Row", "n8n-nodes-base.code", 2,
           {"jsCode": read_source("build_expense_row.js")}, (1760, 660))
    g.node("Write Expense Row", "n8n-nodes-base.googleSheets", 4.7,
           sheets_update(EXPENSE_TAB), (1960, 660), cred=SHEETS_CRED)

    # edit and cancel: no row arithmetic, the row came from the lookup.
    g.node("Build Edit Row", "n8n-nodes-base.code", 2,
           {"jsCode": read_source("build_edit_row.js")}, (1760, 840))
    g.node("Write Edit Row", "n8n-nodes-base.googleSheets", 4.7,
           sheets_update(BOOKINGS_TAB), (1960, 840), cred=SHEETS_CRED)

    g.connect("Route Save", "Read Booking Key", index=0)
    g.connect("Route Save", "Read Expense Key", index=1)
    g.connect("Route Save", "Build Edit Row", index=2)
    g.connect("Route Save", "Build Edit Row", index=3)
    g.connect("Read Booking Key", "Build Booking Row")
    g.connect("Build Booking Row", "Write Booking Row")
    g.connect("Read Expense Key", "Build Expense Row")
    g.connect("Build Expense Row", "Write Expense Row")
    g.connect("Build Edit Row", "Write Edit Row")

    # ── After the write ──────────────────────────────────────────────────────
    #
    # All three writers converge: tell the group, tell the user, end the
    # conversation. The Brain has already composed every string, including the
    # one for when there is no group to post to.
    g.node("Has Group?", "n8n-nodes-base.if", 2.3, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "",
                        "typeValidation": "loose", "version": 1},
            "conditions": [{
                "id": "has-group",
                "leftValue": "={{ $('Brain').first().json.save.groupChatId }}",
                "rightValue": "",
                "operator": {"type": "string", "operation": "notEmpty",
                             "singleValue": True}}],
            "combinator": "and"},
        "options": {},
    }, (2160, 660))
    g.node("Post To Group", "n8n-nodes-base.telegram", 1.2,
           telegram_send("={{ $('Brain').first().json.save.groupText }}",
                         "={{ $('Brain').first().json.save.groupChatId }}"),
           (2360, 540), cred=TELEGRAM_CRED)
    g.node("Send Saved", "n8n-nodes-base.telegram", 1.2,
           telegram_send("={{ $('Brain').first().json.save.savedText }}",
                         "={{ $('Brain').first().json.chatId }}"),
           (2560, 540), cred=TELEGRAM_CRED)
    g.node("Send Saved No Group", "n8n-nodes-base.telegram", 1.2,
           telegram_send("={{ $('Brain').first().json.save.savedNoGroupText }}",
                         "={{ $('Brain').first().json.chatId }}"),
           (2360, 780), cred=TELEGRAM_CRED)

    # The write itself is the thing that can fail — a revoked Sheets token, a
    # renamed tab. onError keeps the run alive so the user is told, instead of
    # the turn vanishing and the Save button appearing to do nothing.
    g.node("Send Save Error", "n8n-nodes-base.telegram", 1.2,
           telegram_send("={{ $('Brain').first().json.save.errorText }}",
                         "={{ $('Brain').first().json.chatId }}"),
           (2160, 960), cred=TELEGRAM_CRED)

    for writer in ("Write Booking Row", "Write Expense Row", "Write Edit Row"):
        g.connect(writer, "Has Group?")
        # Output 1 of a node with onError=continueErrorOutput is the failure.
        g.connect(writer, "Send Save Error", index=1)
        node = next(n for n in g.nodes if n["name"] == writer)
        node["onError"] = "continueErrorOutput"

    g.connect("Has Group?", "Post To Group", index=0)
    g.connect("Has Group?", "Send Saved No Group", index=1)
    g.connect("Post To Group", "Send Saved")

    # ── The conversation ends ────────────────────────────────────────────────
    #
    # Only after a successful write. The session is deliberately kept until then
    # so a failed write leaves the user on CONFIRM with the Save button still
    # working — see the closing comment in brain.js.
    #
    # deploy_graph.py rewrites this node to park an undo pre-image rather than
    # blanking `data`, and hangs the shadow write off it.
    g.node("Clear Session", "n8n-nodes-base.dataTable", 1, {
        "operation": "upsert",
        "dataTableId": {"__rl": True, "mode": "name", "value": SESSION_TABLE},
        "filters": {"conditions": [
            {"keyName": "chat_id", "condition": "eq",
             "keyValue": "={{ $('Brain').first().json.chatId }}"}
        ]},
        "columns": {"mappingMode": "defineBelow", "value": {
            "chat_id": "={{ $('Brain').first().json.chatId }}",
            "state": "",
            "data": "{}",
            "updated_at": "={{ Date.now() }}",
        }},
        "options": {},
    }, (2760, 660))
    g.connect("Send Saved", "Clear Session")
    g.connect("Send Saved No Group", "Clear Session")

    return g


def workflow(g):
    return {
        "name": WORKFLOW_NAME,
        "nodes": g.nodes,
        "connections": g.connections,
        "settings": {"executionOrder": "v1", "timezone": TIMEZONE},
        "pinData": {},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", dest="to_stdout", action="store_true")
    ap.add_argument("--creds", action="store_true",
                    help="list the credentials the import will need")
    args = ap.parse_args()

    g = build()
    wf = workflow(g)
    blob = json.dumps(wf, ensure_ascii=False, indent=2)

    if args.creds:
        seen = []
        for name, key, cname in g.credentials_needed():
            seen.append(f"  {name:24} {key} ({cname})")
        print("credentials to bind after import:")
        print("\n".join(seen))
        return

    if args.to_stdout:
        print(blob)
        return

    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(blob + "\n")
    print(f"wrote {os.path.relpath(OUT_PATH, os.path.dirname(HERE))}"
          f" — {len(g.nodes)} nodes, {sum(len(v['main']) for v in g.connections.values())}"
          f" connection groups")


if __name__ == "__main__":
    main()
