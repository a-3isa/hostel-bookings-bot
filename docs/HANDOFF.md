# Handoff — where the Supabase migration stands

## START HERE (2026-08-14)

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

**Still to do:** the bot does not write a suffix yet. When a payment in a second
method arrives, the mirror needs to ALLOCATE a new line — insert a row, give the
payment `line_seq = n` and `sheet_row`, and stamp `id-n`. Today a payment with no
`sheet_row` is simply skipped, so the money is right in Postgres and invisible in
the sheet until someone adds the row.

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

**Let the mirror allocate a line.** See section 0: the readers, the model and the
collapse are done, and what is missing is the writer. A payment in a second
method currently lands in `payments` with no `sheet_row` and is skipped by the
mirror, so it is right in Postgres and absent from the sheet.

Ahead of that on severity: **the bot still matches payments on `sheet_row`**, so
a row inserted between a bot write and the next reindex puts money on the wrong
guest. It has happened once. `payments.line_seq` and column U are now what fix
it — the supabase scripts use them, `brain.js` does not yet.


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
