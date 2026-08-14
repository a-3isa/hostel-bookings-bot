# webui — a read/write dashboard over the bookings database

A small Next.js app that talks to the same Supabase Postgres the bot mirrors
into. It connects **as `postgres` over the transaction pooler**, exactly as the
bot and the backfill do — not through PostgREST. That matters: every table has
RLS on with no policies at all, so the anon key sees nothing, and putting the
anon key in a browser would have meant loosening that.

## What it does

- **/** — bookings list off `bookings_live` (so an open-ended stay shows tonight's
  figures, not a stale total), with search, status filters, and four KPIs.
- **/bookings/new**, **/bookings/[id]** — create, edit, cancel. Every edit writes
  a `booking_audit` row with the before/after JSON, which is what `/undo` reads.
- **/expenses** — list, add, edit, delete.

## The thing to keep in mind

**The sheet is still authoritative.** This app writes to Postgres only. A row
created or edited here will show up in the daily reconcile as a difference until
someone puts the same change in the sheet. The banner on every page says so.

Two smaller consequences of that same rule:

- Adding a payment does **not** touch `bookings.paid`. That column mirrors the
  sheet's cumulative paid cell for one line and is what `reconcile_payments`
  compares; recomputing it from the `payments` rows would move the two systems
  apart without anyone deciding to. The booking page shows both numbers and warns
  when they disagree.
- Rows written here carry `source = 'bot'` and `created_by = 'لوحة الويب'`. The
  `source` check constraint only allows `bot | backfill | sheet`, so provenance
  goes in `created_by` rather than a fourth value the database would reject. If
  you want a real `'web'` source, run:

  ```sql
  alter table bookings drop constraint bookings_source_check;
  alter table bookings add constraint bookings_source_check
    check (source = any (array['bot','backfill','sheet','web']));
  ```

  and the same for `payments` and `expenses`.

## Environment

Both are required. With either missing the app serves a setup screen and nothing
else — no password means no way to authenticate, so it fails closed.

| Variable | Value |
|---|---|
| `SUPABASE_TRANSACTION_URL` | The pooler URL from the repo's `.env`, port **6543**. The direct host publishes an AAAA record only and is unreachable from Vercel. |
| `DASHBOARD_PASSWORD` | Whatever you want to type to get in. |
| `BOOKINGS_SHEET_ID` | Optional, but required for deleting a sheet row: `1CiHciOeeyRMx9vz5cP0Xlid-jqM_gVjW3sUfore84S8`. **Do not use the `SHEET_ID` in the bot's `.env`** — that one points at an older spreadsheet ("booking_bot") with none of the Arabic tabs. |
| `GOOGLE_CREDENTIALS_JSON` | Optional, same. Locally it may be a path (`../service_account.json`); on Vercel put the **JSON itself**, or base64 of it — there is no file to point at. |

## Deleting a booking

The ⋯ menu on each row offers edit and delete; delete opens a confirmation
modal. `/bookings/[id]/delete` is the same thing with the full picture — what
cascades, and whether the sheet row checks out — for when the modal is not
enough.

Delete removes the booking **from wherever it exists**, and the rule that keeps
that safe is column **U** (معرف النظام), where the bot stamps `bookings.id`:

- U matches → the sheet row is deleted too, and because deleting a row closes
  the gap, every stored `sheet_row` below it is renumbered down by one, in
  `bookings` and `payments` alike. (Two passes through negative values —
  `sheet_row` is UNIQUE and not deferrable, so one decrementing UPDATE would
  collide with a row it had not reached yet.)
- U is blank, or names a different booking, or the booking has no `sheet_row`,
  or Sheets is not configured → **database only**, and the page says which of
  those it was. Row numbers shift whenever anyone inserts a line, so acting on
  an unverified `sheet_row` would delete an innocent guest's line.

The Sheets call runs *inside* the database transaction, so if Google refuses,
the rollback puts the booking back and nothing happened anywhere.

A booking with continuation lines pointing at it (`merged_into`) cannot be
deleted at all — that foreign key does not cascade. Delete the followers first.

After any delete the reconcile snapshot is stale until `backfill.py --reconcile`
runs again.

The session cookie is `sha256("bookings-webui:" + DASHBOARD_PASSWORD)`, httpOnly
and secure, 12 hours. Changing the password invalidates every session.

## Deployed

Vercel project `bookings-webui`, production at
<https://bookings-webui.vercel.app>, **built from this repository** — `master`,
root directory `webui`. Pushing to `master` deploys it; the earlier route, where
the MCP tool uploaded the file tree inline, stopped working once the app grew
past what one response could carry.

The environment variables live in Settings → Environment Variables and are not
part of the repository, so a new project starts with none of them and serves the
setup screen until all four are filled in.

`vercel.json` pins functions to `dub1` (Dublin) because Supabase is in
eu-west-1. The inline deploys landed in `iad1` and paid an Atlantic crossing on
every query; the pin takes effect from the first git-built deploy.

## Local

```
cd webui
npm install
SUPABASE_TRANSACTION_URL=... DASHBOARD_PASSWORD=... npm run dev
```
