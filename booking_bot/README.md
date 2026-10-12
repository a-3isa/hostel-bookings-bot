# Bookings bot on n8n

A full port of the live Python bot (`/start` → booking flow or expense flow) to a
single n8n workflow. Same Arabic prompts, same keyboards, same sheet columns —
and **column P (المتبقي) is written as the sheet's own formula**, never as a
number, so it keeps tracking L − M as payments land.

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
| `test_brain.mjs` | Offline assertions driving every flow end to end (600+). |
| `ai_intent.py` | The AI edit's model contract: JSON schema, prompt, model id. |
| `eval_ai_intents.py`, `ai_eval_cases.json` | Live check of that prompt against real phrasing (needs `ANTHROPIC_API_KEY`). |

Edit the `.js` files, then:

```bash
node booking_bot/test_brain.mjs        # the state machine, offline
python booking_bot/push_brain.py       # deploy (see below)
```

## AI edit

Admins get a 🤖 button that takes a change to a saved booking in plain words and
shows what it would do before anything is written. Three nodes sit in front of
`Brain`:

```
… -> Needs Expense Number? / Read Expense Numbers -> Needs AI? -> AI Extract -> Brain
                                                          \-------------------^   (every other turn)
Anthropic Chat Model --ai_languageModel--> AI Extract
```

`Needs AI?` is true for a text message that is not a `/command`, while the session
is in `AI_TEXT`. `AI Extract` is an Information Extractor with an Anthropic Chat
Model sub-node; it returns a small JSON request (`ai_intent.SCHEMA`) and nothing
else — no tools, no writes. `brain.js` checks every field (`readAiIntent`), finds the
booking in the rows it already loaded, applies the change through the same setters
the edit menu uses, and draws the usual `EDIT_CONFIRM` card. **Confirm** is the
unchanged `commitEdit` path.

- The booking is named by its **ID or by the guest's name**. A name is matched in
  `brain.js` (spaces, alef/ya/ta-marbuta variants and case ignored; "عبد النبي" finds
  "عبدالنبي"); one match goes straight to the card, several open a picker (ID, name,
  room, arrival, ❌ if cancelled; at most 10, newest first), none says so.
- The schema and prompt live in `ai_intent.py`; `test_ai_intent.py` keeps its payment
  keys equal to `brain.js`'s.
- `AI_TEXT` and `AI_PICK` are in `BOOKING_STATES` and `LOCATION_STATES` in both
  `build_workflow.py` and `deploy_graph.py`.
- It needs an **Anthropic** credential in n8n, created in the UI (it cannot be made
  over MCP). Until one exists `deploy_graph.py` skips the branch and the Brain tells
  the admin the AI is unavailable.
- `ANTHROPIC_API_KEY=… python booking_bot/eval_ai_intents.py` asks the real API to
  read the phrases in `ai_eval_cases.json`; add the ones your staff actually type.

## Deployed instance

The live bot moved hosts. As of 2026-09-21 it is on
`https://n8n-fv0b.srv1982020.hstgr.cloud`:

- Workflow: **Bookings Bot (Telegram - Google Sheets)** — id `hzMYegbL3yifl7KN`
- <https://n8n-fv0b.srv1982020.hstgr.cloud/workflow/hzMYegbL3yifl7KN>
- Status: **published and active**, 55 nodes, 2 triggers (Telegram + the 08:00
  Report Schedule).

`superfoxxy.dpdns.org` (workflow `2H97FsGnzwmzl7YE`) is the old host and answers
HTTP 530 — its Cloudflare tunnel is down.

> **Where the bearer comes from.** `~/.claude.json` holds the MCP server URL but
> no credential: Claude Code signs in over OAuth and keeps the token in
> `~/.claude/.credentials.json` instead. That split is why both scripts answered
> HTTP 401 for most of 2026-09-21 while the Claude session was talking to the
> same endpoint perfectly happily.
>
> Since then `push_brain.py` reads that store itself — see `claude_code_token()`
> — so on a machine running Claude Code both scripts just work:
>
> ```bash
> python booking_bot/push_brain.py --check      # reachable + workflows listed
> python booking_bot/push_brain.py --publish
> python booking_bot/deploy_graph.py --publish
> ```
>
> The token lives one hour and Claude Code refreshes it in place. An expired one
> is skipped with a note rather than sent — "JWT Verification Failed" reads
> exactly like a wrong account and cost an hour of looking in the wrong place.
> To refresh it, make any n8n call in Claude Code and re-run. The script
> deliberately does **not** spend the refresh token itself: it rotates, and
> using it would log the session out of its own server.
>
> Elsewhere, set `N8N_MCP_TOKEN` (and `N8N_MCP_URL` if the host is not
> registered at all) in the environment or `.env` — see `env_override()`. A
> token fills in for every registered server that has none.
>
> Everything except `brain.js` can also go over the **MCP tools in the Claude
> session** directly: `update_workflow` with `updateNodeParameters` per node,
> then `publish_workflow`. `brain.js` cannot — at 102 KB it does not fit in a
> tool call, which is why `push_brain.py` reads it off disk in the first place.
>
> Note also that the live graph had drifted about four weeks behind this repo —
> `Brain` alone was 8.8 KB short, 52 hunks, +305/−180 lines. All twelve node
> bodies were brought back in line on 2026-09-21 and verified byte-identical
> against `brain.js` and `nodes/`, and the Config access lists went from the
> username form to the numeric ids. Do not assume it stays that way: diff before
> you push.

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
formulas in **K, N, R, S and T** survive. `append` would write empty strings into
those cells and destroy them.

**P (المتبقي) is the one exception, and only in who supplies the formula.** A
value is still never written there. Since 2026-09-21 *Build Booking Row* writes
the sheet's own `=IF(C{r}="","",IFERROR(L{r}-M{r},""))`, aimed at the row being
created. It used to rely on the tab's fill-down, and a fill-down only reaches as
far as somebody once dragged it — measured that day it stopped at row 89 with the
last booking on row 88, so the *second* new booking would have got a permanently
blank P. N, R, S and T still depend on the fill-down and still need
`supabase/heal_formulas.py`; only P was asked for.

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

`Report Schedule → Report Config → Read Report Locations → Read Report Formulas
→ Read Report Values → Build Reports → Send Report` runs every morning and **posts
two messages** to `REPORT_GROUP_CHAT_ID` (`-5057362381`).

🏠 *تقرير الإتاحة* — **every room in the building**, apartment by apartment, in
registry order:

```
*ذاكر حسين*
  • 1 — متاحه
  • 5 — عمرو عبدالبديع (19/09 ← 22/09)
```

A room either carries its guest — bare room number, name, then arrival and
departure as day/month, `مفتوح` for an open-ended stay — or reads `متاحه`. No
year, no "منذ", no "غرفة" (user, 2026-09-21). The occupied/empty split this
replaced made you subtract two lists in your head to answer the only question
the report is ever asked: is there a bed in انبي 2 tonight.

- The room list comes from the registry: `Read Report Locations`, the same
  `read_locations.sql` the Telegram branch runs, wired at the head of the chain
  so it costs one query rather than one per row. A guest in a room — or a whole
  apartment — the registry does not list is **appended** rather than dropped.
  If the registry cannot be read at all (the node errors, or an older deploy
  does not carry it) the report falls back to the occupied rooms only, under a
  `🏠 الغرف المشغولة (n غرفة / g نزيل)` heading; it never calls a room متاحه on
  a guess.
- A guest whose تاريخ المغادرة is *today* frees their room on this list, and
  appears below under 🛫 **مغادرة اليوم** — whoever leaves today, `• <اسم> —
  <شقة> · <غرفة>`. An open-ended stay is never a departure: its تاريخ المغادرة
  evaluates to today on every date it is read, which is what the second FORMULA
  read exists to detect.
- One room can hold more than one guest — a family books a bed each — and each
  gets their own line, since their dates can differ.

💰 *تقرير المديونيات* — 💰 **العملاء المدينون**: every booking with المتبقي > 0,
biggest first, as `• <اسم> — <شقة>: <مبلغ>`. No room number, no "متبقي" on the
line and no total under it (user, 2026-09-21) — the list is what gets acted on,
guest by guest.

Asked for on 2026-09-21 as one message in three sections, then split into two
the same day — rooms and money get read by different people — and the
availability half reshaped room-by-room the same evening. The Saturday-only debt
report it replaced is the second message now. **Both are
sent even when empty** — a report that only shows up when there is news cannot
be told apart from a branch that has stopped running, which is exactly what
happened to this one between 2026-08-28 and 2026-09-21. Either message is split
across several sends rather than failing Telegram's 4,096-character limit.

Both sheet reads carry `executeOnce`. `Read Report Values` always did; `Read
Report Formulas` needs it too now that 26 registry rows arrive at its input, or
it would re-read the whole tab once per room.

Two things stay off:

- the old **☀️ daily digest** — arrivals and open stays past 30 days — behind
  `SEND_DAILY_DIGEST` at the top of `nodes/build_reports.js`, where the user put
  it on 2026-08-28. `test_reports.mjs` still exercises it by compiling a copy of
  the source with the flag flipped. Its departures section duplicates the
  availability report's, so turning it back on announces departures twice.
- the **daily reconcile message**. `Build Reconcile Message` still runs and must
  keep returning one item — `Read Unmirrored Bookings` hangs off its output, and
  that is what publishes dashboard-born bookings into the sheet — but its wire
  into `Send Report` stays cut.

> **The live instance had silenced this branch a different way: every node in it
> was *disabled*, so the 08:00 trigger never even registered** (`triggerCount`
> was 1, and there is not one scheduled execution in the history). Re-enabled on
> 2026-09-21. Cutting `Build Reconcile Message → Send Report` was required rather
> than tidy: a disabled node forwards its input downstream, so with that wire in
> place the disabled reconcile chain would have pushed raw sheet rows into
> `Send Report`.

The branch stays wired end to end because it carries the day's real work — the
sheet reads, the snapshot, `reconcile_bookings`, and the mirror append. Never
silence it by deleting the trigger or the branch. See `docs/HANDOFF.md`.

Per-booking announcements are a different thing and are unaffected: `Post To
Group`, a different chat, fired by the Telegram trigger.

The range is read **twice** on purpose. Evaluated gives real numbers for المتبقي,
which is a sheet formula; FORMULA identifies open-ended stays, whose عدد الليالي
is a live `=TODAY()-J`. Without the second read an open stay reads as departing
today on every single day, and the digest would announce the same guest as
leaving for months. FORMULA alone cannot replace the first read either — المتبقي
and, on nightly-rate rows, اجمالي سعر الحجز come back as formula text.

Both stay wired regardless of what is being sent: `Read Report Values` runs
*after* the formula read, and it is what the snapshot, the reconcile and the
mirror append all hang off.

The trigger fires at 08:00 in the **workflow's** timezone, which is pinned to
`Africa/Cairo` as of 2026-09-21 — so 08:00 means 08:00 local. It used to be
unset, and therefore the n8n instance's, and this was a manual UI step because
the MCP surface could not set one; it can now
(`setWorkflowSettings` → `{"timezone": "Africa/Cairo"}`). Report *content* has
always used Cairo dates regardless of the trigger.

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
| `ADMIN_USERS` | `7941350507,627334825,1226903540,5793725130` |
| `CASHIER_USERS` | `1430533008,5213695300` |
| `TIMEZONE` | `Africa/Cairo` |

`ADMIN_USERS` and `CASHIER_USERS` replace the old `BOOKING_USER_IDS` /
`EXPENSE_USERNAMES` pair. Each is a comma-separated list of numeric Telegram user
ids **or** `@usernames` (matched case-insensitively). Anyone on neither list gets
`⛔ غير مصرح لك` for a command and silence for anything else — the bot is closed.

- **Admins** get the full menu: حجز / مصروف / تعديل حجز.
- **Cashiers** get مصروف / إضافة مبلغ مدفوع only. The payment path asks for the
  booking ID → the amount → the payment method → a receipt → a review card.
  - The amount prompt shows what the whole booking has paid (its row and every
    line, in pounds) against the price, and the remainder. يورو / دولار are
    listed apart and never taken off the remainder.
  - The amount is added to what is already paid. `0` is refused; a negative
    amount (refund) is admin-only.
  - غير مدفوع is not offered as the method of a payment.
  - انستاباي and فودافون كاش need a receipt: a photo, or an image/PDF sent as
    a file. A cashier cannot skip it; an admin can. Other methods need none.
  - A payment in يورو / دولار is in that currency and always goes on a line of
    its own, even on a booking that was never paid.
  - The review card (✅ حفظ / ❌ إلغاء) shows the guest, the amount, the method
    and the totals after the payment, and warns when pounds paid would exceed
    the price. Nothing is written until ✅ حفظ.
  - An admin taking the same shortcut gets the same card; an admin paying
    through تعديل حجز gets the warning on the usual review screen.

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
