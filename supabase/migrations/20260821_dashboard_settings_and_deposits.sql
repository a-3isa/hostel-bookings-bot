-- Dashboard tab + deposits — 2026-08-21
--
-- Two things the Dashboard tab of the sheet needs that Postgres has nowhere to
-- put, and one thing the business does that nothing modelled at all.
--
--   1. `apartments.monthly_rent` — the sheet's Dashboard!I column. صافي الربح is
--      `الدخل بدون نسبة بوكنج − المصاريف − الايجار`, and the rent was a
--      hand-typed number living only in that column.
--   2. `settings` — Dashboard!B20 holds the Booking.com commission rate (13.1%
--      today) and every N-column formula multiplies by it. One cell, one row.
--   3. `deposits` — the business periodically banks collected كاش, which moves
--      money from the كاش balance to the انستاباي balance. The sheet has never
--      recorded it, so the per-method balances have always drifted.
--
-- Re-runnable by construction: every statement is `if not exists`, `on conflict
-- do nothing`, or guarded so it will not overwrite a value someone has since
-- edited in the dashboard. Running this file twice changes nothing the second
-- time.
--
-- NOT written into schema.sql — that file is the shadow-phase schema and is
-- owned elsewhere. Apply this one on its own:
--
--     psql "$SUPABASE_TRANSACTION_URL" -f supabase/migrations/20260821_dashboard_settings_and_deposits.sql

-- ── 1. Rent per apartment ────────────────────────────────────────────────────

alter table apartments add column if not exists monthly_rent numeric(12,2);

comment on column apartments.monthly_rent is
  'الايجار — the sheet''s Dashboard!I column. Subtracted from صافي الربح.';

-- Seeded from Dashboard!I as it stood on 2026-08-21. `where monthly_rent is
-- null` is what makes a second run harmless: a rent edited in the dashboard is
-- left alone, and only an apartment that has never had one gets seeded.
--
-- ابو حديد 7 is deliberately absent. The sheet lists it with a BLANK rent and
-- there is no such row in `apartments` — no rooms, no bookings, no expenses —
-- so there is nothing here to seed. Add the apartment first if it becomes real.
update apartments a
   set monthly_rent = v.rent
  from (values
          ('ذاكر حسين',      19000::numeric),
          ('احمد فهيم',      25000),
          ('انبي 3',         25000),
          ('انبي 2',         23000),
          ('ابو حديد 11',    18000),
          ('عبدالله العربي', 25000)
       ) as v(name, rent)
 where a.name = v.name
   and a.monthly_rent is null;

-- ── 2. Settings ──────────────────────────────────────────────────────────────
--
-- One numeric per key. Deliberately not a single wide row: a wide row needs a
-- migration for every new knob, and this table needs none.

create table if not exists settings (
  key        text primary key,
  value      numeric not null,
  label      text,
  updated_at timestamptz not null default now()
);

comment on table settings is
  'Scalar knobs the dashboard reads and writes. Dashboard!B20 lives here.';

insert into settings (key, value, label)
values ('booking_commission_rate', 0.131, 'نسبة عمولة بوكينج')
on conflict (key) do nothing;

-- ── 3. Deposits ──────────────────────────────────────────────────────────────
--
-- A deposit moves money between two payment-method balances without any booking
-- being involved: كاش collected at the door is banked and becomes انستاباي.
-- Nothing is created or destroyed, which is why `from_method <> to_method` is
-- enforced — a deposit into its own method is a typo, not a transaction.
--
-- One currency per deposit, and no rate column anywhere. There are no exchange
-- rates in this system by explicit decision, so a deposit is كاش EGP → انستاباي
-- EGP and never كاش EGP → دولار USD.
--
-- This table NEVER reaches the Google Sheet. The sheet has no concept of it and
-- the user chose database + dashboard only, so no publish path touches it.

create table if not exists deposits (
  id          bigint generated always as identity primary key,
  amount      numeric(12,2) not null,
  from_method text not null,
  to_method   text not null,
  currency    text not null default 'EGP',
  occurred_at timestamptz not null default now(),
  note        text,
  created_by  text,
  created_at  timestamptz not null default now(),
  constraint deposits_amount_positive check (amount > 0),
  constraint deposits_methods_differ  check (from_method <> to_method)
);

-- Forward migrations, same reason as schema.sql: `create table if not exists`
-- does nothing to a table that is already there, so a constraint added later
-- needs its own guarded statement.
alter table deposits add column if not exists currency   text not null default 'EGP';
alter table deposits add column if not exists note       text;
alter table deposits add column if not exists created_by text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deposits_amount_positive') then
    alter table deposits add constraint deposits_amount_positive check (amount > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deposits_methods_differ') then
    alter table deposits add constraint deposits_methods_differ check (from_method <> to_method);
  end if;
end $$;

create index if not exists deposits_occurred_at_idx on deposits (occurred_at desc);
create index if not exists deposits_from_method_idx  on deposits (from_method);
create index if not exists deposits_to_method_idx    on deposits (to_method);

-- ── Security ─────────────────────────────────────────────────────────────────
--
-- Same posture as every other table here: RLS on and NO policies at all, so
-- PostgREST returns nothing to anon or authenticated. The dashboard and the bot
-- connect as `postgres`, which bypasses RLS. See the Security section of
-- schema.sql for why an accidental `using (true)` would undo all of it.

alter table settings enable row level security;
alter table deposits enable row level security;

revoke all on settings, deposits from anon, authenticated;
