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
POSTGRES_CRED = ("postgres", "REPLACE_ME", "Supabase Postgres")

# What the row builders read to decide where the next row goes. Every column in
# these ranges is hand-typed; the ranges stop short of the fill-down formula
# columns (K, N, P, R, S, T on the bookings tab) because those evaluate to '' on
# an empty row, and a row that answers '' would read as occupied.
#
# They were single key columns — C اسم المقيم and B البند — and the builders
# COUNTED the rows that came back. On 2026-08-14 that put an expense on top of a
# row typed by hand: the row had no البند, so the count could not see it, and the
# next expense was written straight over it. A row is occupied if ANY of its
# typed columns holds something, and the builders now take the last such row
# rather than counting.
BOOKING_KEY_RANGE = "A1:J2000"
EXPENSE_KEY_RANGE = "A1:H2000"

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


def values_get(tab_expr, rng):
    """Read a range through the Sheets API itself, not through the Sheets node.

    Where the next row goes is arithmetic on the sheet's own row numbers, and
    the node does not give those away honestly: it maps rows into items, decides
    for itself which row is the header, and numbers what is left from its own
    view of the range. Counting those items put a booking on top of the last row
    of both tabs — reported 2026-08-15, after `row_number` had already been
    tried and was one short for the same reason.

    `values.length` has no such ambiguity. The API returns rows from row 1 with
    trailing empty ones trimmed and interior blanks preserved, so its length IS
    the last occupied row and the next row is one below. That is what the Python
    bot did before any of this, and it never landed on an occupied row.
    """
    return {
        "method": "GET",
        # The tab name is Arabic with spaces, so it has to be encoded, and it
        # comes from Config rather than being frozen here — the same value the
        # writer uses, so the two cannot drift onto different tabs.
        "url": "=https://sheets.googleapis.com/v4/spreadsheets/"
               f"{SHEET_ID}/values/{{{{ encodeURIComponent($('Config').first()"
               f".json.{tab_expr} + '!{rng}') }}}}",
        # Same note as Format Cancelled Row: this binding cannot be set over the
        # API, only in the editor or by importing the JSON.
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "googleSheetsOAuth2Api",
        "sendQuery": True,
        "queryParameters": {"parameters": [
            {"name": "majorDimension", "value": "ROWS"},
            # Formulas evaluate to '' on empty rows either way; what matters is
            # that a row holding only a formula still counts as occupied, and
            # UNFORMATTED_VALUE keeps numbers as numbers for the eye.
            {"name": "valueRenderOption", "value": "UNFORMATTED_VALUE"},
        ]},
        "options": {},
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
            # The numeric gid of إدخال الحجوزات, needed only to blacken a
            # cancelled row. Left EMPTY on purpose and the format step is gated
            # on it: a wrong gid would not fail, it would silently format a row
            # of some other tab. Find it in the sheet's URL (#gid=...) and fill
            # it in, or leave it blank and cancellations simply go unformatted.
            {"id": "gid", "name": "BOOKINGS_SHEET_GID", "value": "", "type": "string"},
            {"id": "token", "name": "BOT_TOKEN", "value": "", "type": "string"},
        ]},
        "options": {},
    }, (-260, 300))

    # ── The session ──────────────────────────────────────────────────────────
    #
    # One row per chat in `bot_sessions`, a Postgres table — NOT n8n's Data
    # Table feature, which this used until 2026-08-14. The data table looked up
    # cleanly and wrote nothing: `Save Session` reported success on every turn
    # and the table stayed empty, so every button tap arrived with no state and
    # fell through to "No Action Needed" — the exact bug the session store was
    # introduced to kill, wearing a different coat.
    #
    # Postgres is where everything else durable in this bot already lives, the
    # credential is the one the two lookups already use, and `on conflict` is a
    # guarantee rather than a node option. `schema.sql` owns the table:
    #
    #     chat_id text primary key, state text, data jsonb, updated_at timestamptz
    #
    # `alwaysOutputData` is what lets a chat with no row through as an empty
    # item — the Brain's readSession() treats that as "no session", and without
    # it a first-time user would simply stop here.
    #
    # The Brain wants `updated_at` as epoch milliseconds, because that is what it
    # compares against SESSION_TTL_MS. node-postgres hands a bigint back as a
    # string and `readSession` does `Number(row.updated_at)`, so that is fine.
    #
    # `$1` rather than an interpolated id: the value comes from a Telegram
    # payload, and a query built by string concatenation out of user-controlled
    # input is one apostrophe away from being someone else's query.
    g.node("Load Session", "n8n-nodes-base.postgres", 2.6, {
        "operation": "executeQuery",
        "query": "select state, data::text as data,\n"
                 "       (extract(epoch from updated_at) * 1000)::bigint as updated_at\n"
                 "  from bot_sessions\n"
                 " where chat_id = $1;",
        "options": {"queryReplacement":
                    "={{ String($('Telegram Trigger').first().json.message"
                    "?.chat?.id ?? $('Telegram Trigger').first().json"
                    ".callback_query.message.chat.id) }}"},
    }, (-60, 300), cred=POSTGRES_CRED, alwaysOutputData=True)

    # ── The two gated lookups ────────────────────────────────────────────────
    #
    # Each costs a query, so each runs only on the turns that need it. The Brain
    # references both inside a try/catch precisely because they are unexecuted
    # on every other turn — see bookingRows() and the registry loader.
    #
    # Both reads are Postgres, not Sheets. They were Sheets originally and the
    # swap at Phase 4b is what removed a 0.4–2 s mid-conversation wait; the SQL
    # aliases the sheet's own Arabic headers, so brain.js consumes the rows
    # unchanged. Emitting the superseded Sheets version here would be worse than
    # merely out of date: deploy_graph.py updates these two nodes in place when
    # they already exist, so it would write Postgres parameters onto a Sheets
    # node and leave something that cannot run.
    #
    # alwaysOutputData is load-bearing on both. A query returning no rows would
    # otherwise stop the branch before the Brain ever ran, and the bot would
    # answer nothing at all — the same lesson as Read Discrepancies.
    lookup_settings = dict(alwaysOutputData=True, onError="continueRegularOutput",
                           retryOnFail=True, maxTries=2)

    g.node("Needs Bookings?", "n8n-nodes-base.if", 2.3,
           {"conditions": state_conditions(BOOKING_STATES),
            "looseTypeValidation": True, "options": {}}, (160, 300))
    g.node("Read Bookings For Edit", "n8n-nodes-base.postgres", 2.6,
           {"operation": "executeQuery",
            "query": read_source("read_bookings_for_edit.sql"), "options": {}},
           (360, 180), cred=POSTGRES_CRED, **lookup_settings)
    g.node("Needs Locations?", "n8n-nodes-base.if", 2.3,
           {"conditions": state_conditions(LOCATION_STATES),
            "looseTypeValidation": True, "options": {}}, (560, 300))
    g.node("Read Locations", "n8n-nodes-base.postgres", 2.6,
           {"operation": "executeQuery",
            "query": read_source("read_locations.sql"), "options": {}},
           (760, 180), cred=POSTGRES_CRED, **lookup_settings)

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

    # Save Session goes FIRST, before anything that talks to Telegram. n8n runs a
    # fan-out in the order the connections were declared and stops the whole
    # execution on the first error, so with the session written last a failing
    # Telegram call loses the state for that turn — and the state is the only
    # thing the next message has to go on. Observed exactly that on 2026-08-14:
    # an empty BOT_TOKEN 404'd *Send Reply*, the CHOICE state was never written,
    # and the following tap arrived with no session at all.
    g.connect("Brain", "Save Session")
    g.connect("Brain", "Has Callback?")
    g.connect("Brain", "Has Reply?")
    g.connect("Has Callback?", "Answer Callback", index=0)
    g.connect("Has Reply?", "Send Reply", index=0)

    # ── The session, written back ────────────────────────────────────────────
    #
    # Always, on every turn. The Brain defaults sessionState/sessionData to what
    # it loaded, so a turn that changes nothing rewrites the same values rather
    # than needing a branch to skip it.
    #
    # `sessionData` is always a JSON string — brain.js emits '{}' rather than ''
    # for an empty session — so the `::jsonb` cast never sees anything it cannot
    # parse. `updated_at` is `now()` rather than a value from the turn: the row's
    # age is a fact about the database, and letting the client assert it is how
    # clock skew becomes an expired session.
    g.node("Save Session", "n8n-nodes-base.postgres", 2.6, {
        "operation": "executeQuery",
        "query": "insert into bot_sessions (chat_id, state, data, updated_at)\n"
                 "values ($1, $2, $3::jsonb, now())\n"
                 "on conflict (chat_id) do update\n"
                 "   set state = excluded.state,\n"
                 "       data = excluded.data,\n"
                 "       updated_at = now();",
        # An ARRAY expression, not a comma-separated string. `sessionData` is
        # JSON and full of commas, and the string form is split on them — the
        # session would arrive as three mangled parameters, or as a syntax
        # error, depending on where the commas fell.
        "options": {"queryReplacement":
                    "={{ [$json.chatId, $json.sessionState, $json.sessionData] }}"},
    }, (1160, 480), cred=POSTGRES_CRED)

    # ── The write path ───────────────────────────────────────────────────────
    g.node("Has Save?", "n8n-nodes-base.if", 2.3,
           {"conditions": flag_condition("={{ $json.hasSave }}", "has-save"),
            "options": {}}, (1160, 660))
    g.connect("Brain", "Has Save?")

    # Five flows, four writers. booking and expense append to different tabs —
    # one Sheets node's column mapping is bound to one sheet's headers, so they
    # cannot share a node. edit and cancel both update a row the lookup already
    # found, and differ only in what they say afterwards. payment_line is a
    # payment in a method the booking's own row does not carry: it writes a row
    # of its own, and may have to insert it first.
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
            for flow in ("booking", "expense", "edit", "cancel", "payment_line")
        ]},
        "options": {"fallbackOutput": "none"},
    }, (1360, 660))
    g.connect("Has Save?", "Route Save", index=0)

    # booking: find the last row from the key column, then write only the input
    # columns onto row_number.
    g.node("Read Booking Key", "n8n-nodes-base.httpRequest", 4.2,
           values_get("BOOKINGS_TAB", BOOKING_KEY_RANGE), (1560, 480),
           cred=SHEETS_CRED, alwaysOutputData=True)
    g.node("Build Booking Row", "n8n-nodes-base.code", 2,
           {"jsCode": read_source("build_booking_row.js")}, (1760, 480))
    g.node("Write Booking Row", "n8n-nodes-base.googleSheets", 4.7,
           sheets_update(BOOKINGS_TAB), (1960, 480), cred=SHEETS_CRED)

    # expense: the same shape against the other tab and its own key column.
    g.node("Read Expense Key", "n8n-nodes-base.httpRequest", 4.2,
           values_get("EXPENSE_TAB", EXPENSE_KEY_RANGE), (1560, 660),
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

    # ── A payment on its own line ────────────────────────────────────────────
    #
    # A method the booking's own row does not carry. Either a row already holds
    # that method and its cells grow, or there is no such row and one is
    # inserted directly under the booking's block — which is where a person
    # would put it, and which moves every row below down by one.
    #
    # `inheritFromBefore` is what makes the inserted row a real row of this
    # sheet: it carries down the formatting and the fill-down formulas of the
    # row above, exactly as inserting by hand does. K, N, P, R, S and T are
    # never written by anything here; they arrive already correct.
    g.node("Needs Row Insert?", "n8n-nodes-base.if", 2.3,
           {"conditions": flag_condition("={{ $json.save.insert }}", "wants-insert"),
            "options": {}}, (1560, 1020))
    g.node("Insert Payment Line", "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST",
        "url": f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}:batchUpdate",
        # Same binding note as Format Cancelled Row: the Sheets credential on an
        # HTTP node cannot be set over the API, only in the editor or by import.
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "googleSheetsOAuth2Api",
        "sendBody": True,
        "specifyBody": "json",
        # startIndex is zero-based and the range is half-open, so inserting AT
        # the new row's index puts one row there and pushes the rest down.
        "jsonBody":
            "={{ JSON.stringify({ requests: [{ insertDimension: {"
            " range: { sheetId: Number($('Config').first().json.BOOKINGS_SHEET_GID),"
            " dimension: 'ROWS',"
            " startIndex: $('Brain').first().json.save.row - 1,"
            " endIndex: $('Brain').first().json.save.row },"
            " inheritFromBefore: true } }] }) }}",
        "options": {},
    }, (1760, 1020), cred=SHEETS_CRED)
    g.node("Build Line Rows", "n8n-nodes-base.code", 2,
           {"jsCode": read_source("build_line_rows.js")}, (1960, 1020))
    g.node("Write Line Rows", "n8n-nodes-base.googleSheets", 4.7,
           sheets_update(BOOKINGS_TAB), (2160, 1020), cred=SHEETS_CRED)

    g.connect("Route Save", "Read Booking Key", index=0)
    g.connect("Route Save", "Read Expense Key", index=1)
    g.connect("Route Save", "Build Edit Row", index=2)
    g.connect("Route Save", "Build Edit Row", index=3)
    g.connect("Route Save", "Needs Row Insert?", index=4)
    g.connect("Read Booking Key", "Build Booking Row")
    g.connect("Build Booking Row", "Write Booking Row")
    g.connect("Read Expense Key", "Build Expense Row")
    g.connect("Build Expense Row", "Write Expense Row")
    g.connect("Build Edit Row", "Write Edit Row")
    # A line that already exists needs no insert, so it goes straight to the
    # builder — the false branch, not a second copy of the node.
    g.connect("Needs Row Insert?", "Insert Payment Line", index=0)
    g.connect("Needs Row Insert?", "Build Line Rows", index=1)
    g.connect("Insert Payment Line", "Build Line Rows")
    g.connect("Build Line Rows", "Write Line Rows")

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
    # A transfer payment can carry a receipt — the file_id of a photo the user
    # sent earlier in the flow. When there is one the group gets the picture
    # with the announcement as its caption, which is the whole point of asking
    # for it; when there is not, `receiptFileId` is '' and the group gets the
    # same text as a plain message.
    g.node("Has Receipt?", "n8n-nodes-base.if", 2.3, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "",
                        "typeValidation": "loose", "version": 1},
            "conditions": [{
                "id": "has-receipt",
                "leftValue": "={{ $('Brain').first().json.save.receiptFileId }}",
                "rightValue": "",
                "operator": {"type": "string", "operation": "notEmpty",
                             "singleValue": True}}],
            "combinator": "and"},
        "options": {},
    }, (2360, 660))
    # `file`, not `photo`. The Telegram node names this property `file` for
    # every send-a-thing operation — sendPhoto, sendDocument, sendVideo — and an
    # unrecognised property is simply not sent, so Telegram answered "Bad
    # Request: there is no photo in the request" and the whole execution
    # stopped. Reported live on 2026-08-15: attaching a receipt meant the save
    # never finished.
    #
    # `resource` is explicit for the same reason: the parameter only exists
    # under resource=message, and leaving it to a default is how this class of
    # mistake goes unnoticed.
    g.node("Post Receipt To Group", "n8n-nodes-base.telegram", 1.2, {
        "resource": "message",
        "operation": "sendPhoto",
        "chatId": "={{ $('Brain').first().json.save.groupChatId }}",
        "binaryData": False,
        # A Telegram file_id, re-sent rather than re-uploaded: the photo is
        # already on Telegram's servers, this bot never holds the bytes.
        "file": "={{ $('Brain').first().json.save.receiptFileId }}",
        "additionalFields": {
            "caption": "={{ $('Brain').first().json.save.groupText }}",
            "parse_mode": "Markdown",
            "appendAttribution": False,
        },
    }, (2560, 780), cred=TELEGRAM_CRED)
    g.node("Post To Group", "n8n-nodes-base.telegram", 1.2,
           telegram_send("={{ $('Brain').first().json.save.groupText }}",
                         "={{ $('Brain').first().json.save.groupChatId }}"),
           (2560, 540), cred=TELEGRAM_CRED)
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

    for writer in ("Write Booking Row", "Write Expense Row", "Write Edit Row",
                   "Write Line Rows"):
        g.connect(writer, "Has Group?")
        # Output 1 of a node with onError=continueErrorOutput is the failure.
        g.connect(writer, "Send Save Error", index=1)
        node = next(n for n in g.nodes if n["name"] == writer)
        node["onError"] = "continueErrorOutput"

    g.connect("Has Group?", "Has Receipt?", index=0)
    g.connect("Has Group?", "Send Saved No Group", index=1)
    g.connect("Has Receipt?", "Post Receipt To Group", index=0)
    g.connect("Has Receipt?", "Post To Group", index=1)
    g.connect("Post To Group", "Send Saved")
    g.connect("Post Receipt To Group", "Send Saved")

    # The row is already written by the time these run. Telling the group is the
    # least important thing left, and it must not be able to undo the rest: an
    # error here stops the execution, and with it "تم الحفظ", the session clear
    # and the Postgres write — so the user sees a save that never confirmed and
    # tries again, and the database quietly falls behind the sheet.
    #
    # Observed on 2026-08-15 with a receipt photo: sendPhoto was sent no photo,
    # Telegram refused it, and the whole turn died at the last step with the
    # booking already on the sheet. The parameter is fixed above; this makes the
    # failure survivable whatever causes it next.
    for poster in ("Post To Group", "Post Receipt To Group"):
        node = next(n for n in g.nodes if n["name"] == poster)
        node["onError"] = "continueRegularOutput"

    # ── The conversation ends ────────────────────────────────────────────────
    #
    # Only after a successful write. The session is deliberately kept until then
    # so a failed write leaves the user on CONFIRM with the Save button still
    # working — see the closing comment in brain.js.
    #
    # deploy_graph.py rewrites this node to park an undo pre-image rather than
    # blanking `data`, and hangs the shadow write off it.
    # The state is cleared and `data` keeps the undo pre-image, which is what
    # /undo reads within its ten minutes. Blanking it here is what made an undo
    # impossible for the first two months this bot existed.
    g.node("Clear Session", "n8n-nodes-base.postgres", 2.6, {
        "operation": "executeQuery",
        "query": "insert into bot_sessions (chat_id, state, data, updated_at)\n"
                 "values ($1, '', $2::jsonb, now())\n"
                 "on conflict (chat_id) do update\n"
                 "   set state = '',\n"
                 "       data = excluded.data,\n"
                 "       updated_at = now();",
        "options": {"queryReplacement":
                    "={{ [$('Brain').first().json.chatId,"
                    " JSON.stringify({ lastWrite: $('Brain').first().json.save.undo"
                    " || null, lastAppend: ['booking','expense']"
                    ".includes($('Brain').first().json.save.flow) })] }}"},
    }, (2760, 660), cred=POSTGRES_CRED)
    g.connect("Send Saved", "Clear Session")
    g.connect("Send Saved No Group", "Clear Session")

    # ── A cancelled row is marked in the sheet itself ────────────────────────
    #
    # `save.formatRow` is set only by the cancel flow. Zeroing عدد الليالي and
    # اجمالي سعر الحجز takes the booking out of every total, but the row still
    # reads like a live booking to anyone scrolling the tab — the black fill is
    # what says "cancelled" to a person rather than to a formula.
    #
    # Gated on BOOKINGS_SHEET_GID being filled in as well, because the Sheets
    # API addresses a tab by numeric id and the wrong id does not error: it
    # formats that row of a different tab. Unset means skip, which is the right
    # failure for something cosmetic.
    g.node("Should Format Row?", "n8n-nodes-base.if", 2.3, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "",
                        "typeValidation": "loose", "version": 1},
            "conditions": [
                {"id": "wants-format",
                 "leftValue": "={{ $('Brain').first().json.save.formatRow }}",
                 "rightValue": "",
                 "operator": {"type": "boolean", "operation": "true",
                              "singleValue": True}},
                {"id": "gid-known",
                 "leftValue": "={{ $('Config').first().json.BOOKINGS_SHEET_GID }}",
                 "rightValue": "",
                 "operator": {"type": "string", "operation": "notEmpty",
                              "singleValue": True}},
            ],
            "combinator": "and"},
        "options": {},
    }, (2960, 660))

    # repeatCell over the row's used width, A:U. Written as one JS expression
    # rather than a JSON literal with expressions inside it: n8n evaluates the
    # `={{ }}` wrapper, not strings nested within a structure, so a dict dumped
    # here would post the expression text and format nothing.
    #
    # startRowIndex is 0-based and half-open; save.row is the 1-based sheet row.
    format_body = (
        "={{ JSON.stringify({ requests: [{ repeatCell: {"
        " range: {"
        " sheetId: Number($('Config').first().json.BOOKINGS_SHEET_GID),"
        " startRowIndex: $('Brain').first().json.save.row - 1,"
        " endRowIndex: $('Brain').first().json.save.row,"
        " startColumnIndex: 0, endColumnIndex: 21 },"
        " cell: { userEnteredFormat: {"
        " backgroundColor: { red: 0, green: 0, blue: 0 },"
        " textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 } } } },"
        " fields: 'userEnteredFormat(backgroundColor,textFormat)'"
        " } }] }) }}"
    )
    g.node("Format Cancelled Row", "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST",
        "url": f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}:batchUpdate",
        # The Sheets OAuth2 credential on an HTTP node. Note that binding this
        # over the MCP API fails — setNodeCredential refuses
        # googleSheetsOAuth2Api on httpRequest, because that node resolves its
        # credential type dynamically. Importing the JSON carries it; if the
        # binding is lost, set it once in the editor.
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "googleSheetsOAuth2Api",
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": format_body,
        "options": {},
    }, (3160, 660), cred=SHEETS_CRED)

    g.connect("Clear Session", "Should Format Row?")
    g.connect("Should Format Row?", "Format Cancelled Row", index=0)

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
