"""Give the payments ledger a row for money the sheet records and it does not.

    python supabase/seed_ledger.py            # report what it would insert
    python supabase/seed_ledger.py --apply    # insert

Never touches the spreadsheet, by design and by scope: `open_sheet` is not
imported here at all.

## What this is for

Money lives in two places. `bookings.paid` is one number per booking, copied
from اجمالي ما تم دفعه, and it matches the sheet exactly — every report and
total in the system reads it and is correct. `payments` is the finer ledger:
one row per payment, with its method, its date and its receipt photo.

The ledger only started existing partway through. For the bookings that predate
it the sheet says money came in and the ledger has nothing to show for it —
27 bookings and 60,090 EGP on 2026-08-18, 19 of them with no payment row at all.
Nothing is WRONG: the totals are right, the breakdown is missing.

## What it invents, and what it refuses to

Each seeded row carries the DIFFERENCE — a booking that already has 750 of its
1,500 recorded gets one row of 750, not of 1,500 — with the method the sheet
gives and `paid_at` left **NULL**. The date is the one thing the sheet never
recorded and there is no honest way to guess it, so it is absent rather than
made up. `source` is 'backfill' and `client_ref` is `ledger-seed:<id>`, which
makes the rows identifiable forever. A re-run does not duplicate them: a
booking that already has a placeholder has that placeholder GROWN by whatever
the ledger is short by now, so a paid cell that rises later is still absorbed.

A booking whose ledger holds MORE than the sheet is reported and left alone.
That is the opposite problem — a payment recorded twice, or a sheet cell someone
lowered — and inserting anything would bury it.

Mixed-currency bookings never appear here: `reconcile_payments` excludes them
because the sheet's paid cell is a sum across currencies and so is the ledger's,
and there are no exchange rates in this system.
"""

import sys

import psycopg

from backfill import connect_args

# Idempotency, and a permanent label. A payment carrying this is one nobody ever
# took — it is the sheet's number, split off into the ledger so the shapes match.
CLIENT_REF = "ledger-seed:{}"

GAPS = """
select r.booking_id, r.guest_name, r.sheet_paid, r.payments_total, r.payments_n,
       b.payment_method, r.methods,
       coalesce((select p.currency from payments p
                  where p.booking_id = r.booking_id
                  order by p.id limit 1), 'EGP') as currency
  from reconcile_payments r
  join bookings b on b.id = r.booking_id
 order by (r.sheet_paid - r.payments_total) desc;
"""


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    apply = "--apply" in sys.argv

    with psycopg.connect(**connect_args()) as conn, conn.cursor() as cur:
        cur.execute(GAPS)
        rows = cur.fetchall()

        seed, over = [], []
        for bid, name, paid, total, n, method, methods, currency in rows:
            gap = (paid or 0) - (total or 0)
            if gap > 0:
                seed.append((bid, name, gap, method or methods, currency, n))
            elif gap < 0:
                over.append((bid, name, -gap, n))

        print(f"bookings whose ledger is short: {len(seed)}")
        for bid, name, gap, method, currency, n in seed:
            had = "no payments" if not n else f"{n} payment(s) already"
            print(f"  booking {bid:>5}  {name}  +{gap} {currency} {method or '—'}   ({had})")
        print(f"  total to insert: {sum(g for _b, _n, g, _m, _c, _x in seed)}")

        if over:
            print(f"\nledger holds MORE than the sheet — reported, never touched: {len(over)}")
            for bid, name, gap, n in over:
                print(f"  booking {bid}: {name}, ledger is {gap} above the sheet"
                      f" across {n} payment(s)")

        if not apply:
            print("\ndry run — pass --apply to insert")
            return

        # A booking that already has a placeholder gets that placeholder GROWN,
        # not a second one.
        #
        # This was a plain "insert only if absent", which made a re-run a no-op —
        # right for a booking whose paid cell has not moved, wrong for one whose
        # has. On 2026-08-22 booking 9's paid rose by 10,000 in the sheet; the
        # existing `ledger-seed:9` row blocked the insert, and the tool printed
        # "inserted 0" while still naming the gap it had just refused to close.
        #
        # A placeholder stands for "everything the ledger is missing for this
        # booking", so the answer to a bigger gap is a bigger placeholder.
        inserted, grown = 0, 0
        for bid, _name, gap, method, currency, _n in seed:
            ref = CLIENT_REF.format(bid)
            cur.execute(
                "update payments set amount = amount + %s,"
                " method = coalesce(method, %s) where client_ref = %s;",
                (gap, method or None, ref))
            if cur.rowcount:
                grown += 1
                continue
            cur.execute(
                """
                insert into payments (booking_id, amount, method, currency, paid_at,
                                      sheet_row, line_seq, source, client_ref)
                values (%s, %s, %s, %s, null, null, 1, 'backfill', %s);
                """,
                (bid, gap, method or None, currency, ref))
            inserted += cur.rowcount
        conn.commit()
        print(f"\ninserted {inserted} placeholder payment(s),"
              f" grew {grown} that already existed")

        cur.execute("select count(*), coalesce(sum(sheet_paid - payments_total), 0)"
                    " from reconcile_payments;")
        left, amount = cur.fetchone()
        print(f"reconcile_payments now: {left} booking(s), {amount} outstanding")


if __name__ == "__main__":
    main()
