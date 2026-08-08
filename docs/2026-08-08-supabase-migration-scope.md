# Moving the bookings bot to Supabase — scope

Written 2026-08-08, after measuring the live system rather than guessing at it.
Nothing here is built yet.

## The short version

Worth doing. It removes the last data-loss bug, deletes three separate pieces of
machinery that only exist to work around the spreadsheet, and takes the
mid-conversation wait from ~0.4–2 s to single-digit milliseconds.

It is **not** a swap. The spreadsheet has to keep working, and one finding below
means a naive one-way mirror would destroy real work. Plan for a sync with a
narrow, well-defined ownership rule, not a replacement.

## What the measurements say

| Fact | Measured | Why it matters |
|---|---|---|
| `Read Report Formulas` (A:T) | **1916 ms** | every scheduled run |
| `Read Report Values` (A:T) | **446 ms** | every scheduled run |
| Availability read (A:T, ~989 rows) | ~0.4–2 s | **blocks a receptionist mid-booking** |
| Bookings | 46 rows | migration is trivial |
| Expenses | 9 rows | migration is trivial |
| Formulas in other tabs pointing at the two bot tabs | **1,606** across **9 tabs** | the sheet cannot be retired |
| Rows with **hand-entered formulas in bot columns** | **6 of 46** | see the hard part |

The 1,606 breaks down as: `أرقام العملاء` 860, `الإتاحة` 624, `Dashboard` 94, and
8 each in the seven per-property tabs.

## The hard part, stated plainly

People edit the bot's own columns by hand, and they use formulas to do it:

- `اجمالي سعر الحجز` (L) holds `=500*I10` on 5 rows — "500 per night, however many
  nights this turns out to be". On an open-ended stay that is a *live* number.
- `اجمالي ما تم دفعه` (M) holds `=2000+225` on 2 rows — someone recording two
  payments without losing the arithmetic.

A one-way mirror from Postgres to Sheets would overwrite both with whatever
scalar the database happens to hold, and the "500 per night" intent would be
silently lost the first time the mirror ran. **This is the thing that would make
the migration a net loss if it were missed.**

Three honest options:

1. **Postgres owns the bot's columns; the sheet becomes read-only for them.**
   Protect the ranges, and move "500 per night" into the database as a
   `nightly_rate` column so the intent is expressed rather than typed. Cleanest
   end state, and it is a change to how people work — they must agree to it.
2. **Two-way sync.** Reconcile edits in both directions. Sounds accommodating,
   is a trap: no reliable conflict rule exists when both sides can change the
   same cell, and the failure mode is silent divergence.
3. **Postgres owns only what people never touch by hand.** Bookings identity and
   dates move; money columns stay sheet-owned. Half the benefit, none of the
   argument. A reasonable staging post, not an end state.

**Chosen: option 1** — Postgres will own the bot's columns, with `nightly_rate`
modelled properly so nobody needs to type a formula to express it.

**With a dual-write trust period first.** The bot keeps writing the spreadsheet
exactly as it does today, and additionally writes Postgres. Sheets stays
authoritative for as long as the user wants; Postgres is a shadow copy that gets
compared against it daily until it has earned the flip. Nothing about how the
team works changes until the flip, and the ownership rule above only takes effect
then. See *Phases*.

## Schema sketch

```sql
create table apartments (
  id          serial primary key,
  name        text not null unique,
  active      boolean not null default true
);

create table rooms (
  id            serial primary key,
  apartment_id  int not null references apartments(id),
  number        text not null,
  unique (apartment_id, number)
);

create table bookings (
  id             bigserial primary key,
  booking_ref    text,                       -- بوكنج ID
  guest_ref      text not null,              -- ID
  guest_name     text not null,
  booking_type   text not null,              -- خارجي | بوكينج
  phone          text,
  room_id        int not null references rooms(id),
  arrival        date not null,
  nights         int,                        -- NULL = open-ended stay
  nightly_rate   numeric,                    -- replaces the hand-typed =500*I
  total          numeric,
  paid           numeric not null default 0,
  payment_method text,
  notes          text,
  cancelled_at   timestamptz,
  created_by     text,
  created_at     timestamptz not null default now(),
  sheet_row      int,                        -- mirror bookkeeping

  departure date generated always as
    (case when nights is null then null else arrival + nights end) stored,
  remaining numeric generated always as
    (coalesce(total, 0) - paid) stored
);
```

Everything the sheet computes with a formula becomes either a generated column or
a view. `عدد الليالي` stops being `=TODAY()-J{row}`: an open stay is simply
`nights IS NULL`, which is the single change that deletes the most bot code.

Double booking stops being a warning and becomes impossible:

```sql
alter table bookings add constraint no_double_booking
  exclude using gist (
    room_id with =,
    daterange(arrival, coalesce(departure, 'infinity'::date), '[)') with &&
  ) where (cancelled_at is null);
```

Also worth having: `sessions` (replacing the n8n data table) and `booking_audit`
(replacing the undo pre-image parked on the session row).

## What gets deleted

This is the real return, more than the milliseconds:

- **The `filled + 2` row calculation** and the two key-column reads. Verified
  correct today, but only because column C happens to be contiguous — it is one
  manual row deletion away from silently overwriting a live booking.
- **The concurrent-write race**, which cannot be fixed inside Sheets. `append` is
  not available as a fix: the formula columns are filled down past row 990, so
  Google would treat the table as extending that far and append at ~991. After
  the migration the mirror is the sheet's *only* writer, so the race stops
  existing rather than being mitigated.
- **The two-read trick in the reports branch.** It exists solely because
  `عدد الليالي` is a formula whose evaluated value is indistinguishable from a
  real checkout. `nights IS NULL` replaces ~40 lines and one Sheets call a day.
- **`FALLBACK_REGISTRY`** and the الإتاحة scrape.
- **The undo pre-image** parked on the session row, replaced by an audit table.

`brain.js` should lose roughly 150–200 lines net, and every one of them is
workaround rather than behaviour.

## Phases

Each phase is independently shippable and independently revertible.

**Phase 0 — decide and provision.** Settle the ownership question above. Create
the Supabase project; note that the n8n **Postgres node** (`executeQuery`) is the
right client, not the Supabase REST node — the latter does row CRUD only and
cannot express the overlap query or run a transaction. Both are installed on
your instance. *Half a day, mostly waiting on decisions.*

**Phase 1 — schema and backfill.** Create the tables; import 46 bookings and 9
expenses with a read-only script. Reconcile every row against the sheet before
going further. Nothing in the bot changes. *Half a day.*

**Phase 2 — dual-write. Sheets stays authoritative.** *One day.*

The bot writes the spreadsheet exactly as it does today, then also writes
Postgres. Nothing else changes: the same reads, the same messages, the same
behaviour. Two rules make this safe:

- **The Postgres write can never fail a booking.** It runs *after* the sheet
  write, on a branch whose node is set to continue on error. If Supabase is down,
  asleep, or misconfigured, the receptionist sees the normal ✅ and the shadow
  copy is simply missing a row — which the next reconcile reports.
- **Every write is an upsert on `sheet_row`**, so a retry or a replay converges
  instead of duplicating.

**Phase 3 — reconcile daily, until it is boring.** *Half a day to build, then
however long trust takes.*

A scheduled job snapshots the sheet into `sheet_snapshot` and posts the output of
the `reconcile_bookings` view to the ops group: every row where the two disagree,
or that exists in one and not the other. A clean run is one line. This is the
phase that earns the flip, and it is the user's call how long it lasts — a week
of silent mornings is a reasonable bar.

It also catches the thing nothing else would: someone editing the sheet by hand.
During dual-write that is still allowed, and the reconcile will simply report the
drift, which is exactly the signal needed to decide whether option 1 is going to
be tolerable in practice.

**Phase 4 — the flip.** *One day.* Reads move to Postgres (availability, lookup,
registry — the mid-conversation wait disappears here). The bot writes Postgres
first; a mirror job writes the sheet's input columns (A–J, L, M, O, Q — never the
formula columns). Protected ranges go on. Because the mirror is then the sheet's
only writer, row allocation stops being contended and the concurrency race stops
existing.

**Phase 5 — delete the workarounds** listed above, and move the reports to SQL.
*Half a day, and the most satisfying.*

Phases 0–3 are **reversible by deleting one branch of the workflow**. Phase 4 is
the one that needs a considered go/no-go, and by then the reconcile output will
have made that decision on the evidence.

Realistically **three to four days** of focused work, spread either side of
however long the trust period runs.

## Risks

- **Manual sheet edits after Phase 3** are the main one, addressed by the
  ownership decision. Whatever is chosen must be enforced with protected ranges,
  not with a request to be careful.
- **The mirror falling behind or dying** turns the sheet into stale nonsense while
  looking fine. It needs a visible heartbeat — a `last_synced_at` cell someone
  would notice going stale — and an alert to the ops group on failure.
- **Dashboard formulas assume the exact column layout.** The mirror must preserve
  it precisely; a shifted column silently breaks 94 formulas.
- **`الإتاحة` is both a report and the bot's room registry.** Phase 2 removes the
  bot's dependency; the tab itself keeps working for people.
- **Connection limits.** Supabase's pooler, not a direct connection, if the bot
  ever runs hot.

## What I would not do

- Do not move the expense flow first. It is 9 rows and a simple append; the
  bookings tab is where every real problem lives.
- Do not try to reproduce `Dashboard` in SQL as part of this. It works, people
  read it, and it is not the bot's problem.
- Do not delete the sheet. Ever, probably. It is the interface everyone who is
  not the bot uses.
