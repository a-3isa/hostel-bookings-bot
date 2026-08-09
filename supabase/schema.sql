-- Bookings bot — Supabase schema, SHADOW phase.
--
-- While the spreadsheet is still authoritative this database must accept
-- everything the sheet accepts, including rows the sheet let through that a
-- clean model would reject. Measured against the 46 live bookings on
-- 2026-08-08:
--
--   * row 9 has a guest and 3000 outstanding but no room, no apartment and no
--     arrival date;
--   * 3 rows have no ID (guest_ref);
--   * guest_ref 5 and 16 each appear on two different bookings.
--
-- So: almost everything is nullable and nothing is unique except the surrogate
-- key and the sheet row. Constraints get tightened at the flip, deliberately and
-- with the data cleaned first — not now, where a rejected insert would mean the
-- bot's dual-write starts failing on a real booking.
--
-- Idempotency: `sheet_row` is the natural key during shadow mode. Every write is
-- an upsert on it, so a retry, a replay, or a re-run of the backfill converges
-- instead of duplicating.

create extension if not exists btree_gist;

-- ── Registry ─────────────────────────────────────────────────────────────────
-- Seeded from the الإتاحة tab, which already holds one row per apartment+room.

create table if not exists apartments (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists rooms (
  id           bigint generated always as identity primary key,
  apartment_id bigint not null references apartments(id) on delete cascade,
  number       text not null,
  active       boolean not null default true,
  unique (apartment_id, number)
);

-- ── Bookings ─────────────────────────────────────────────────────────────────

create table if not exists bookings (
  id             bigint generated always as identity primary key,

  -- Sheet identity. Unique so every write can be an idempotent upsert.
  sheet_row      int unique,

  booking_ref    text,                       -- بوكنج ID
  guest_ref      text,                       -- ID — NOT unique, see header
  guest_name     text,
  booking_type   text,                       -- خارجي | بوكينج
  phone          text,

  room_id        bigint references rooms(id),   -- nullable: row 9 has no room
  apartment_name text,                       -- as written, for rows off-registry
  room_number    text,

  arrival        date,                       -- nullable: row 9 has no arrival
  nights         int,                        -- NULL = not known, OR open-ended
  -- `nights is null` is ambiguous: on row 9 it means nobody filled the cell in,
  -- on 6 others it means the stay is open-ended. In the sheet those are
  -- distinguishable only by whether عدد الليالي holds a live formula, so the
  -- distinction is recorded here explicitly rather than inferred from NULL.
  open_ended     boolean not null default false,
  nightly_rate   numeric(12,2),                    -- replaces the hand-typed =500*I{row}

  total          numeric(12,2),
  -- Verbatim text of a hand-entered formula in اجمالي سعر الحجز, kept for
  -- provenance.
  --
  -- Two shapes occur, and they mean different things:
  --   `=500*I{row}`      a nightly rate. The sheet recomputes it as the stay
  --                      runs, so `nightly_rate` is set and so does this.
  --   `=940*2+650*8`     someone's arithmetic for a price agreed ONCE — the
  --                      full amount of the booking, typed in one go (confirmed
  --                      by the user, 2026-08-08). It does not recompute, even
  --                      when the stay is open-ended. The differing rates are
  --                      there because the guest changed rooms.
  total_formula  text,
  paid           numeric(12,2) not null default 0,
  payment_method text,
  receipt_file_id text,
  notes          text,

  cancelled_at   timestamptz,
  created_by     text,                       -- Telegram display name
  source         text not null default 'bot' check (source in ('bot', 'backfill', 'sheet')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- What the sheet computes with formulas, computed here instead. An open stay
  -- is `nights is null`, not a =TODAY()-J{row} that has to be told apart from a
  -- real checkout by reading the cell twice in two render modes.
  departure date generated always as
    (case when open_ended or nights is null or arrival is null
          then null else arrival + nights end) stored,
  remaining numeric generated always as
    (coalesce(total, 0) - coalesce(paid, 0)) stored
);

-- Forward migrations for a database created before a column existed. This file
-- is meant to be re-runnable against a live database, and `create table if not
-- exists` silently does nothing to a table that is already there — so anything
-- added to the definition above also needs a line here.
alter table bookings add column if not exists open_ended    boolean not null default false;
alter table bookings add column if not exists total_formula text;
alter table bookings add column if not exists nightly_rate  numeric(12,2);
alter table bookings add column if not exists receipt_file_id text;
alter table expenses add column if not exists receipt_file_id text;
alter table expenses add column if not exists apartment_id bigint references apartments(id);

create index if not exists rooms_apartment_id_idx   on rooms (apartment_id);
create index if not exists bookings_room_arrival_idx on bookings (room_id, arrival);
create index if not exists bookings_guest_ref_idx    on bookings (guest_ref);
create index if not exists bookings_arrival_idx      on bookings (arrival);

-- ── Stay segments ────────────────────────────────────────────────────────────
--
-- A booking is the commercial agreement; a stay is one stretch of nights in one
-- room at one rate. Most bookings have exactly one. Some do not: row 32 is
-- `=940*2+650*8` because the guest **changed rooms** mid-stay — 2 nights at one
-- rate, 8 at another.
--
-- The spreadsheet cannot express that. It has one room column, so a room change
-- either overwrites the original room (losing where the guest actually was) or
-- gets buried in a hand-typed formula, which is what happened here. Being able
-- to say it properly is one of the better reasons to be moving off the sheet.
--
-- `bookings.room_id` stays as the *current* room, mirroring the sheet. This
-- table is the truth about occupancy, and is what availability should consult
-- once the flip happens.

create table if not exists booking_stays (
  id             bigint generated always as identity primary key,
  booking_id     bigint not null references bookings(id) on delete cascade,
  seq            int not null default 1,
  room_id        bigint references rooms(id),
  apartment_name text,
  room_number    text,
  from_date      date,
  nights         int,                      -- NULL with open_ended = still running
  open_ended     boolean not null default false,
  nightly_rate   numeric(12,2),
  note           text,
  unique (booking_id, seq)
);

create index if not exists booking_stays_booking_id_idx on booking_stays (booking_id);
create index if not exists booking_stays_room_idx       on booking_stays (room_id, from_date);

-- ── Payments ─────────────────────────────────────────────────────────────────
--
-- The sheet has ONE payment-method column (O طريقة الدفع) and one paid column
-- (M اجمالي ما تم دفعه). So a guest who pays twice in two different methods
-- cannot be recorded on one line, and the user's answer to that has been to
-- **insert a second row** — confirmed in their own words, 2026-08-09: *"I
-- inserted a row because محمد سعيد paid a new payment but it wasn't the same
-- payment type as the one before."*
--
-- Live proof, two stays, four rows:
--
--   مروان  انبي 3 / 1     2026-08-02   rows 22, 23   600 كاش  + 1600 انستاباي
--   محمد   ابو حديد 11/4  2026-08-02   rows 35, 36   600 انستاباي + 600 كاش
--
-- Note that BOTH columns get split, not just the method: row 22 carries a total
-- of 600 and row 23 a total of 1600, and the stay really cost 2200. The booking
-- is the sum of its rows.
--
-- This is the second one-to-many the sheet was hiding; `booking_stays` is the
-- first. It is also the *cause* of the sheet_row instability that made the first
-- live reconcile report 26 false differences — inserting a row renumbers every
-- row beneath it. Giving payments somewhere real to live removes the reason
-- anyone inserts a row by hand.

create table if not exists payments (
  id              bigint generated always as identity primary key,
  booking_id      bigint not null references bookings(id) on delete cascade,
  amount          numeric(12,2) not null,
  method          text,
  -- The sheet has no currency column: طريقة الدفع carries it. دولار means the
  -- figure in اجمالي ما تم دفعه is dollars. Found on 2026-08-09 when امير سيف
  -- الدين's two lines — 40 دولار and 650 كاش — were folded into one booking and
  -- summed to "690", a number denominated in nothing.
  currency        text not null default 'EGP',
  receipt_file_id text,
  paid_at         timestamptz,
  -- The sheet line this payment was recorded on, when it came from one. Unique
  -- so the backfill and the mirror can both upsert on it instead of duplicating.
  -- NULL for a payment that never had a line of its own.
  sheet_row       int unique,
  source          text not null default 'bot' check (source in ('bot', 'backfill', 'sheet')),
  created_at      timestamptz not null default now()
);

create index if not exists payments_booking_id_idx on payments (booking_id);

-- The extra sheet rows stay in `bookings`, one per sheet line, because the sheet
-- is still authoritative and the reconcile compares row for row — deleting row
-- 23 here would make the reconcile shout "missing in db" every morning about a
-- row that is deliberately gone.
--
-- Instead the follower row points at the row it belongs to. `merged_into is
-- null` means "this is a real booking"; anything else is a continuation line.
-- At the flip the mirror writes those lines back out from `payments`, and this
-- column becomes the record of which sheet line each one owns.
alter table payments add column if not exists currency text not null default 'EGP';
alter table bookings add column if not exists merged_into bigint references bookings(id);

create index if not exists bookings_merged_into_idx on bookings (merged_into);

-- ── Expenses ─────────────────────────────────────────────────────────────────

create table if not exists expenses (
  id              bigint generated always as identity primary key,
  sheet_row       int unique,
  expense_ref     text,                      -- الرقم
  item            text,                      -- البند
  amount          numeric(12,2),
  -- Same shape as bookings: a real reference, plus the name as written so a row
  -- naming an apartment that is not in الإتاحة still records what it said. All
  -- 11 live rows resolve, so the reference is the useful one.
  apartment_id    bigint references apartments(id),
  apartment_name  text,                      -- الشقة, as written
  notes           text,
  payment_method  text,
  responsible     text,                      -- اسم المسئول
  receipt_file_id text,
  spent_at        timestamptz,               -- التاريخ
  source          text not null default 'bot' check (source in ('bot', 'backfill', 'sheet')),
  created_at      timestamptz not null default now()
);

create index if not exists expenses_apartment_id_idx on expenses (apartment_id);

-- ── Sessions ─────────────────────────────────────────────────────────────────
-- Replaces the n8n `bookings_bot_sessions` data table at the flip. Created now
-- so the shape can be exercised before anything depends on it.

create table if not exists bot_sessions (
  chat_id    text primary key,
  state      text not null default '',
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── Audit, for /undo ─────────────────────────────────────────────────────────

create table if not exists booking_audit (
  id         bigint generated always as identity primary key,
  booking_id bigint references bookings(id) on delete cascade,
  changed_by text,
  changed_at timestamptz not null default now(),
  before     jsonb not null,
  after      jsonb not null
);

create index if not exists booking_audit_booking_id_idx on booking_audit (booking_id);

-- ── The live view of a booking ───────────────────────────────────────────────
--
-- An open-ended stay's total is not fixed: the sheet holds `=500*I{row}` where I
-- is itself `=TODAY()-J`, so the bill grows every night. A generated column
-- cannot do that (it may not reference current_date), so the live figures come
-- from a view. Read this, not `bookings`, wherever money is shown to a person.

-- Dropped and recreated rather than replaced: this view selects b.*, so adding a
-- column to `bookings` changes its shape, and CREATE OR REPLACE VIEW cannot
-- reorder or rename output columns. Nothing depends on these views yet.
-- cascade: reconcile_bookings is built on this one and is recreated further
-- down the same file, so taking it with us here is intended.
drop view if exists bookings_live cascade;
create view bookings_live as
with seg as (
  -- Bookings split across rooms or rates. Reported, never used to override the
  -- sheet's own total while the sheet is authoritative — see segment_total below.
  select booking_id,
         count(*) as n,
         sum(coalesce(nightly_rate, 0) *
             case when open_ended then greatest((current_date - from_date), 0)
                  else coalesce(nights, 0) end) as segment_total
  from booking_stays
  group by booking_id
  having count(*) > 1
)
select
  b.*,
  case
    when b.arrival is null then null
    when not b.open_ended and b.nights is not null then b.nights
    when b.open_ended then greatest((current_date - b.arrival), 0)
    else null
  end as effective_nights,
  case
    when b.open_ended and b.nightly_rate is not null and b.arrival is not null
      then b.nightly_rate * greatest((current_date - b.arrival), 0)
    else b.total
  end as effective_total,
  case
    when b.open_ended and b.nightly_rate is not null and b.arrival is not null
      then b.nightly_rate * greatest((current_date - b.arrival), 0) - coalesce(b.paid, 0)
    else coalesce(b.total, 0) - coalesce(b.paid, 0)
  end as effective_remaining,
  coalesce(seg.n, 1) as stay_segments,
  -- Informational only, deliberately. While the sheet is authoritative the
  -- database must AGREE with it, not out-reason it: row 32 is billed as a fixed
  -- 940*2 + 650*8 even though the stay is open-ended, so recomputing the segments
  -- against today's date would put the two systems 3250 apart and make the daily
  -- reconcile scream about a difference that is really a question for a human.
  seg.segment_total
from bookings b
left join seg on seg.booking_id = b.id;

-- ── Overlaps ─────────────────────────────────────────────────────────────────
--
-- Deliberately a VIEW and not an exclusion constraint, for now. The bot warns
-- about a clash and lets the receptionist override it, so a constraint would
-- reject a booking the sheet had already accepted and break dual-write on a real
-- guest. This reports the same thing without being able to break anything.
--
-- At the flip, swap it for:
--   alter table bookings add constraint no_double_booking
--     exclude using gist (room_id with =,
--       daterange(arrival, coalesce(departure, 'infinity'::date), '[)') with &&)
--     where (cancelled_at is null and room_id is not null and arrival is not null);

drop view if exists booking_overlaps;
create view booking_overlaps as
select
  a.id            as booking_id,
  b.id            as other_booking_id,
  a.apartment_name,
  a.room_number,
  a.guest_name    as guest,
  b.guest_name    as other_guest,
  a.arrival,      a.departure,
  b.arrival       as other_arrival,
  b.departure     as other_departure
from bookings a
join bookings b
  on  a.id < b.id
  and a.room_id is not null
  and a.room_id = b.room_id
  and a.cancelled_at is null
  and b.cancelled_at is null
  and daterange(a.arrival, coalesce(a.departure, 'infinity'::date), '[)')
   && daterange(b.arrival, coalesce(b.departure, 'infinity'::date), '[)');

-- ── Reconciliation ───────────────────────────────────────────────────────────
-- What the trust period is actually for: a single query that answers "does the
-- database still agree with the sheet?". Compared against a snapshot of the
-- sheet loaded into `sheet_snapshot` by the reconcile script.

create table if not exists sheet_snapshot (
  sheet_row      int primary key,
  guest_name     text,
  apartment_name text,
  room_number    text,
  arrival        date,
  nights         int,
  total          numeric(12,2),
  paid           numeric,
  payment_method text,
  notes          text,
  captured_at    timestamptz not null default now()
);

-- ── Security ─────────────────────────────────────────────────────────────────
--
-- Everything above lives in `public`, which Supabase publishes through PostgREST.
-- Left alone, anyone holding the project's anon key — which is public by design,
-- it ships in browsers — could read every guest name, phone number and payment
-- on this database.
--
-- The bot does not use PostgREST. It connects over Postgres as the `postgres`
-- role, which bypasses RLS. So the correct posture is: RLS on, and NO policies
-- at all. Deny by default. The bot is unaffected; the API surface returns
-- nothing to anon and authenticated alike.
--
-- If a policy is ever needed here, add it deliberately and narrowly. An
-- accidental `using (true)` would undo all of this in one line.

alter table apartments    enable row level security;
alter table rooms         enable row level security;
alter table bookings      enable row level security;
alter table booking_stays enable row level security;
alter table payments      enable row level security;
alter table expenses      enable row level security;
alter table bot_sessions  enable row level security;
alter table booking_audit enable row level security;
alter table sheet_snapshot enable row level security;

-- Belt and braces: Supabase grants the API roles table privileges by default on
-- creation, so take them back as well rather than relying on RLS alone.
revoke all on apartments, rooms, bookings, booking_stays, payments, expenses,
              bot_sessions, booking_audit, sheet_snapshot
  from anon, authenticated;

-- Compared against `bookings_live`, not `bookings`, and this is the whole trick.
--
-- On an open-ended stay the sheet shows an evaluated night count and a total
-- that grows every day, while the table stores nights NULL and the total as it
-- was at write time. Comparing the raw columns would report all six open stays
-- as differing every single morning, and a report that cries wolf daily is one
-- nobody reads by the end of the week. `effective_nights` and `effective_total`
-- reproduce exactly what the sheet's own formulas produce, so a difference here
-- means something really is wrong.

drop view if exists reconcile_bookings;
create view reconcile_bookings as
select
  coalesce(l.sheet_row, s.sheet_row) as sheet_row,
  case
    when l.sheet_row is null then 'missing in db'
    when s.sheet_row is null then 'missing in sheet'
    else 'differs'
  end as problem,
  s.guest_name as sheet_guest,     l.guest_name as db_guest,
  s.apartment_name as sheet_apt,   l.apartment_name as db_apt,
  s.room_number as sheet_room,     l.room_number as db_room,
  s.arrival as sheet_arrival,      l.arrival as db_arrival,
  s.nights as sheet_nights,        l.effective_nights as db_nights,
  s.total as sheet_total,          l.effective_total as db_total,
  s.paid as sheet_paid,            l.paid as db_paid
from sheet_snapshot s
full outer join bookings_live l on l.sheet_row = s.sheet_row
where l.sheet_row is null
   or s.sheet_row is null
   or s.guest_name     is distinct from l.guest_name
   or s.apartment_name is distinct from l.apartment_name
   or s.room_number    is distinct from l.room_number
   or s.arrival        is distinct from l.arrival
   or s.nights         is distinct from l.effective_nights
   -- Money is compared to the piastre; a rounding difference is a real one.
   or coalesce(s.total, 0) is distinct from coalesce(l.effective_total, 0)
   or coalesce(s.paid, 0)  is distinct from coalesce(l.paid, 0);

-- ── The booking as it really is ──────────────────────────────────────────────
--
-- `bookings` and `bookings_live` are shaped like the SHEET: one row per sheet
-- line, because that is what the reconcile has to compare against. This view is
-- shaped like the WORLD: one row per booking, with the continuation lines folded
-- back in and their money summed.
--
-- This is what the bot reads after the flip — availability, lookup and the
-- reports — so that a guest who paid twice is one result and not two.
-- `sheet_rows` carries every line the booking occupies, which is what the mirror
-- needs to write it back out.

drop view if exists bookings_model;
create view bookings_model as
select
  b.id,
  b.sheet_row,                              -- the primary line
  agg.sheet_rows,
  b.booking_ref, b.guest_ref, b.guest_name, b.booking_type, b.phone,
  b.room_id, b.apartment_name, b.room_number,
  b.arrival, b.nights, b.open_ended, b.nightly_rate, b.departure,
  b.effective_nights,
  agg.total,
  agg.paid,
  agg.total - agg.paid as remaining,
  agg.methods,
  agg.lines,
  b.notes, b.cancelled_at, b.created_by, b.created_at, b.updated_at,
  b.stay_segments,
  -- What `payments` says, alongside what the sheet lines say. During the trust
  -- period the two must agree; `reconcile_payments` below is what says so.
  pay.payments_total,
  pay.payments_n,
  pay.currencies,
  -- Every payment kept in the currency it was made in. This is the honest
  -- answer to "what has this guest paid": {"EGP": 650, "USD": 40}, and
  -- `paid_label` renders it as "650 EGP + 40 USD". Never a single number that
  -- needed an exchange rate to exist.
  pay.paid_by_currency,
  pay.paid_label,
  -- When a booking mixes currencies, `total`, `paid` and `remaining` above are
  -- sums across them and mean nothing. Read this before believing them.
  coalesce(array_length(pay.currencies, 1), 1) > 1 as mixed_currency
from bookings_live b
join lateral (
  select
    -- The follower rows split BOTH money columns, so both are sums. On an
    -- open-ended primary the effective figures are used, same as the reconcile.
    coalesce(sum(coalesce(x.effective_total, 0)), 0) as total,
    coalesce(sum(coalesce(x.paid, 0)), 0)           as paid,
    string_agg(distinct nullif(x.payment_method, ''), ' + ') as methods,
    count(*)                                         as lines,
    array_agg(x.sheet_row order by x.sheet_row)      as sheet_rows
  from bookings_live x
  where coalesce(x.merged_into, x.id) = b.id
) agg on true
left join lateral (
  select
    coalesce(sum(c.amt), 0)                   as payments_total,
    coalesce(sum(c.n), 0)                     as payments_n,
    array_agg(c.currency order by c.currency) as currencies,
    jsonb_object_agg(c.currency, c.amt)       as paid_by_currency,
    string_agg(trim(to_char(c.amt, 'FM999999999.##')) || ' ' || c.currency,
               ' + ' order by c.currency)     as paid_label
  from (
    select p.currency, sum(p.amount) as amt, count(*) as n
    from payments p
    where p.booking_id = b.id
    group by p.currency
  ) c
) pay on true
where b.merged_into is null;

-- Bookings whose money is denominated in more than one currency, and so cannot
-- be totalled until someone decides a rate. Reported, never guessed at: the bot
-- offers دولار and يورو as payment methods, so this will happen again.
drop view if exists mixed_currency_bookings;
create view mixed_currency_bookings as
select m.id, m.sheet_rows, m.guest_name, m.arrival, m.methods,
       m.currencies, m.paid_by_currency, m.paid_label
from bookings_model m
where m.mixed_currency;

-- Does `payments` add up to what the sheet lines say was paid? A difference here
-- means a payment was recorded in one place and not the other — the shadow-phase
-- equivalent of a till that does not balance.
drop view if exists reconcile_payments;
create view reconcile_payments as
select
  m.id            as booking_id,
  m.sheet_rows,
  m.guest_name,
  m.paid          as sheet_paid,
  m.payments_total,
  m.payments_n,
  m.methods
from bookings_model m
-- A mixed-currency booking cannot be checked this way: the sheet's paid column
-- is a sum across currencies and so is payments_total. Those are listed by
-- mixed_currency_bookings instead, which is where a human looks at them.
where not m.mixed_currency
  and coalesce(m.paid, 0) is distinct from coalesce(m.payments_total, 0);
