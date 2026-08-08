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
  id         serial primary key,
  name       text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists rooms (
  id           serial primary key,
  apartment_id int  not null references apartments(id) on delete cascade,
  number       text not null,
  active       boolean not null default true,
  unique (apartment_id, number)
);

-- ── Bookings ─────────────────────────────────────────────────────────────────

create table if not exists bookings (
  id             bigserial primary key,

  -- Sheet identity. Unique so every write can be an idempotent upsert.
  sheet_row      int unique,

  booking_ref    text,                       -- بوكنج ID
  guest_ref      text,                       -- ID — NOT unique, see header
  guest_name     text,
  booking_type   text,                       -- خارجي | بوكينج
  phone          text,

  room_id        int references rooms(id),   -- nullable: row 9 has no room
  apartment_name text,                       -- as written, for rows off-registry
  room_number    text,

  arrival        date,                       -- nullable: row 9 has no arrival
  nights         int,                        -- NULL = open-ended stay
  nightly_rate   numeric,                    -- replaces the hand-typed =500*I{row}

  total          numeric,
  -- Verbatim text of a hand-entered formula in اجمالي سعر الحجز, kept for
  -- provenance. Row 32 is `=940*2+650*8` — two rates across one stay, which no
  -- single nightly_rate can express. Its evaluated total is correct and the stay
  -- is closed, so nothing recomputes; this column is so the derivation is not
  -- simply lost.
  total_formula  text,
  paid           numeric not null default 0,
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
    (case when nights is null or arrival is null then null else arrival + nights end) stored,
  remaining numeric generated always as
    (coalesce(total, 0) - coalesce(paid, 0)) stored
);

create index if not exists bookings_room_arrival_idx on bookings (room_id, arrival);
create index if not exists bookings_guest_ref_idx    on bookings (guest_ref);
create index if not exists bookings_arrival_idx      on bookings (arrival);

-- ── Expenses ─────────────────────────────────────────────────────────────────

create table if not exists expenses (
  id              bigserial primary key,
  sheet_row       int unique,
  expense_ref     text,                      -- الرقم
  item            text,                      -- البند
  amount          numeric,
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
  id         bigserial primary key,
  booking_id bigint references bookings(id) on delete cascade,
  changed_by text,
  changed_at timestamptz not null default now(),
  before     jsonb not null,
  after      jsonb not null
);

-- ── The live view of a booking ───────────────────────────────────────────────
--
-- An open-ended stay's total is not fixed: the sheet holds `=500*I{row}` where I
-- is itself `=TODAY()-J`, so the bill grows every night. A generated column
-- cannot do that (it may not reference current_date), so the live figures come
-- from a view. Read this, not `bookings`, wherever money is shown to a person.

create or replace view bookings_live as
select
  b.*,
  case
    when b.arrival is null then null
    when b.nights is not null then b.nights
    else greatest((current_date - b.arrival), 0)
  end as effective_nights,
  case
    when b.nights is null and b.nightly_rate is not null and b.arrival is not null
      then b.nightly_rate * greatest((current_date - b.arrival), 0)
    else b.total
  end as effective_total,
  case
    when b.nights is null and b.nightly_rate is not null and b.arrival is not null
      then b.nightly_rate * greatest((current_date - b.arrival), 0) - coalesce(b.paid, 0)
    else coalesce(b.total, 0) - coalesce(b.paid, 0)
  end as effective_remaining
from bookings b;

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

create or replace view booking_overlaps as
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
  total          numeric,
  paid           numeric,
  payment_method text,
  notes          text,
  captured_at    timestamptz not null default now()
);

create or replace view reconcile_bookings as
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
