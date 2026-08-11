"""Give every payment after the first a sheet row of its own.

The spreadsheet records a second payment as a second ROW, and that is not a
workaround to be tidied away: the Dashboard tab and other sheets read
طريقة الدفع per row and count on one payment per line. Confirmed by the user on
2026-08-10, after the mirror briefly wrote "انستاباي + فودافون كاش" into one
cell and broke exactly those formulas.

The convention, in the user's words: **اجمالي سعر الحجز equals the amount paid
in each step**. Their own rows say the same thing —

    مروان   rows 45, 58   600 كاش    + 1600 انستاباي   (booking 2200)
    محمد    rows 36, 37   600 انستاباي + 600 كاش        (booking 1200)

so no single row carries the agreed total once a booking is split; each row
carries its own payment, and the booking is the sum of its rows.

This creates the follower `bookings` row — `merged_into` pointing at the parent,
which is exactly what مروان already looks like in the database — with the
payment's amount as both total and paid. The row has no sheet_row and no
mirrored_at, so the scheduled append publishes it and stamps its id into column
U like any other DB-born booking.

Single-payment bookings are left alone: their row keeps the real agreed total,
because there is nothing to split.

    python supabase/split_payment_rows.py            # report
    python supabase/split_payment_rows.py --apply    # create the follower rows
"""

import sys

import psycopg

from backfill import connect_args

# Payments that have no line of their own. The first payment belongs to the
# booking's own row; every later one needs a row created for it.
FIND = """
with ranked as (
  select p.id, p.booking_id, p.amount, p.method, p.currency, p.sheet_row,
         row_number() over (partition by p.booking_id order by p.paid_at, p.id) as seq
  from payments p
)
select r.id as payment_id, r.booking_id, r.amount, r.method, r.seq,
       b.guest_name, b.guest_ref, b.booking_ref, b.booking_type, b.phone,
       b.apartment_name, b.room_number, b.room_id, b.arrival, b.nights,
       b.open_ended
from ranked r
join bookings b on b.id = r.booking_id
where r.seq > 1
  and r.sheet_row is null
  -- Not already published as a follower row: match on the amount and method,
  -- so re-running this cannot create the same line twice.
  and not exists (
    select 1 from bookings f
    where f.merged_into = r.booking_id
      and coalesce(f.paid, 0) = r.amount
      and coalesce(f.payment_method, '') = coalesce(r.method, '')
  )
order by r.booking_id, r.seq;
"""

CREATE = """
insert into bookings (merged_into, booking_ref, guest_ref, guest_name,
    booking_type, phone, apartment_name, room_number, room_id, arrival, nights,
    open_ended, total, paid, payment_method, source)
values (%(booking_id)s, %(booking_ref)s, %(guest_ref)s, %(guest_name)s,
        %(booking_type)s, %(phone)s, %(apartment_name)s, %(room_number)s,
        %(room_id)s, %(arrival)s, %(nights)s, %(open_ended)s,
        -- total = paid = this step's payment. The user's convention, and what
        -- every hand-made continuation row in the sheet already does.
        %(amount)s, %(amount)s, %(method)s, 'bot')
returning id;
"""


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    apply = "--apply" in sys.argv

    with psycopg.connect(**connect_args()) as conn, conn.cursor() as cur:
        cur.execute(FIND)
        cols = [c.name for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]

        print(f"payments needing a row of their own: {len(rows)}")
        for r in rows:
            print(f"  booking {r['booking_id']} ({r['guest_name']}):"
                  f" payment {r['seq']} — {r['amount']} {r['method']}")

        if not rows:
            print("nothing to split")
            return
        if not apply:
            print("\ndry run — pass --apply to create the rows")
            return

        for r in rows:
            cur.execute(CREATE, r)
            new_id = cur.fetchone()[0]
            # The rule applies to the FIRST line too, not only the new ones.
            # Leaving the parent on the agreed total while a follower carries a
            # payment counts the same booking twice: a 500 stay paid 200 + 300
            # read as 800. Once a booking is split, every line is its own
            # payment and the booking is the sum of its lines — which is what
            # مروان's 600 + 1600 has always been.
            cur.execute(
                """
                update bookings b
                set total = f.amount, paid = f.amount, payment_method = f.method
                from (
                  select p.amount, p.method
                  from payments p
                  where p.booking_id = %(booking_id)s
                  order by p.paid_at, p.id
                  limit 1
                ) f
                where b.id = %(booking_id)s;
                """, r)
            # The payment now belongs to the line that was made for it, while
            # its booking_id still points at the parent — the money is the
            # booking's, the line is just where the sheet shows it.
            cur.execute("update payments set sheet_row = null where id = %s;",
                        (r["payment_id"],))
            print(f"  + booking row {new_id} for payment {r['payment_id']}")
        conn.commit()

    print(f"\ncreated {len(rows)} row(s). They have no sheet_row yet — the"
          " scheduled append publishes them and stamps column U.")


if __name__ == "__main__":
    main()
