# Handoff — where the Supabase migration stands

Written 2026-08-09. Read this first in a new session, then
[`2026-08-08-supabase-migration-scope.md`](2026-08-08-supabase-migration-scope.md)
for the reasoning behind the plan.

## State: phases 0–3 done and live

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

## Two findings that change Phase 4

Both came out of running the reconcile against live data, which is exactly what
the trust period is for.

### 1. `sheet_row` is not a stable key

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

- **Phase 4, the flip.** Reads still come from Sheets, so the ~0.4–2 s
  mid-conversation wait is still there. Do not start this until the reconcile has
  been quiet for a while, and not before deciding the key question above.
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
