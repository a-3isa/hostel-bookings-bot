"""Make the database say exactly what the spreadsheet says, and nothing more.

    python supabase/sheet_sync.py            # report only
    python supabase/sheet_sync.py --apply    # write

`backfill.py --apply` brings the sheet's BOOKINGS and EXPENSES across. It is an
upsert and only an upsert: it can add a row and it can correct one, but it can
never take anything away, and it does not touch `payments` or `booking_lines` at
all. This finishes the job in the other direction — the sheet is the reference,
so anything the database holds that the sheet does not state is removed.

Run it AFTER `reindex.py --apply` and `backfill.py --apply`, in that order:

    python supabase/reindex.py  --apply      # column U -> sheet_row
    python supabase/backfill.py --apply      # the sheet's values
    python supabase/sheet_sync.py --apply    # everything the sheet does not say

Order is not a style preference. `backfill.py` upserts `on conflict (sheet_row)`,
so with the row pointers stale it writes one guest's booking on top of another's.

What it does, in this order:

  1. **booking_lines** — one row per continuation line the sheet shows (`413-2`
     in column U), upserted on (booking_id, line_seq). Lines the sheet no longer
     shows are deleted.
  2. **payments** — emptied and rebuilt, one row per sheet line that holds money.
     The sheet has a single cumulative paid cell per line, so that is the whole
     of what it can state: amounts, methods and the row each sits on. Anything a
     payment row held that the sheet does not — a receipt photo's file id, the
     real time money changed hands, an idempotency key — does not survive, by
     the user's explicit instruction on 2026-08-28. `backups/` has them.
  3. **booking_stays** — the per-segment rate history exists only for a booking
     whose price cell is a multi-rate formula (`=950*2+700*5`). `backfill.py`
     rewrites those; this removes the segments of a booking whose formula is
     gone, which nothing else does.
  4. **bookings** — any booking whose id is stamped on no sheet row at all.
     Expected to be zero, because `reindex.py` reports the same set and has
     always found none. Deleting one cascades to its payments and lines, so it
     needs `--force-bookings` on top of `--apply`: a booking that vanished from
     the sheet is far more likely to be a botched hand edit than a deletion
     somebody meant.
  5. **expenses** — rows whose sheet_row is not an expense row any more.

`paid_at` is left NULL on every rebuilt payment, following `seed_ledger.py`: the
date money changed hands is the one thing the sheet never records, and now() would
be a lie that reads like a fact.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import psycopg

from backfill import (BOOKINGS_TAB, EXPENSES_TAB, connect_args, load_bookings,
                      load_expenses, numeric, open_sheet, text_or_none)

# طريقة الدفع carries the currency: there is no currency column in the sheet.
# Same three-way test the bot's shadow write makes, so the two agree about what
# `دولار` means.
def currency_of(method):
    m = str(method or "")
    if "دولار" in m:
        return "USD"
    if "يورو" in m:
        return "EUR"
    return "EGP"


# Not a payment: the absence of one, spelled out in the column that names
# payments. A line saying غير مدفوع with money on it is a contradiction in the
# sheet, and is reported rather than silently recorded as a payment method.
UNPAID = "غير مدفوع"


def plan(sh):
    """What the sheet says, in the shape the three tables need."""
    rows = load_bookings(sh)
    expenses = load_expenses(sh)

    lines, payments, warnings = [], [], []
    for b in rows:
        if not b["id_of"]:
            continue                       # unstamped; reindex.py adopts these
        seq = b["line_seq"] or 1
        paid = numeric(b["paid"]) or 0
        method = text_or_none(b["payment"])

        if seq > 1:
            lines.append({"booking_id": int(b["id_of"]), "line_seq": seq,
                          "method": method, "currency": currency_of(method),
                          "sheet_row": b["sheet_row"]})
        if paid:
            if method is None or method == UNPAID:
                warnings.append(
                    f"row {b['sheet_row']}: {paid:g} paid but طريقة الدفع is "
                    f"{method or 'blank'} — recorded as the sheet has it")
            payments.append({"booking_id": int(b["id_of"]), "line_seq": seq,
                             "amount": paid, "method": method,
                             "currency": currency_of(method),
                             "sheet_row": b["sheet_row"]})

    # A booking keeps stay segments only while its price cell is a multi-rate
    # formula. `segments` is empty for every other row, including a row whose
    # formula was edited down to one rate since the segments were written.
    split_ids = {int(b["id_of"]) for b in rows
                 if b["id_of"] and not b["is_payment_line"] and len(b["segments"] or []) > 1}

    stamped = {int(b["id_of"]) for b in rows if b["id_of"]}
    expense_rows = {e["sheet_row"] for e in expenses}
    return lines, payments, split_ids, stamped, expense_rows, warnings


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force-bookings", action="store_true",
                    help="also delete bookings stamped on no sheet row (cascades)")
    args = ap.parse_args()

    sh = open_sheet()
    lines, payments, split_ids, stamped, expense_rows, warnings = plan(sh)

    print(f"sheet: {BOOKINGS_TAB} — {len(stamped)} stamped bookings, "
          f"{len(lines)} continuation lines, {len(payments)} lines holding money")
    print(f"       {EXPENSES_TAB} — {len(expense_rows)} expenses")
    for w in warnings:
        print(f"  ! {w}")

    with psycopg.connect(**connect_args()) as conn:
        with conn.cursor() as cur:
            # ── What is about to go ───────────────────────────────────────────
            cur.execute("select count(*), coalesce(sum(amount), 0),"
                        " count(receipt_file_id) from payments")
            n_pay, sum_pay, n_receipt = cur.fetchone()
            print(f"\npayments: {n_pay} rows ({sum_pay:g}) -> "
                  f"{len(payments)} rows ({sum(p['amount'] for p in payments):g})")
            if n_receipt:
                print(f"  {n_receipt} receipt file id(s) will not survive the rebuild")

            keep_lines = {(l["booking_id"], l["line_seq"]) for l in lines}
            cur.execute("select booking_id, line_seq, method, sheet_row from booking_lines")
            stale_lines = [r for r in cur.fetchall() if (r[0], r[1]) not in keep_lines]
            print(f"booking_lines: {len(lines)} in the sheet, "
                  f"{len(stale_lines)} in the database with no sheet line")
            for r in stale_lines:
                print(f"    booking {r[0]} line {r[1]} ({r[2]}) at row {r[3]}")

            cur.execute("select distinct booking_id from booking_stays")
            stale_stays = [r[0] for r in cur.fetchall() if r[0] not in split_ids]
            print(f"booking_stays: {len(stale_stays)} booking(s) whose price cell "
                  f"no longer splits")
            for b in stale_stays:
                print(f"    booking {b}")

            cur.execute("select id, sheet_row, guest_name from bookings")
            gone = [r for r in cur.fetchall() if r[0] not in stamped]
            print(f"bookings stamped on no sheet row: {len(gone)}")
            for r in gone:
                print(f"    booking {r[0]} row {r[1]} {r[2]}")

            cur.execute("select id, sheet_row, item from expenses")
            gone_exp = [r for r in cur.fetchall() if r[1] not in expense_rows]
            print(f"expenses with no sheet row: {len(gone_exp)}")
            for r in gone_exp:
                print(f"    expense {r[0]} row {r[1]} {r[2]}")

            if not args.apply:
                print("\ndry run — pass --apply to write")
                return

            if gone and not args.force_bookings:
                sys.exit("\nrefusing: bookings would be deleted (cascading to their "
                         "payments and lines). Re-run with --force-bookings if that "
                         "is really what the sheet means.")

            # ── Write ─────────────────────────────────────────────────────────
            # One transaction. A half-rebuilt `payments` is worse than either end
            # of it: the money would be neither the sheet's nor the database's.
            for l in lines:
                cur.execute(
                    "insert into booking_lines (booking_id, line_seq, method,"
                    " currency, sheet_row) values (%(booking_id)s, %(line_seq)s,"
                    " %(method)s, %(currency)s, %(sheet_row)s)"
                    " on conflict (booking_id, line_seq) do update set"
                    " method = excluded.method, currency = excluded.currency,"
                    " sheet_row = excluded.sheet_row", l)
            for booking_id, line_seq, _m, _r in stale_lines:
                cur.execute("delete from booking_lines where booking_id = %s"
                            " and line_seq = %s", (booking_id, line_seq))

            cur.execute("delete from payments")
            for p in payments:
                cur.execute(
                    "insert into payments (booking_id, amount, method, currency,"
                    " line_seq, sheet_row, paid_at, source)"
                    " values (%(booking_id)s, %(amount)s, %(method)s, %(currency)s,"
                    " %(line_seq)s, %(sheet_row)s, NULL, 'sheet')", p)

            for booking_id in stale_stays:
                cur.execute("delete from booking_stays where booking_id = %s",
                            (booking_id,))
            for r in gone_exp:
                cur.execute("delete from expenses where id = %s", (r[0],))
            if gone and args.force_bookings:
                for r in gone:
                    cur.execute("delete from bookings where id = %s", (r[0],))
        conn.commit()
    print("\napplied")


if __name__ == "__main__":
    main()
