# Bookings bot on n8n

A full port of the live Python bot (`/start` → booking flow or expense flow) to a
single n8n workflow. Same Arabic prompts, same keyboards, same sheet columns —
including leaving **column P (المتبقي) empty** so the sheet's own formula owns it.

## What's here

> **The graph lives in this repo now.** It did not before: the workflow was built
> in the n8n editor and pushed by a generator that was never committed, so when
> that instance was destroyed on 2026-08-14 the graph went with it and only the
> twenty nodes `deploy_graph.py` creates could be rebuilt. `build_workflow.py`
> is the replacement, and it emits the whole thing. Edit the generator, never the
> editor, or this happens again.

| File | Purpose |
|---|---|
| `brain.js` | The whole conversation state machine. Lives in the *Brain* Code node. |
| `nodes/*.js`, `nodes/*.sql` | The bodies of every other Code and Postgres node. |
| `build_workflow.py` | Renders the core graph as importable workflow JSON. |
| `bookings-bot.workflow.json` | **Generated.** For *Import from File*. |
| `validate_workflow.py` | Checks the JSON for dangling connections / orphan nodes. |
| `test_workflow.py` | The generated graph still matches what the JS expects. |
| `deploy_graph.py` | Adds the reports / shadow / reconcile / mirror branch to a live workflow. |
| `push_brain.py` | Pushes `brain.js` and the Config access lists into a live workflow. |
| `test_brain.mjs` | 379 offline assertions driving every flow end to end. |

Edit the `.js` files, then:

```bash
node booking_bot/test_brain.mjs        # the state machine, offline
python booking_bot/push_brain.py       # deploy (see below)
```

## Deployed instance

Pushed to `https://superfoxxy.dpdns.org` via the **n8n MCP server** (`create_workflow_from_code`):

- Workflow: **Bookings Bot (Telegram - Google Sheets)** — id `2H97FsGnzwmzl7YE`
- <https://superfoxxy.dpdns.org/workflow/2H97FsGnzwmzl7YE>
- Status: **published and active.**

To re-push after editing `brain.js`: `python booking_bot/push_brain.py --publish`
(see *Deploying a brain.js change* below).

### Remaining manual steps

**None.** All credentials are bound over MCP. This became possible on 2026-08-06
when the Sheets calls moved from HTTP Request to the real Google Sheets node —
`setNodeCredential` refuses `googleSheetsOAuth2Api` on `n8n-nodes-base.httpRequest`
(it resolves its credential type dynamically via `nodeCredentialType`, so only the
UI could bind it), but accepts it on `n8n-nodes-base.googleSheets`.

Before publishing, **verify the row calculation** — see *Things to know* below.

> `update_workflow` fails with *"Cannot modify workflow while it is being edited
> by a user in the editor"* whenever the workflow is open in a browser tab. Close
> the tab before pushing changes over MCP.

## How it maps to the Python bot

| Python | n8n |
|---|---|
| `ConversationHandler` states | `switch (state)` in the *Brain* Code node |
| `context.user_data` | a row in the `bookings_bot_sessions` **data table** |
| `InlineKeyboardMarkup` | plain `reply_markup` JSON on the HTTP *Send Reply* node |
| `sheets.append_booking_input` | *Read Booking Key* → *Build Booking Row* → *Write Booking Row* |
| `sheets.append_expense_row` | *Read Expense Key* → *Build Expense Row* → *Write Expense Row* |
| `return ConversationHandler.END` | the *Clear Session* node (upserts an empty state) |

**Only one HTTP Request node remains: *Send Reply*.** Everything else uses a
built-in node. Send Reply cannot be converted: the Telegram node's `inlineKeyboard`
is a *fixed collection*, so while each button's `text`/`callback_data` may be an
expression, the **number** of rows and buttons is set at design time. The calendar,
the 6×5 apartment/room grid and the 1–30 nights pad all vary in size. The five
keyboard-free sends (*Answer Callback*, *Post To Group*, *Send Saved*, *Send Saved
No Group*, *Send Save Error*) are native Telegram nodes with `appendAttribution`
turned off.

The write path uses the Google Sheets **`update`** operation matched on
`row_number`, never `append`. Same reason the Python code uses `batch_update`: it
finds the true last row from a formula-free key column (C اسم المقيم for bookings,
B البند for expenses), then writes **only** the input columns — so the sheet's own
formulas in **K, N, P, R, S and T** survive. `append` would write empty strings
into those cells and destroy them. `P` (المتبقي) is calculated by the sheet.

Because one node's column mapping is bound to one sheet's headers, the write is
**split into two branches** behind an *Is Expense?* IF — a single Sheets node
cannot serve both tabs. Columns are addressed by **header name**, so the header
strings in `brain.js` (`save.fields`) must match the sheet exactly; the test suite
pins them.

### Not ported

`handlers/admin.py` and `handlers/check_booking.py` are dead code — `bot.py` only
registers `build_booking_handler()`, so nothing reaches them. The `Locations` /
`Rooms` / `Config` helpers in `sheets.py` are unused by the live flow too.

## Rebuilding into a fresh n8n

```
python booking_bot/build_workflow.py            # -> bookings-bot.workflow.json
python booking_bot/validate_workflow.py         # structure, refs, contract, append ban
python -m pytest booking_bot/test_workflow.py   # and that those checks still bite
python booking_bot/build_workflow.py --creds    # what the import will ask for
```

Import the JSON, then:

1. **Bind credentials** — 15 nodes need one; `--creds` lists them.
2. **Create the `bookings_bot_sessions` data table**: `chat_id` (string),
   `state` (string), `data` (string), `updated_at` (number). The session nodes
   address it by name, so the name must match exactly.
3. **Fill `Config.BOT_TOKEN`** — left empty by the generator on purpose, because
   this file is committed and it is the one secret the graph carries.
4. **Fill `Config.BOOKINGS_SHEET_GID`** with the numeric gid of إدخال الحجوزات
   (from the sheet URL's `#gid=`). Optional: it only blackens a cancelled row,
   and it is deliberately gated so that leaving it empty skips the formatting
   rather than formatting that row of whichever tab is gid 0.

Then `deploy_graph.py --publish`, then `push_brain.py --publish`.

> **The node *parameters* have not been verified against a running n8n yet.** The
> topology, the node names and every JS body are pinned by `brain.js` and the
> test suites, but the exact parameter shapes for the Data Table nodes, the
> Switch and the Telegram callback answer were written from the node docs rather
> than read back off a live instance. Expect a correction pass on the first
> import. `validate_workflow.py` checks structure, not field names.

## Setup from scratch (manual import path)

### 1. Prerequisite: n8n must be reachable on public HTTPS

Telegram webhooks require a valid TLS certificate. If your n8n has no public
HTTPS URL, the Telegram Trigger cannot register and **this will not work** — fix
that first (reverse proxy + certificate, or n8n Cloud).

### 2. Import

n8n → **Workflows** → **Import from File** → `bookings-bot.workflow.json`.

### 3. Credentials

- **Telegram** — create a *Telegram API* credential with the bot token and select
  it on the **Telegram Trigger** node. (The trigger uses it to register the webhook.)
- **Google Sheets** — the two Sheets nodes (*Read Key Column*, *Write Booking Row*)
  are set to `Google Sheets OAuth2 API`. Either:
  - pick/create an OAuth2 credential, then **share the spreadsheet with that
    Google account**; or
  - switch their credential dropdown to *Google Service Account* and paste the
    `client_email` + `private_key` from your existing `GOOGLE_CREDENTIALS_JSON` —
    that account already has access, so nothing to share.

### Deploying

```
node booking_bot/test_brain.mjs             # the state machine, offline
node booking_bot/test_reports.mjs           # the scheduled reports, offline

python booking_bot/push_brain.py --publish    # brain.js + the Config lists
python booking_bot/deploy_graph.py --publish  # nodes, connections, report branch
```

`push_brain.py` owns node *contents*; `deploy_graph.py` owns the graph *shape*
and re-syncs `nodes/build_reports.js`. Both are idempotent — run either twice and
the second run is a no-op. Run `deploy_graph.py` first when both are pending.

The Brain is ~46 KB of JS, too large to pass through an MCP tool call, so the
script speaks JSON-RPC to the same endpoint and reads the file off disk. It also
syncs `ADMIN_USERS` / `CASHIER_USERS` into the Config node, rewriting the existing
assignments in place so `BOT_TOKEN` never passes through the script. Re-running it
is idempotent. n8n refuses the update while the workflow is open in a browser tab —
close it first.

The response includes five `INVALID_PARAMETER` warnings about `resource` on the
Telegram nodes. They predate this script and those nodes work; ignore them.

### Scheduled reports

`Report Schedule → Report Config → Read Report Formulas → Read Report Values →
Build Reports → Send Report` posts to the ops group (`REPORT_GROUP_CHAT_ID`):

- a **daily digest** — arrivals, departures, and open stays past 30 days — sent
  only when there is something in it;
- a **debt report** on Saturdays, every booking with المتبقي > 0 plus a total.

The range is read **twice** on purpose. Evaluated gives real numbers for المتبقي,
which is a sheet formula; FORMULA identifies open-ended stays, whose عدد الليالي
is a live `=TODAY()-J`. Without the second read an open stay reads as departing
today on every single day, and the digest would announce the same guest as
leaving for months. FORMULA alone cannot replace the first read either — المتبقي
and, on nightly-rate rows, اجمالي سعر الحجز come back as formula text.

> **One manual step:** the trigger fires at 08:00 in the **n8n instance's**
> timezone. The workflow has no timezone set and the MCP surface cannot set one,
> so change it in the UI (Workflow settings → Timezone → `Africa/Cairo`) if you
> want 08:00 local. Report *content* already uses Cairo dates regardless.

### 4. Fill in the Config node

Open the **Config** node. Everything is pre-filled from `config.py` except the
token:

| Key | Default |
|---|---|
| `BOT_TOKEN` | `PUT_YOUR_BOT_TOKEN_HERE` ← **set this** |
| `BOOKINGS_SHEET_ID` | `1CiHciOe…re84S8` |
| `BOOKINGS_TAB` | `إدخال الحجوزات` |
| `EXPENSE_TAB` | `مصروفات عامة` |
| `GROUP_CHAT_ID` | `-5001910339` |
| `EXPENSE_GROUP_CHAT_ID` | `-5072732996` |
| `ADMIN_USERS` | `7941350507,@AbdulrahmanMohamed5,1226903540,5793725130` |
| `CASHIER_USERS` | `@Seifgamal24,@seiiffseiif` |
| `TIMEZONE` | `Africa/Cairo` |

`ADMIN_USERS` and `CASHIER_USERS` replace the old `BOOKING_USER_IDS` /
`EXPENSE_USERNAMES` pair. Each is a comma-separated list of numeric Telegram user
ids **or** `@usernames` (matched case-insensitively). Anyone on neither list gets
`⛔ غير مصرح لك` for a command and silence for anything else — the bot is closed.

- **Admins** get the full menu: حجز / مصروف / تعديل حجز.
- **Cashiers** get مصروف / إضافة مبلغ مدفوع only. The payment path asks for the
  booking ID → the amount (added to what is already paid) → the payment method,
  and any method other than `كاش` requires a receipt photo with no skip. It then
  writes and posts to the group immediately — no field menu, no confirm step.

`brain.js` carries the same two lists as hard-coded defaults, so the bot keeps its
access rules even if the Config node still has the old keys. Change both together.

> The bot token sits in the workflow, not in a credential, because Telegram puts
> it in the URL path and n8n can't inject it there. Treat the workflow export as
> a secret — don't commit a filled-in copy.

### 5. Stop the Python bot, then activate

See **Cutover** below. Both cannot run at once.

## Cutover — stopping the Python bot

The Python bot uses **long polling** (`run_polling`); n8n uses a **webhook**.
Telegram allows only one, and `setWebhook` fails with `409 Conflict` while a
poller is live. So the Python bot must stop *first*.

On the server (`/home/ubuntu/bot`):

```bash
# 1. Stop it, and stop it coming back on reboot
sudo systemctl stop bookings-bot
sudo systemctl disable bookings-bot

# 2. Confirm nothing is left polling
systemctl status bookings-bot --no-pager
pgrep -af 'bot.py' || echo "clear"

# 3. Drop any stale webhook + queued updates
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/deleteWebhook?drop_pending_updates=true"
```

Then in n8n, toggle the workflow **Active**. That registers the webhook. Verify:

```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

You want to see your n8n URL in `"url"`, `"pending_update_count": 0`, and **no**
`last_error_message`. Then send `/start` to the bot and walk one booking through
to Save.

Leave the Python code in place until you've saved a real booking and confirmed
the row landed correctly and column P still shows its formula result.

### Rollback

```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/deleteWebhook?drop_pending_updates=true"
sudo systemctl enable --now bookings-bot
```

(Deactivate the n8n workflow first, or it will re-register the webhook.)

## Things to know before you rely on this

**Verify the row calculation before the first real save.** *Build Booking Row*
computes the target row as `<rows returned by the key-column read> + 2` (row 1 is
the header). The Python bot instead took `len(values) + 1` straight from the API,
where trailing blanks are trimmed. These agree **only if** the n8n Sheets node
returns one item per data row and does not drop interior blank rows. If it does
drop them, the computed row lands on top of an existing booking and overwrites it.
To check safely, open the workflow and execute **only** *Read Booking Key* — it is
read-only — then confirm `items + 1` equals the last filled row of column C.

**Session state lives in the `bookings_bot_sessions` data table** (id
`aUXgKa2avXl28s5W`), keyed by `chat_id`, written by *Save Session* and blanked by
*Clear Session*. This replaced `$getWorkflowStaticData`, which n8n only persists
for **production** executions — under it, any manual test lost its session between
turns and every button tap fell through to *No Action Needed*. Consequences now:

- Manual editor testing works, because the row is real storage.
- An ended session is stored as an **empty state**, not a deleted row, so one
  upsert node covers both cases and there is no delete branch to keep in sync.
- Sessions older than 12 h are ignored by `brain.js` (`SESSION_TTL_MS`). Rows are
  never garbage-collected; there is at most one per chat.

**Timestamp timezone.** The Python bot stamped expenses with the server's local
clock; this uses the `TIMEZONE` config value (`Africa/Cairo`). Set it to `UTC` if
your server clock was UTC and you want identical values.

**Option-list order is load-bearing.** `APARTMENTS`, `PAYMENTS`, `BTYPE_OPTS`,
and `EXP_PAYMENTS` are addressed by index in `callback_data`. Reordering them
mid-conversation would misfile an in-flight booking — append only.
