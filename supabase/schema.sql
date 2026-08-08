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
  -- provenance. Row 32 is `=940*2+650*8` — two rates across one stay, which no
  -- single nightly_rate can express. Its evaluated total is correct and the stay
  -- is closed, so nothing recomputes; this column is so the derivation is not
  -- simply lost.
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

-- ── Expenses ─────────────────────────────────────────────────────────────────

create table if not exists expenses (
  id              bigint generated always as identity primary key,
  sheet_row       int unique,
  expense_ref     text,                      -- الرقم
  item            text,                      -- البند
  amount          numeric(12,2),
  apartment_name  text,                      -- الشقة, free text on this tab
  notes           text,
  payment_method  text,
  responsible     text,                      -- اسم المسئول
  receipt_file_id text,
  spent_at        timestamptz,               -- التاريخ
  source          text not null default 'bot' check (source in ('bot', 'backfill', 'sheet')),
  created_at      timestamptz not null default now()
);

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
drop view if exists bookings_live;
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
alter table expenses      enable row level security;
alter table bot_sessions  enable row level security;
alter table booking_audit enable row level security;
alter table sheet_snapshot enable row level security;

-- Belt and braces: Supabase grants the API roles table privileges by default on
-- creation, so take them back as well rather than relying on RLS alone.
revoke all on apartments, rooms, bookings, booking_stays, expenses, bot_sessions,
              booking_audit, sheet_snapshot
  from anon, authenticated;

drop view if exists reconcile_bookings;
create view reconcile_bookings as
select
  coalesce(b.sheet_row, s.sheet_row) as sheet_row,
  case
    when b.sheet_row is null then 'missing in db'
    when s.sheet_row is null then 'missing in sheet'
    else 'differs'
  end as problem,
  s.guest_name as sheet_guest,     b.guest_name as db_guest,
  s.apartment_name as sheet_apt,   b.apartment_name as db_apt,
  s.room_number as sheet_room,     b.room_number as db_room,
  s.arrival as sheet_arrival,      b.arrival as db_arrival,
  s.nights as sheet_nights,        b.nights as db_nights,
  s.total as sheet_total,          b.total as db_total,
  s.paid as sheet_paid,            b.paid as db_paid
from sheet_snapshot s
full outer join bookings b on b.sheet_row = s.sheet_row
where b.sheet_row is null
   or s.sheet_row is null
   or s.guest_name     is distinct from b.guest_name
   or s.apartment_name is distinct from b.apartment_name
   or s.room_number    is distinct from b.room_number
   or s.arrival        is distinct from b.arrival
   or s.nights         is distinct from b.nights
   or s.total          is distinct from b.total
   or s.paid           is distinct from b.paid;
