# Handoff — where the Supabase migration stands

> **2026-10-12: the Supabase migration is over.** The bot no longer reads or writes
> Postgres; see the first entry. Everything below that talks about the mirror, the
> shadow write, the reconcile or `bot_sessions` is history.

## 2026-10-12 — the bot no longer uses Postgres

**LIVE since 2026-10-12 and exercised by a real message** (execution 7820: an AI edit,
"حجز عبد النبي دفع 2800 كاش" on row 42, confirmed; the row was written and the group posted).
Workflow `hzMYegbL3yifl7KN`, activeVersionId `8393b052-1a3c-48d5-82c1-0764290a9d41`
(first publish was `2cefc898…`, see "Found live" below), 67 nodes (was 72), no Postgres node,
live Brain byte-identical to `booking_bot/brain.js`.
**Rollback:** `restore_workflow_version` to `4555ef7a-38f1-4d4e-a1dc-f71038a6d6f8` (the
Postgres version that was live this morning), then `publish_workflow`. Spec:
`docs/superpowers/specs/2026-10-12-sheet-only-bot-design.md`; plan: `…/plans/2026-10-12-sheet-only-bot.md`.

**Why.** The admin edits the sheet by hand and never uses the dashboard, so the database
could not stay current, and the bot read it: a payment was written to the wrong guest's row
(the stored `sheet_row` was one off) and `paid = database paid + new payment` was written into
the sheet's cumulative cell from a stale number. The bot now reads the sheet in the turn it
writes it.

**What changed.**
- `Load/Save/Clear Session` are Data Table nodes on `bookings_bot_sessions`
  (`build_workflow.session_params`).
- `Read Bookings For Edit`, `Read Locations`, `Read Next Booking ID` (and the report and
  availability registries) are each an HTTP `values.get` of the Sheets API followed by a Code
  node (`nodes/build_bookings_lookup.js`, `build_locations.js`, `compute_next_booking_id.js`)
  that returns the rows `brain.js` always got. `booking_id` is now the sheet row.
- Removed: `Build Shadow Write`, `Shadow Write`, `Read Booking Id`, `Write Booking Id`,
  `Build Snapshot SQL`, `Write Snapshot`, `Read Discrepancies`, `Build Reconcile Message`,
  `Read Unmirrored Bookings`, `Append Mirror Row`, `Mark Mirrored`. So: a new booking's own row
  gets no `معرف النظام` any more, there is no 08:00 reconcile, and dashboard-born bookings are
  no longer appended to the sheet.
- **`Write Line Id` stays.** It stamps `<row>-<seq>` on a payment line, and
  `build_reports.js` drops rows whose column U looks like `n-n`; without it the reports list a
  guest twice.
- A *line* is the row directly under a booking with the same ID, name, apartment, room and
  arrival, a blank price, and its own paid/method. Anything else — the same guest on a later
  arrival, or the same identity after a gap — is its own booking (rows 37-39 are three).
- `Config` gains `AVAILABILITY_TAB`. Supabase, `supabase/` and `webui/` are untouched and
  marked retired.

**Proven before publish.** (1) A scratch workflow ran the real Data Table node (upsert, second
upsert updates the same row, an empty `state` persists, delete) and an HTTP node whose
credential was supplied inline (executions 7810, 7811). (2) A second scratch workflow ran the
*generated* session and lookup nodes in n8n's real runtime against the live tab (execution
7813): 56 bookings, 26 rooms, next ID 45, a session saved, read back, cleared and deleted;
identical to `python booking_bot/check_sheet_lookup.py`. (3) `deploy_graph.py --dry-run`
applied the migration to a copy of the live graph (87 operations, 72 → 67 nodes) and a second
run found only parameter refreshes. (4) The draft was read back from the server and compared
with the generator before publishing.

**Found live, on the first Confirm (execution 7820), and fixed.** The payment wrote correctly,
but `Save Session` ran AFTER `Clear Session` and put the finished session back to
`EDIT_CONFIRM` (with its `savingAt` lock), so an old Confirm card could have saved the same
payment again once the lock lapsed. Cause: retyping a node removes and re-adds it, and
`addConnection` only appends, so `Brain → Save Session` came back last in Brain's branch list
and `Send Saved → Clear Session` came back after the group post. n8n runs one output's branches
in the order they were connected. `sheet_only_ops` now restores the generator's order (live-only
branches such as the availability tap stay after it), tests pin it, and the graph was re-applied
and republished as `8393b052…`. The stale row for the admin chat was set to `''` / `{}` by hand.
**If you ever retype a node again, check `Brain`'s and `Send Saved`'s branch order afterwards.**

**Still worth doing.** One real payment *after* the fix, and look at that execution: `Save
Session` must run before `Send Reply`/the writers, and the session row must end `state ''`.

**Things that behave differently.**
- Conversations in progress at the switch lost their session (they lived in `bot_sessions`).
- The suggested booking ID is the highest plain number in column B + 1; starred carry-overs
  (`104**`) and anything over six digits are ignored. It restarts with the tab each month.
- A lookup is two Sheets API reads (about a second or two).
- The only remaining wrong-row window is a row inserted by hand between the lookup and the
  Confirm tap. A write-time guard (re-read the row's name before writing) would close it and
  was not built.

**Landmines.**
- The report and availability branches never run `Config`, so their fetches name the tab
  literally; `$('Config')` there throws "hasn't been executed".
- `setNodeCredential` still refuses `googleSheetsOAuth2Api` on an HTTP node, but an `addNode`
  that carries `credentials` binds it. That is how `deploy_graph.py` adds the fetch nodes.
- Data Table operation names: `get`, `upsert`, `deleteRows`.
- `validate_workflow.py` reports `Route Save routes None` on the LIVE graph: its rules have no
  `outputKey` there. That is the live node's shape, not a fault.
- `deploy_graph.py --dry-run` applies everything to a copy of the live graph and validates it
  without sending anything; use it before every structural deploy.
- Still for a person, unchanged: the nine orphan rows 3-11, and ID 27's two rows (38, 39) which
  share one old system id.

## 2026-10-12 — AI edit: type a change, review it, confirm it

**LIVE since 2026-10-12, but not yet exercised by a real Telegram message.**
Workflow `hzMYegbL3yifl7KN`, activeVersionId `4555ef7a-38f1-4d4e-a1dc-f71038a6d6f8`
(first publish was `f8bb6716…`; republished the same day for the registry-gate fix
below and again for finding a booking by name), 72 nodes, live Brain byte-identical to `booking_bot/brain.js`, Anthropic credential
`dObKg3UcZAYjhPLY` bound to `Anthropic Chat Model` (`claude-haiku-5-5` is in its
model list, so the key authenticates). What is left is the first real pass — see
the end of this entry. Spec: `docs/superpowers/specs/2026-10-12-ai-booking-edit-design.md`,
plan: `docs/superpowers/plans/2026-10-12-ai-booking-edit.md`.

Admins get a new menu button, 🤖 تعديل بالذكاء الاصطناعي (`choice_ai`). They type a
change to a saved booking in plain Arabic or English — "حجز 3 دفع 400 كاش",
"booking 12 to انبي 2 room 3 and extend 2 nights", "booking 7 left today" — and the
bot answers with the ordinary edit review card, prefixed with what it understood.
Nothing is written until **Confirm**, and Confirm is the unchanged `commitEdit`
path: same sheet write, Postgres mirror, group post and double-tap lock as the
manual edit menu. Covered: payments (including a second method on its own line,
foreign currency, refunds), changing the room, extending the stay, running it
until a date, and leaving.

**The model only parses.** An Information Extractor node (Anthropic Chat Model,
`claude-haiku-5-5`) sits in front of `Brain` and returns a small JSON request. It
has no tools, never writes, and never sees sheet rows, names or phones — only the
typed text, today's date, the apartment names and the payment-method keys.
`brain.js` re-validates every field (`readAiIntent`), looks the booking up in the
rows it already has, does the arithmetic, and draws the card. The schema and the
prompt live in `booking_bot/ai_intent.py` and nowhere else.

**The booking can be named by ID or by the guest's name.** With no ID the model fills
`guest_name` and `brain.js` (`findByName`) matches it against the rows it already has:
spaces, alef/ya/ta-marbuta variants and case are ignored ("عبد النبي" finds
"عبدالنبي"), the same name ranks first, then names that start with it, then names
that contain it, newest arrival first. One match goes straight to the card; several
open the `AI_PICK` picker (`ID · name · apartment/room · arrival`, ❌ on a cancelled
booking, at most 10 with a "showing the latest 10 of N" line); none says so. An ID
in the message always wins over a name.

**Landmines**

- **The edit lookup trusts stored row numbers, and they had drifted (found
  2026-10-12).** `read_bookings_for_edit.sql` gives Brain `bookings.sheet_row` and
  every write goes to that row. After the sheet was edited by hand (rows inserted
  near row 11 and extra lines under ID 27) and `reindex.py` was not run, 15 of the
  43 bookings pointed one row off. The first live AI Confirm ("pay 2800" for ID 30)
  therefore wrote to **row 41, which is ID 29**, setting its paid to 4210 and method
  to كاش and stamping system id 2344 into its column U, while ID 30 on row 42 stayed
  1410. The workflow reported success at every step because it did write a row.
  This is the HANDOFF's older warning ("a row inserted between a bot write and the
  next reindex puts money on the wrong guest") happening again, and the manual edit
  and add-payment flows are exposed in exactly the same way. Run
  `python supabase/reindex.py` (report) and `--apply` after any hand edit of the
  sheet, **before** using the bot on the affected bookings.
  *Repaired the same day.* Row 41 (ID 29) was put back to paid 504 / انستاباي /
  system id 2343 and row 42 (ID 30) set to paid 4210 (the +2800 that was meant),
  four cells in all, re-checked immediately before writing and read back after;
  then `reindex.py --apply` re-pointed 17 bookings and adopted two hand-typed rows
  (2 and 53, now bookings 2360 and 2361). A second `reindex.py` report shows re-point
  0, adopt 0, nothing in the database missing from the sheet. **Not yet run:**
  `backfill.py --reconcile` (the permission layer blocked it in that session).
  **Left for a person:** nine orphan ids in rows 3-11 (U says 36, 1017, 1098, 1099,
  1967, 2076, 2078, 2084, 1110 — no such booking) and ID 27's two hand-added lines
  (rows 38-39, U `2340-2` / `2340-3`) which the database has no payments for.
  The group chat also received a "payment 2800" message for ID 30 from the
  misdirected Confirm.
- `AI_TEXT` and `AI_PICK` must be in `BOOKING_STATES` and `LOCATION_STATES` in
  **both** `build_workflow.py` and `deploy_graph.py`; a test pins that they match.
- Room moves and stay changes warn about clashes (`findConflicts`, same strings as
  the new-booking flow); the manual edit menu still does not check at all.
- The clash text is computed on the turn that has the bookings loaded and carried
  in the session (`d.aiClashes`), because a receipt step can sit between that turn
  and the card.
- With no Anthropic credential on the instance, `deploy_graph.py` skips the AI
  branch and the Brain answers "unavailable" to the button by itself.
- **A gate that follows a lookup must read the session by name.** `Needs Locations?`
  read `$json.state`, but on the AI turns the item in front of it is a booking row
  with no `state`, so it said no, `Read Locations` never ran, and the extractor's
  prompt threw "Node 'Read Locations' hasn't been executed" (first live message,
  2026-10-12). The two state lists never overlapped before. It now uses
  `$('Load Session').first().json.state` (`state_conditions(..., from_session=True)`),
  and the prompt guards the apartment list with `.isExecuted`. A test pins both.
- **"AI unavailable" can mean billing, not code.** Brain shows that message for any
  failed model call. The reason is only in the execution: open `AI Extract` or the
  `Anthropic Chat Model` sub-node's error. On 2026-10-12 it was HTTP 400 "Your
  credit balance is too low" — the API account behind the n8n credential had no
  credit (a Claude subscription does not include API credit). Listing models
  (`explore_node_resources`) works without credit, so it does not prove the key can
  be used.
- Offline tests mock the model. `python booking_bot/eval_ai_intents.py` (needs
  `ANTHROPIC_API_KEY`) is the only check of how it reads real phrasing — add the
  phrases staff really type to `ai_eval_cases.json`.

**How it was deployed** (the worktree has no gitignored `booking_bot/.workflow_id`,
so the id went in as `N8N_WORKFLOW_ID=hzMYegbL3yifl7KN` on each run): the Anthropic
credential created in the n8n UI; `deploy_graph.py` and `push_brain.py` both
applied to the **draft** and checked against the repo (Brain byte-identical,
`Brain` has exactly two inbound edges, `AI Extract` and `Read Locations` carry
`executeOnce`, Config access lists and token untouched); then one
`publish_workflow`. The live graph before this had 69 nodes and no drift.

**First live pass — still to do, and it writes nothing:** `/start`, tap
🤖 تعديل بالذكاء الاصطناعي, send `booking <a real ID> paid 1 cash`, check the card
names the right guest, and tap **إلغاء**. Then open that run's `AI Extract` output
(`get_workflow_execution` with `includeData` and `nodeNames: ["AI Extract"]`) and
check it is `{ output: {...} }`. If the node errors instead, the first suspect is
the schema allowing no `null` for optional parts (see the PR's rulings).

## 2026-08-28 — no scheduled messages, غير مدفوع is not a method, and the DB was resynced from the sheet

**All of this is LIVE.** Workflow `hzMYegbL3yifl7KN`, activeVersionId
`7d4a9ece-be5f-4587-a27b-1d4315c2ea65`, 55 nodes, `active: true`, live Brain
byte-identical to `booking_bot/brain.js`.

**The 08:00 schedule posts nothing.** Asked for in two steps on the same day —
first "stop the daily updates" (digest + reconcile, keeping Saturday's debt
report), then, after it posted again the next morning because nothing had been
deployed yet, *"i dont want him to send any messages"*.

- **Both wires into `Send Report` are cut** — `Build Reports` and `Build
  Reconcile Message`. That is the switch: it does not matter what either Code
  node decides to emit.
- `Send Report` is **kept, unwired**. Reconnecting one input restores one report;
  deleting the node would take its Telegram credential binding with it, and
  rebinding is a UI-only step.
- The daily digest is switched off a second way, behind `SEND_DAILY_DIGEST` in
  `booking_bot/nodes/build_reports.js`. `test_reports.mjs` compiles a second copy
  of the source with the flag flipped, so it cannot rot while it is off.
- `Build Reconcile Message` still runs and **must keep returning exactly one
  item**: `Read Unmirrored Bookings` hangs off its output and that is what
  publishes dashboard-born bookings into the sheet. Making it return nothing on a
  clean morning would silently stop them appearing.
- Everything the schedule *does* is untouched: both reads, the snapshot,
  `reconcile_bookings`, the mirror append. Never silence it by deleting the
  trigger or the branch.
- Per-booking announcements are unaffected — `Post To Group`, different chats,
  fired by the Telegram trigger.
- `apply_offline` in `deploy_graph.py` learned `removeConnection`; it refused the
  verb before, so `--offline` could not have produced this graph.

**غير مدفوع is the absence of a payment, not a payment method.** A booking taken
unpaid and later paid in cash used to get a purple كاش line INSERTED under a row
that still announced غير مدفوع — two "methods", one of them a statement that
nothing had been paid, plus a row shift under every guest below it. Now the first
real payment lands on the booking's own row: the cell is relabelled and the
amount goes into اجمالي ما تم دفعه. A *second* method after that still opens a
line, exactly as before.

Three ports had to change together and they are twin-tested:

| where | what | tests |
|---|---|---|
| `booking_bot/brain.js` | `hasMethod()`, read by `paymentTarget()` | `test_brain.mjs` |
| `supabase/mirror.py` | `has_method()`, read by `plan_allocation()` | `supabase/test_lines.py` |
| `webui/lib/mirror.js` | `hasMethod()`, read by `planAllocation()` | `webui/lib/mirror.test.mjs` |

`webui/lib/publish.js` also had to widen its own adoption guard: it wrote
`coalesce(nullif(payment_method,''), …)`, which by definition refuses to touch a
cell reading غير مدفوع.

One consequence worth knowing, because it changes behaviour for bookings that
already exist in the OLD shape: adoption now happens only for a method no row of
the booking already carries. Own row `غير مدفوع` with a كاش line under it and a
new كاش payment → the payment joins that line and the cell above is left alone.
Relabelling it would have put كاش on both rows with the upper one holding
nothing, which is the duplicate `line_key` exists to prevent.

**Unrelated and pre-existing:** `booking_bot/test_shadow.mjs` throws at its
"payment lines" section (`put()` → `Cannot read properties of undefined`). It
fails identically on `HEAD` with none of this applied. Not investigated.

### The database was resynced from the sheet, and the sheet won everything

State before: **reconcile 12**, and the database had taken **no booking update
since 2026-08-22 19:52** — 101 bookings have `updated_at > created_at` and that
was the newest such timestamp. New bookings, new expenses and at-booking payments
kept landing through 08-26; it was the edit/payment path that produced nothing.

The cause underneath it: **18 bookings and 2 payment lines had a stale
`sheet_row`**, from hand-inserted rows shifting the tab. That is not cosmetic —
`build_shadow_write.js` writes an edit as `insert into bookings (sheet_row, …) on
conflict (sheet_row) do update`, so with drift an edit at sheet row 114 upserts
onto whichever DB row *claims* 114, a different guest. It had not fired yet (no
booking held a wrong name) but it was loaded. **`reindex.py --apply` is the
answer and it has to run before anything keyed on `sheet_row`.**

What ran, in this order — the order is load-bearing:

```
python supabase/backup.py --no-n8n        # backups/20260827T222509Z
python supabase/reindex.py   --apply      # column U -> sheet_row: 18 + 2 fixed
python supabase/backfill.py  --apply --reconcile
python supabase/sheet_sync.py --apply     # NEW, see below
```

`backfill.py` is an upsert and only an upsert: it can add and correct, never
remove, and it does not touch `payments` or `booking_lines` at all.
**`supabase/sheet_sync.py` is new** and finishes the job in the other direction —
the sheet is the reference, so what the database holds and the sheet does not
state is removed. It rebuilds `booking_lines` and `payments` from the sheet,
drops stay segments whose price formula no longer splits, and reports (but
refuses without `--force-bookings`) any booking stamped on no sheet row.

The user chose the destructive option for `payments` with the tradeoff stated:
the table was emptied and rebuilt from the sheet's paid cells, so **20
`receipt_file_id`s and every real `paid_at` are gone**. They are in
`backups/20260827T222509Z/database.json` if they are ever wanted back.
Rebuilt rows are `source = 'sheet'` with `paid_at` NULL, following
`seed_ledger.py`: the date money changed hands is the one thing the sheet never
records, and `now()` would be a lie that reads like a fact.

Result, verified live:

| check | before | after |
|---|---|---|
| `reconcile_bookings` | 12 | **0** |
| `reconcile_payments` | 0 | **0** |
| `reindex.py` re-points | 18 + 2 | **0** |
| sheet lines with no `booking_lines` row | 2 | **0** |
| `payments` sum ≠ `bookings.paid` | 0 | **0** |
| bookings in db, not in the sheet | 0 | **0** |
| rows | 117 / 120 / 8 / 59 | **117 / 121 / 10 / 59** |

Kept deliberately, at the user's choice: `bot_sessions` (live Telegram
conversation state), `booking_audit` (the dashboard's edit trail),
`sheet_snapshot` (scratch, rewritten every reconcile), `apartments` / `rooms` /
`settings` (registry from the الإتاحة tab — the bot cannot run without them).

**One real sheet inconsistency, left as the sheet has it:** row 36 (احمد باسط,
booking 32) shows 3,130 paid with طريقة الدفع still reading غير مدفوع.
`sheet_sync.py` warns about it on every run and records it verbatim rather than
guessing a method. Fixing it means editing the sheet.

---

## START HERE (2026-08-18) — everything in this repo is live

The workflow `hzMYegbL3yifl7KN` on `superfoxxy.dpdns.org` is **current**. The
endpoint is reachable, the MCP toggle is on, and both scripts run:

```
python booking_bot/sync_nodes.py --apply --publish   # graph + node settings
python booking_bot/push_brain.py  --publish          # brain.js
```

The TLS interception described further down comes and goes — a `handshake
operation timed out` on one attempt and a clean run minutes later, twice on
2026-08-18. Retry before concluding anything about tokens or access.

`sync_nodes.py --diff` reports seven nodes still differing and **every one of
them should be left alone**; they are catalogued under "What the diff turns up
that is NOT a bug" below. `Brain`, `Read Booking Key`, `Read Expense Key` and
`Has Group?` are no longer among them.

**`sync_nodes.py` compared only type and parameters until 2026-08-18**, so a fix
that changed a node SETTING was invisible to `--diff` and unreachable by
`--apply`. That is what hid the `Has Group?` double-post fix. It now compares
`executeOnce`, `onError`, `alwaysOutputData` and the retry keys, and pushes them
on their own with `setNodeSettings` rather than only alongside a type change.

The Vercel dashboard deploys from `webui/` on every push to master.

---

## The 2026-08-15 entry, superseded above

The bot is **running** in a rebuilt instance: workflow `hzMYegbL3yifl7KN` on
`superfoxxy.dpdns.org`, imported by hand, credentials bound, and taking real
bookings and expenses. The TLS interception that blocked the scripts is gone.

**The token was never the problem. The workflow id was.**

`g1Y3uMXgYnlJCvb8` — written into `booking_bot/.workflow_id` and repeated
through this document — is not a workflow id at all. It is the id of the
**personal project** that owns the workflow, which `list_credentials` reports as
the `homeProject` of all three credentials. `get_workflow_details` on a project
id answers "not found or you don't have permission", and that sentence was read
as an account problem for a day.

The token in `~/.claude.json` (ending `XUC1mstQ`) belongs to the owning account
and always did:

```
python booking_bot/push_brain.py --check   # with .workflow_id moved aside
  reachable:   https://superfoxxy.dpdns.org/mcp-server/http
  bearer:      yes, ending XUC1mstQ
  workflows:   1
    hzMYegbL3yifl7KN  Bookings Bot (Telegram - Google Sheets)  active=True
```

**What blocks the scripts now is one per-workflow flag.** The workflow reports
`availableInMCP: false`, and every MCP tool that names it refuses:

```
Workflow is not available in MCP. Enable MCP access from the workflow card in
the workflows list, or from the workflow settings.
```

That toggle is a click in the n8n UI and cannot be set through the API. Flip it
on `hzMYegbL3yifl7KN`, and `deploy_graph.py --publish` / `push_brain.py --publish`
can run. `.workflow_id` now holds the real id.

Note that `--check`'s probe cannot tell "wrong account" from "MCP disabled" —
both arrive as an `isError` from `get_workflow_details` and both print as
`no access to this workflow`. That is what made this take a day.

### Of the four fixes, only the row calculation is still missing

Read against the live workflow on 2026-08-15, node by node
(`sync_nodes.py --diff`). Three of the four are already in it — they were
applied by hand during the import and nobody wrote that down:

1. **The row calculation** (`313e101`) — **since applied.** It is live as of
   2026-08-18: `Read Booking Key` and `Read Expense Key` no longer appear in
   `sync_nodes.py --diff`. What follows is why it mattered.

   Originally recorded as: The bot writes over the LAST row of both tabs; an expense landed
   on row 19 of مصروفات عامة, on top of a hand-typed `غغ 99`, whose
   `الرقم ٩٩٩٩٩` survives only because column H is never written. Live still has
   `Read Booking Key` and `Read Expense Key` as `googleSheets` nodes reading
   `A2:J2000` / `A2:H2000`, and the two builders still take
   `max(row_number) + 1`. **It changes two node TYPES, so it cannot be applied
   by editing fields in the UI.**
2. **The receipt photo** (`aa4b36e`) — already live. `Post Receipt To Group`
   has `file`, not `photo`, and both group posters are on
   `continueRegularOutput`.
3. **Payment lines** (`653b449`) — already live. `Needs Row Insert?`,
   `Insert Payment Line` and `Build Line Rows` all match the repo exactly.
4. **Session in Postgres** (`2ea7855`, `22b26e6`) — already live. All three
   session nodes are `n8n-nodes-base.postgres` and Save-Session runs first.

Applying number 1: [`sync_nodes.py`](../booking_bot/sync_nodes.py), which pushes
named nodes from the generated file into the running workflow — including a type
change, which it does as remove + add + rewire, restoring the node's position,
its credential and `alwaysOutputData`.

```
python booking_bot/sync_nodes.py            # 14 operations, pushes nothing
python booking_bot/sync_nodes.py --apply --publish
```

Roll back from n8n's version history: the version before this is
`9490e20a-1483-4de7-849e-992df469f163`.

### What the diff turns up that is NOT a bug

Nine other nodes read as different and every one of them should be left alone.
Worth writing down, because each looks alarming:

- **`Config`** holds the real `BOT_TOKEN`, `BOOKINGS_SHEET_GID` (`2123885264`)
  and the true group chat ids. The committed file has placeholders in all of
  them. Pushing it takes the bot off the air.
- **`Write Booking Row` / `Write Booking Id`** carry a `columns.schema` n8n
  filled in from the live tab — 3,900 characters the generated file does not
  have and should not.
- **`Shadow Write`, `Write Snapshot`, `Read Booking Id`** appear to have lost
  the `=` that marks an expression, which would make each one execute its SQL as
  literal text. They have not: execution 263 shows `Shadow Write` succeeding and
  `Read Booking Id` returning `{"row_number": 77, "معرف النظام": "1016"}`. The
  MCP read simply does not echo the prefix for that field. Check an execution
  before believing this one.
- **`Answer Callback`** (`operation`), **`Route Save`** (`outputKey` labels),
  **`Report Schedule`** (`field: days`) and **`Post Receipt To Group`**
  (`resource`, `binaryData`, `appendAttribution`) differ only where n8n omits a
  value equal to the default.

`sync_nodes.py` keeps `Config`, `Brain` and the two Sheets writers out of any
default run for exactly these reasons; they sync only when named on the command
line.

### The database was resynced to the sheet on 2026-08-15

`reconcile: 0 discrepancies`, 75 bookings and 25 expenses, nothing in Postgres
that the sheet does not have. Getting there took `reindex.py --apply` (10
bookings re-pointed by column U — a row had been deleted by hand, shifting
booking 571 and everything below up one) and then `backfill.py --apply`, which
also brought in expenses 20–26 for the first time.

Four rows were deleted afterwards, none of them recoverable by the scripts and
all of them left by the broken row calculation or by testing:

- **booking 1015** — ابو الحسن, written twice by the bot (12:52 and 13:37) with
  different `client_ref`s. Identical guest, apartment, arrival, nights, total.
  Its payment 207 was the same 1,420 كاش as payment 209 on the survivor.
- **booking 570** — سامي, 3,890, whose row was deleted from the sheet by hand.
- **expense 236** — بيبيي, 3.00, a bot test at 13:41 on a row the sheet ends
  before.
- **`booking_lines` 4 + `payments` 210** — a 500 انستاباي payment line claiming
  `sheet_row = 81` when the sheet ends at 79. Confirmed as a test whose sheet
  row was deleted. This one is the row calculation writing into empty space, and
  it is the reason to deploy the fix before the next save.

**Still outstanding** (revised 2026-08-18 — two of the three are closed):

- ~~Row 19 of مصروفات عامة carries a stale `expense_ref`~~ — **fixed in the
  sheet by the user.** Column H is blank and the database reads NULL.
- ~~Three bookings whose `paid` exceeds the payments recorded for them~~ —
  **closed by `seed_ledger.py`**, which gave 26 bookings a placeholder payment
  for the difference between the sheet's paid cell and the ledger. `paid_at` is
  NULL on every one: the date is the thing the sheet never recorded and there
  is no honest way to guess it. They carry `client_ref = ledger-seed:<id>`.
- ~~Booking 32 احمد باسط, the one left~~ — **closed 2026-08-18.** Its ledger
  held two bot payments recorded two minutes apart on 2026-08-15: 3,130
  انستاباي at 17:44, which is exactly what the sheet says, and 2,000 فودافون
  كاش at 17:46, which nothing on the sheet accounts for. Neither carried a
  receipt. The user ruled the sheet right, so payment 212 was deleted. It is in
  `backups/20260818T203228Z/database.json` if that is ever revisited.

  **`reconcile_payments` is now empty for the first time.** The sheet's paid
  column and the payments ledger agree on every booking.
- The bot token is legible in a screenshot from 2026-08-15 — revoke and replace.
  **Still unverified.** A live Telegram token in a screenshot is a working
  credential for whoever has it; this is the most urgent line on this page.

## 2026-08-18 — the dashboard writes the sheet, and the money rule changed

**A payment in a new method no longer moves the booking's price.** The user
reversed that half of the 2026-08-14 rule. The booking's own row keeps the whole
agreed total; the LINE row leaves اجمالي سعر الحجز **blank** and carries only
its own paid amount. اجمالي ما تم دفعه is still split per row. Between them the
price column sums to the booking exactly once — the old arrangement made it read
3,800 for a 2,200 stay. The new row is also filled **purple**, because
`inheritFromBefore` copies the booking row's own formatting and a line was
otherwise indistinguishable from a guest.

Applied in all three writers, which now agree: `brain.js` (`commitPaymentLine`),
`supabase/mirror.py` (`primary_payload` / `line_payload`) and the new
`webui/lib/mirror.js`. `supabase/test_lines.py` and `webui/lib/mirror.test.mjs`
are twin suites over the same worked examples, which is what keeps the ports
from drifting.

**The dashboard publishes to the sheet on save.** It was Postgres-only;
`webui/lib/publish.js` now writes the booking or expense the user just touched,
allocates a payment to its line and opens a row when the method is new. It is
not a second mirror — one record, refuses anything its identity check does not
confirm, never throws — and `supabase/mirror.py` remains the reconciler.

**The group was told twice about every payment.** `Write Line Rows` emits one
item per row it wrote, and a payment line is two rows whenever the booking's own
row changed in the same save, so everything downstream ran twice. `Has Group?`
now carries `executeOnce`. `Write Line Id` had had that flag for the same reason
since 2026-08-15 and nobody generalised it.

**Deleting a booking left its payment rows behind in the sheet.**
`booking_lines` cascades when the booking goes, but the delete route only ever
removed the booking's OWN row — so مروان's 1,600 انستاباي line would have stayed
on the tab with nothing in the database describing it. It now takes every row
the booking occupies, proving each against column U, highest row first, and
renumbers all three tables that remember a row number rather than two.

**Row 18 of إدخال الحجوزات is حسام's second payment**, merged in by hand. It
carries a bare `16` rather than `16-2`, which read literally says booking 16
lives on row 18. `continuation_seq()` in `backfill.py` now recognises the shape —
money, no guest, no apartment, no room, and an id a named row above already
holds — so the sheet did not have to be edited to suit the database. The user
called it an exception that will not recur.

Not run: `mirror.py --apply`. It would convert مروان, محمد and احمد رمضان to the
new arrangement, and the user chose to leave them and update those prices by
hand. Note that the dashboard writes L from the database on every save, so a
hand-edited price holds until the next dashboard action on that booking —
`backfill.py --apply` after the edit is what makes both sides agree.

## The 2026-08-14 rebuild, for context

**The old n8n instance was destroyed and the workflow with it.** There was no
export anywhere and the repo could not rebuild it: `build_workflow.py` and
`bookings-bot.workflow.json` were named in the README but never committed, and
`deploy_graph.py` only creates the twenty nodes of its own branch.

**That is fixed. The graph is generated from source now** —
[`build_workflow.py`](../booking_bot/build_workflow.py), 33 nodes, committed
along with its output. Locally everything is green: `validate_workflow.py`,
`test_workflow.py` (10), `test_sheet_ids.py` (17), and brain/reports/shadow/
reconcile.

### What is left: import and publish

**By hand, with the network as it is: [`n8n-manual-import.md`](n8n-manual-import.md).**
Import [`bookings-bot.full.workflow.json`](../booking_bot/bookings-bot.full.workflow.json)
— 50 nodes, produced by `deploy_graph.py --offline`, which applies that script's
own operations to the file instead of the endpoint. The 33-node base file has no
Postgres write, no reports and no scheduled mirror; importing it alone gives half
a bot.

The scripted sequence below is what to use once the endpoint is reachable again:

```
python booking_bot/push_brain.py --check         # what this machine can reach
python booking_bot/build_workflow.py --creds     # 15 nodes need a credential
# import bookings-bot.workflow.json  (create_workflow_from_code)
echo <new-id> > booking_bot/.workflow_id         # git-ignored, per-instance
# bind credentials: telegramApi, googleSheetsOAuth2Api, postgres
# create data table `bookings_bot_sessions`:
#     chat_id (string), state (string), data (string), updated_at (number)
# fill Config.BOT_TOKEN            — empty on purpose, this repo is committed
# fill Config.BOOKINGS_SHEET_GID   — REQUIRED. It was described here as
#     optional until 2026-08-21, which was an instruction to create a fault:
#     `Insert Payment Line` fed it to Number(), and Number('') is 0 — a valid
#     gid, normally the workbook's FIRST tab. An unset value did not fail, it
#     inserted a row into the wrong tab. That node refuses a blank now, so a
#     fresh import can take payments only once this is filled in. Find it in
#     the sheet's URL (#gid=...).
python booking_bot/deploy_graph.py --publish     # its own 20 nodes on top
python booking_bot/push_brain.py   --publish     # brain.js + the Config lists
```

`--check` is the first thing to run: it reports the endpoint, the credential and
the workflows visible, and pushes nothing. Both scripts read the workflow id from
`N8N_WORKFLOW_ID` or `booking_bot/.workflow_id` and refuse to run without one, so
there is no hard-coded id pointing at the destroyed workflow any more. A server
registered by `claude mcp add` with no bearer is used as-is.

**Not yet verified against a running n8n:** the node *parameters*. The topology,
the node names and every JS body are pinned by `brain.js` and the test suites,
but the exact shapes for the Data Table nodes, the Switch, the Telegram
`sendPhoto`/callback answer and the Sheets-credentialed HTTP node were written
from the docs rather than read off a live instance. Expect one correction pass
on the first import; `validate_workflow.py` checks structure and contract, not
n8n field names.

**Also needed before a single message flows:** the new n8n must be on public
HTTPS with a certificate Telegram accepts, or the Telegram Trigger cannot
register its webhook.

### The network is still intercepted

`superfoxxy.dpdns.org` serves a certificate issued by a **FortiGate appliance**
(`O=Fortinet, CN=F2K61FTK22900232`), not by a public CA — a middlebox is
terminating the TLS. Every n8n call carries the bearer token, so nothing was
sent through it. Resolve by installing that CA if the appliance is the user's,
or by using a network path without it.

---

**Everything below the line still applies. These are the immediate steps.**

### 0. The U-suffix scheme is built and live. The n8n deploy is still blocked.

Done on 2026-08-14, in three commits:

- **Column U now carries `413`, `413-2`, `413-3`.** The base is the booking, the
  suffix is which of its sheet LINES this row is. `parse_sheet_id()` in
  `backfill.py` is the one answer to "what does this cell say", shared by every
  reader, because four scripts read column U and have to agree exactly.
- **A second payment is a line, not a booking.** `collapse_lines.py` was applied:
  مروان (2200), محمد (1200) and امير سيف الدين (690) are one booking each now,
  with `payments.line_seq` 1 and 2 and column U stamped. Bookings 22, 35 and 354
  are gone. `merged_into` is empty and the follower-row model is retired.
- **The mirror writes a line from its payment.** The booking's own row shows
  what is left once the other lines are taken out, so the sheet's lines sum back
  to exactly the total the database holds. Each line remembers what was written
  in `payments.mirror_payload`.
- **Row 18's `=(650*I18)-2200` is understood**, via `bookings.total_adjustment`.
  It had been one guaranteed false difference on every reconcile, growing by 650
  a day.

State, verified live after all of it: **reconcile 0**, reindex no drift, and the
mirror reproduces all 71 lines with **no writes and no conflicts**.

Four schema migrations were applied directly (`payments.line_seq`,
`payments.mirror_payload`, `sheet_snapshot.line_seq`,
`bookings.total_adjustment`), and `bookings_live`, `bookings_model`,
`reconcile_bookings`, `mixed_currency_bookings` and `reconcile_payments` were
recreated. `schema.sql` matches what is live.

**The mirror allocates lines now** (2026-08-14). A line is a payment TYPE, which
is the rule the user gave: a payment in a method the booking already has is
ADDED to that method's line and its cell grows; only a method not yet on the
booking opens a row; and a third payment is checked against every line that
exists by then. Method **and currency** must match — there are no exchange rates
here.

- **`booking_lines` is the new table.** `payments` could not hold this: it had
  `unique (booking_id, line_seq)` and `unique (sheet_row)`, so two cash payments
  sharing one line and one row were rejected by the database itself. Summing
  them into one payment row was the alternative and the user rejected it — each
  payment keeps its own date and its own receipt. Line 1 is deliberately NOT in
  the table; it is the booking's own row and `bookings` already describes it.
- **The new row is inserted directly under the booking's block**, with
  `inheritFromBefore` so K, N, P, R, S and T come down from the row above. Every
  row below moves down by one in the sheet and in all three tables that remember
  a row number — `bookings`, `payments`, `booking_lines`.
- **The dashboard no longer writes rows.** `addPayment` records the payment and
  stops; `insertPaymentRow` is gone. It was still building follower `bookings`
  rows, a model the collapse retired, and it inserted a row per payment, which
  is no longer the rule.
- First live run: 52 payments assigned to a line, **0 rows inserted**, sheet
  untouched, `reconcile_bookings` still 0. `supabase/test_lines.py` covers the
  grouping, the numbering and the insert (27 tests).

### 1. Nothing has been deployed since n8n went down

n8n is **back up**, and the problem is not the endpoint. As of 2026-08-14 the
scripts try **every** n8n credential in `~/.claude.json` against the workflow
itself and none can reach it:

```
no n8n credential in ~/.claude.json can reach workflow 2H97FsGnzwmzl7YE:
  token issued 1786699996, ending 7aimiYdU: no access to this workflow
  token issued 1785966523, ending 5rktsI7c: HTTP 401
  ...
```

The server named `n8n` **connects** and registers all 34 tools — it shows green
in `/mcp` — but its account holds **zero workflows**, so a green line there is
not evidence the deploy will work. The `n8n-mcp` entries are revoked outright.

What is needed is an MCP access token minted in the n8n account that **owns**
`2H97FsGnzwmzl7YE`, in any `mcpServers` entry whose name contains `n8n`;
`push_brain.select_server()` finds it wherever it is put. Then:

```
python booking_bot/deploy_graph.py --publish   # formula guard + mirror node fix
python booking_bot/push_brain.py   --publish   # half-saved payment + cancel zeroing
```

Four committed fixes are waiting on that, and one of them is urgent:

- **The deployed scheduled mirror still uses Sheets `append`**, which writes a
  full-width row and blanks every unmapped column — it would wipe N, P, R and S
  on whatever row it lands on. The fix (a targeted row update) is committed and
  unpublished. **Do not let a UI-created booking sit unpublished** once n8n is
  reachable: deploy first, then let the schedule run.
- The formula-column guard (K, N, P, R, S, T filtered in both row builders).
- The half-saved payment fix — a payment whose amount went missing is rebuilt
  rather than writing the method alone.
- Cancel now zeroes عدد الليالي and اجمالي سعر الحجز.

### 2. State is clean as of 2026-08-12

`reconcile: 0`, `reindex`: no drift, no orphans, nothing to adopt. Column U was
force-rewritten from the database mapping after a row insert left one stamp
stale (row 19 claimed 355, the database said 665).

Supabase MCP is **also gone** from the server list. `psycopg` through
`backfill.connect_args()` works and needs nothing.

### 3. Routine, in order, whenever the sheet has been edited by hand

```
python supabase/reindex.py --apply          # rows moved / new rows adopted
python supabase/backfill.py --apply --reconcile
python supabase/heal_formulas.py --apply    # restores N, P, S if any went blank
```

### 4. Next piece of work

**The bot still matches payments on `sheet_row`**, so a row inserted between a
bot write and the next reindex puts money on the wrong guest. It has happened
once. `payments.line_seq`, `booking_lines` and column U are now what fix it —
the supabase scripts use them, `brain.js` does not yet. The change is written
against `brain.js` and cannot ship until n8n is reachable.

**Not yet exercised on real data: the insert path.** Every live payment so far
has matched a method the booking already had, so the first run allocated 52
payments and inserted nothing. The insert is covered by tests against fakes —
rehearsing it on live bookings is the accident it exists to prevent — so watch
the first real second-method payment: run `mirror.py` (no `--apply`) first and
read the line it says it will open and the row it will insert.

Untouched, and still true: `reconcile_payments` lists 12 bookings whose paid
cell has no `payments` rows behind it at all. Those predate payment recording;
they are not a line-allocation problem.


Written 2026-08-09, updated the same day after Phase 4a. Read this first in a new
session, then
[`2026-08-08-supabase-migration-scope.md`](2026-08-08-supabase-migration-scope.md)
for the reasoning behind the plan.

## The key decision, settled

The user chose **option 1 — the mirror owns row allocation** (Postgres
authoritative, the mirror the sheet's only writer), and then asked the right
question about it: *what does someone do when they need to add a row by hand?*

So option 1 is taken **with option 2 alongside it**, which is what makes it
survivable:

- The two reasons anyone inserts a row today both get a real path. A second
  payment in a different method becomes a `payments` row (built, see below). A
  booking typed straight into the sheet gets **adopted** — the mirror imports
  rows it does not recognise instead of overwriting them.
- Adoption needs the mirror to tell its own rows from a human's, so the mirror
  also writes `bookings.id` into a spare sheet column. One visible column, and a
  hand-inserted row becomes recoverable rather than destructive.
- Protected ranges then guard the **formula** columns only (K, N, P, R, S, T),
  not the whole tab. People keep using the sheet.

## State: phases 0–3 done and live, 4a done

The bot is **active and unchanged in behaviour**. Supabase runs alongside it as a
shadow copy, and a daily reconcile reports whether the two agree.

| | |
|---|---|
| n8n workflow | `2H97FsGnzwmzl7YE`, active, **46 nodes**, 2 triggers |
| Supabase project | `bghkjpqhmnfdylvhkdhz`, eu-west-1 |
| Bookings loaded | 55 (was 46 at backfill; the sheet has grown since) |
| Last reconcile | `✅ مطابقة — 55 حجز، لا فروق` — verified live, message 4820 |
| Test suites | brain 379, reports 20, shadow 26, reconcile 24 — all green |

Deploy is two idempotent scripts. Run `deploy_graph.py` first when both are due:

```
python booking_bot/deploy_graph.py --publish   # graph shape + node code
python booking_bot/push_brain.py   --publish   # brain.js + the Config lists
```

Connecting to Postgres: use **`SUPABASE_TRANSACTION_URL`** from `.env`
(`aws-1-eu-west-1.pooler.supabase.com:6543`, user `postgres.<ref>`). The direct
host in `SUPABASE_DB_URL` publishes an **AAAA record only** and is unreachable
from an IPv4 network. `supabase/backfill.py:connect_args()` handles this and also
disables prepared statements, which transaction pooling cannot support.

## Phase 4a — payments, built and live

`payments` (booking_id, amount, method, receipt_file_id, paid_at, sheet_row) now
exists, backfilled to 45 rows, and the dual-write keeps it current. One row per
**sheet line**, keyed on `sheet_row`: the sheet holds a single cumulative paid
cell per line, so that is the most this can honestly record while the sheet is
authoritative. Individual payments get their own rows after the flip.

`bookings.merged_into` points a continuation line at the booking it continues.
The follower rows stay in `bookings` — deleting them would make the reconcile
shout "missing in db" every morning about a row that is deliberately gone.

Two new views:

- **`bookings_model`** — one row per real booking, follower lines folded in and
  their money summed, `sheet_rows` listing every line it occupies. This is what
  the bot reads after the flip. `bookings`/`bookings_live` stay shaped like the
  sheet, because that is what the reconcile compares against.
- **`reconcile_payments`** — where `payments` and the sheet's paid cells
  disagree. It earned its place within a minute of existing: it caught a live
  payment written two minutes after the backfill.

Both reconciles are at **0** against the live sheet.

## Three snapshot bugs found by running it, all fixed

The reconcile is only as good as the snapshot, and `backfill.py --reconcile`
disagreed with the n8n daily node about the same sheet in three ways. Every one
produced *false* differences, which is the failure mode that gets a report
ignored:

1. **Thousands separators.** A paid cell now reads `2,225.00`; passed to psycopg
   as a numeric parameter that is a hard error. `qnum` had the comma handling but
   only the SQL-building path went through it. Now `numeric()` does.
2. **Open-ended nights stored as NULL.** The script stored the *modelled* value;
   `sheet_snapshot` means "what the sheet shows", and `effective_nights`
   reproduces that number. All seven open stays reported as differing.
3. **`''` where the node writes NULL.** The reconcile compares with IS DISTINCT
   FROM, so row 9 (a guest with no apartment, room or arrival) differed from a
   database saying exactly the same thing.

The n8n node was right on all three; only the script was wrong. It also died
printing its own answer, because the console is cp1252 and every guest name is
Arabic.

## Phase 4b — the reads, LIVE and not yet exercised

**Read this before doing anything else in the next session.**

`Read Bookings For Edit` and `Read Locations` are now **Postgres nodes**, not
Sheets nodes. Published at 2026-08-09 ~10:05 UTC as active version
`7e8fec0a-0ca7-4a09-8dc5-d3faf04e5ab9`. The mid-conversation Sheets wait should
be gone.

**Rollback:** republish `9433c004-d110-4aba-a37c-5de0cb87abc7` (the 4a version,
Sheets reads intact) via `publish_workflow` with that `versionId`.

It was deliberately a **source swap, not a rewrite**. Both queries alias their
columns to the sheet's own Arabic headers, so `brain.js` is untouched and its 379
tests still describe the live code. Two decisions inside that are load-bearing:

- **`bookings_live`, not `bookings_model`.** The model folds a guest's
  continuation lines into one booking, which is right for a report and wrong for
  this node: it feeds the EDIT path, which writes back to a sheet row *by
  number*. Offering مروان as a single 2200 row would put his next payment on line
  22 while line 23 still held 1600, and the sheet would double-count. Line for
  line with the sheet, cancelled rows included, exactly as before.
- **`'=OPEN'` for an open-ended stay.** The Sheets read was in FORMULA mode, so
  open stays arrived as `=TODAY()-J5`, and both `findConflicts()` and
  `showValue()` key off that leading `=`. The sentinel keeps that contract.
  Phase 5 replaces it with the `open_ended` boolean and deletes the sniffing.

Both nodes are `alwaysOutputData: true` and `onError: continueRegularOutput`: an
empty result or a Supabase blip must not stop the branch before the Brain runs.

**Verified live:** execution 6273 ran the Postgres read in 422 ms, rows arriving
with the sheet's headers and the Brain consuming them unchanged.

That same execution turned up a bug with nothing to do with the migration: an
admin typed **٢٥**, the digits their keyboard actually produces, and the bot said
no booking has that ID. Guest 25 exists. `parseNum` was `parseFloat` and the ID
lookup was an exact string compare, so no amount or ID typed in Arabic-Indic
digits had ever matched. `asciiDigits()` in `brain.js` now folds the Arabic-Indic
and Persian ranges to ASCII in front of both.

`deploy_graph.py` no longer describes these as `googleSheets` nodes, and the
queries live in `booking_bot/nodes/*.sql`. It also used to re-pin *Read Locations*
to the الإتاحة range one section further down, which would have turned it back
into a Sheets read on the next deploy — that line is gone.

## Phase 4c — started: the sheet has a stable key

**Column U (`معرف النظام`) now carries each booking's database id**, written by
`supabase/write_sheet_ids.py`. U was chosen because the tab is 27 columns wide and
U–AA were verified empty first: nothing shifts, no formula moves, and the column
can be cleared with no loss. The script refuses to overwrite a non-empty cell that
disagrees with the database.

This is the half of the ownership decision that makes option 1 safe. With an id on
every row the mirror can tell its own rows from a human's, so a hand-inserted row
can be **adopted** rather than overwritten.

### Adoption works, and has already been used in anger

`supabase/reindex.py` is the maintenance pass. It met its own scenario within
minutes of being written: someone inserted a row at 18, shifting every row below.
Before column U that meant ~40 false differences in the next reconcile. Instead:
40 bookings re-pointed, the new row adopted as booking 355, its id written back
into U, reconcile 0.

    python supabase/reindex.py            # report only
    python supabase/reindex.py --apply    # re-point, adopt, write U

Three outcomes, deliberately not four:

- **re-point** — U says row 21 is booking 19 and the database says row 20, so the
  database is corrected. No comparing names and dates.
- **adopt** — a row with no id was never seen: typed by hand, or appended by the
  bot. Inserted, and its id written back to U.
- **orphan** — an id no booking has. Reported, never acted on: it means a row was
  copied, and which copy is real is a question for a person.

Rows the database has but the sheet does not are only counted, because "deleted"
and "moved past the range we read" look identical from here.

Payments move by their **old row**, not by their booking: a payment's `sheet_row`
is the line it was recorded on, and a booking with a continuation line has two.
Both moves are two-phase through negative row numbers so a swap cannot collide
with itself half way through.

**Run `reindex.py` before trusting a reconcile that reports many differences.** A
wall of them almost certainly means rows moved, not that anything is wrong.

### The bot stamps its own id now

*Read Booking Id* → *Write Booking Id* hang off the shadow branch: the branch
reads back the id it just wrote and puts it in column U. First write that runs
Postgres → sheet, and the seed of the mirror.

The flow test is inside the SQL rather than costing an IF node — the expression
renders to `and true` or `and false`, and `and false` returns no rows, which
stops the branch before the Sheets write. Not a trick for its own sake:
**expenses are on a different tab and their `sheet_row` numbering overlaps the
bookings tab's**, so a booking id written onto the expenses sheet would silently
corrupt someone else's row 5. Both nodes continue on error; the ✅ went out long
before this runs, and a blank U is what `reindex.py` repairs.

**Not yet exercised** — the bot has been idle since 11:33. First booking or edit
after this should leave an id in U; if it does not, check those two nodes.

### The reconcile no longer keys on the row

`sheet_snapshot.booking_id` carries column U, and `reconcile_bookings` matches on
the booking, falling back to `sheet_row` only for rows nobody has stamped yet.
Verified by moving every snapshot row down one — **0 differences, where the old
keying gave 40**. Both report reads widened A:T → A:U to carry the column, and
`backfill.py` reads A:U for the same reason.

This retires the finding that has been at the top of this document since Phase 3.

**Still to do for 4c:** the mirror itself — Postgres written first, then the
sheet's input columns A–J, L, M, O, Q. That is the go/no-go.

## Money can be in more than one currency

Found 2026-08-09 by folding امير سيف الدين's two lines together: row 44 is **40
دولار**, row 57 is **650 كاش**, and the model reported `total 690, remaining 0`.
690 is not an amount of anything.

The sheet has no currency column — طريقة الدفع carries it — and دولار and يورو are
both on the bot's payment keyboard, so this recurs. `payments.currency` is derived
from the method, `bookings_model` exposes `currencies` and `mixed_currency`, and
`mixed_currency_bookings` lists the affected bookings. One today.

**No exchange rate anywhere, deliberately.** Converting needs a rate, a date and
someone's authority; inventing one to make a column add up produces a number
nobody can audit. Any report that totals money must consult `mixed_currency`.

## Two findings that change Phase 4

Both came out of running the reconcile against live data, which is exactly what
the trust period is for.

### 1. `sheet_row` is not a stable key — SOLVED, kept for the reasoning

The first live reconcile reported 26 differences. Nothing was broken: the user
had **inserted a row**, which renumbered every row beneath it, so the shadow copy
was attached to the wrong bookings from that point down.

`sheet_row` is fine as an idempotency key *within* a write, and it is what the
dual-write and the backfill both use today. It cannot survive to the flip. A
re-run of `backfill.py --apply` re-syncs after any insert, and that is the
current workaround — but it means **the reconcile will show a wall of false
differences after every row insertion** until someone re-runs it.

Options for the flip, in rough order of preference:

1. Write a stable booking id into a spare sheet column and key on that.
2. Match on a natural key (guest_ref + arrival + room), accepting that three
   rows have no guest_ref and two guest_refs repeat.
3. Keep `sheet_row` but have the mirror own row allocation entirely, so nobody
   inserts rows by hand any more. This is where option 1 of the scope document
   was already heading.

### 2. Extra rows are how the sheet records extra payments

The inserted row was **not** a new booking. The user's words: *"I inserted a row
because محمد سعيد paid a new payment but it wasn't the same payment type as the
one before."*

The sheet has one payment-method column, so a second payment in a different
method needs a second row. Confirmed in the live data — one stay, two rows:

| guest | room | arrival | rows | methods | paid |
|---|---|---|---|---|---|
| محمد | ابو حديد 11 / 4 | 2026-08-02 | 35, 36 | انستاباي, كاش | 1200 |
| مروان | انبي 3 / 1 | 2026-08-02 | 22, 23 | كاش, انستاباي | 2200 |

So those are not duplicates to be cleaned up — they are one booking with two
payments. **Phase 4 needs a `payments` child table** (booking_id, amount, method,
receipt_file_id, paid_at), the same shape as `booking_stays`, and `bookings.paid`
becomes its sum. That also removes the reason anyone inserts rows, which quietly
fixes finding 1 as well.

This is the second time the sheet's single-value-per-column limit has been found
hiding a real one-to-many: `booking_stays` exists because a guest changed rooms
mid-stay and the two nightly rates ended up inside a hand-typed formula.

## What is not done

- **Phase 4b, the reads.** Reads still come from Sheets, so the ~0.4–2 s
  mid-conversation wait is still there. Availability, lookup and the registry
  move to `bookings_model` and the `rooms`/`apartments` tables.
- **Phase 4c, the mirror and adoption.** Postgres becomes the writer; the mirror
  writes A–J, L, M, O, Q plus the booking-id column, and adopts rows it does not
  recognise. This is the go/no-go point.
- **Phase 4d, protected ranges** on the formula columns. A click in Sheets, not
  code.
- **Phase 5**, deleting the workarounds (`filled + 2`, the two-read trick in the
  reports, the الإتاحة scrape, the undo pre-image).
- **The report schedule fires at 08:00 in the n8n instance's timezone**, not
  Cairo. The workflow has no `settings.timezone` and no MCP operation sets one —
  it needs a click in the n8n UI. Report *content* already uses Cairo dates.
- **Supabase MCP is configured but was never available in this session.**
  `.mcp.json` now points at `https://mcp.supabase.com/mcp?project_ref=…` (no
  token in the URL — it authenticates over OAuth on first connect). MCP servers
  only attach at Claude Code **startup**, so it will appear in the next session,
  not the one that added it. Everything so far went through `psycopg` over the
  pooler, which works and is still the fallback if the MCP is unavailable or
  read-only.

## Landmines

- `addNode` **does not carry node-level settings**. `executeOnce` and
  `alwaysOutputData` both had to be pinned with separate `setNodeSettings` ops,
  and both failed silently first. `alwaysOutputData` on *Read Discrepancies* is
  load-bearing: agreement returns zero rows, and without it the branch stops and
  the all-clear is never posted — a report that only appears on trouble cannot be
  told apart from a dead one.
- **Escape Markdown literals, not just values.** A send failed with a 400 because
  the message ended with the literal `reconcile_bookings`; the underscore opened
  an entity Telegram never saw closed. Every dynamic value was already escaped.
- `create table if not exists` does nothing to an existing table, so every new
  column also needs an `alter table ... add column if not exists` line in
  `schema.sql`. Views that `select b.*` must be dropped and recreated, not
  replaced.
- The shadow write must never fail a booking. It hangs off *Clear Session* in
  parallel, and its Postgres node is `onError: continueRegularOutput`.
