"""Turn a follower booking into what it always was: a second payment line.

The sheet has one طريقة الدفع cell per row, so a guest who paid 600 in cash and
1600 by انستاباي needs two rows. Those second rows were imported as bookings of
their own — مروان twice, محمد twice, امير سيف الدين twice — pointed at the real
booking through `merged_into`. The user's objection to that is the right one:

    "I don't want the booking with diff payment to have a second booking row in
    the database."

So the follower stops being a booking. What it holds is money, and money has a
home: `payments`, one row per line, numbered by `line_seq`. The sheet line stays
exactly where it is and gets stamped `413-2` in column U — the booking it
belongs to, and which of its lines it is. From then on the sheet says outright
what each row is, and a row inserted above it renumbers nothing that matters.

What this does, per booking that has follower rows:

  1. numbers its payments by the line they sit on — 1 for the booking's own row,
     2, 3 … for the followers, in sheet order;
  2. sums the lines' money onto the booking, because one booking now holds what
     was spread across several;
  3. writes `<id>-<seq>` into column U of each follower row;
  4. deletes the follower booking.

Order matters: the U stamps are written before the deletes are committed, so a
failure half way leaves rows that still name a booking that exists.

    python supabase/collapse_lines.py            # report only
    python supabase/collapse_lines.py --apply    # collapse
"""

import sys

import psycopg

from backfill import BOOKINGS_TAB, connect_args, open_sheet

ID_COL = "U"

# The follower rows and the booking each belongs to, straight from the database.
# `merged_into` is chased to its root so a chain (a booking with three lines,
# where the third was merged into the second) collapses onto the real booking
# rather than onto a row that is itself about to stop existing.
FOLLOWERS = """
with recursive root as (
  select id, id as base, merged_into, 0 as depth from bookings where merged_into is null
  union all
  select b.id, r.base, b.merged_into, r.depth + 1
  from bookings b join root r on b.merged_into = r.id
)
select r.base, r.id, r.depth, b.sheet_row, b.guest_name, b.total, b.paid,
       b.payment_method
from root r join bookings b on b.id = r.id
where r.depth > 0
order by r.base, b.sheet_row;
"""


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    apply = "--apply" in sys.argv
    sh = open_sheet(writable=apply)
    ws = sh.worksheet(BOOKINGS_TAB)

    with psycopg.connect(**connect_args()) as conn, conn.cursor() as cur:
        cur.execute(FOLLOWERS)
        followers = cur.fetchall()
        if not followers:
            print("no follower rows — nothing to collapse")
            return

        bases = {}
        for base, fid, _depth, sheet_row, name, total, paid, method in followers:
            bases.setdefault(base, []).append(
                dict(id=fid, sheet_row=sheet_row, guest_name=name,
                     total=total, paid=paid, method=method))

        stamps, plan = [], []
        for base, rows in bases.items():
            cur.execute("select sheet_row, guest_name, total, paid, payment_method"
                        " from bookings where id = %s;", (base,))
            b_row, b_name, b_total, b_paid, b_method = cur.fetchone()

            # Every line the booking occupies, its own first. `line_seq` is the
            # position in this list, which is what column U will say.
            lines = [dict(id=None, sheet_row=b_row, guest_name=b_name,
                          total=b_total, paid=b_paid, method=b_method)]
            lines += sorted(rows, key=lambda r: r["sheet_row"] or 0)

            total = sum(float(ln["total"] or 0) for ln in lines)
            paid = sum(float(ln["paid"] or 0) for ln in lines)

            # A booking whose lines are in different currencies sums to a number
            # denominated in nothing — 40 دولار and 650 كاش are not 690. The
            # honest figures stay in `payments`, one row per currency, and
            # `mixed_currency_bookings` is what names this booking to a human.
            # The sum is written anyway because `bookings_model` already
            # computes exactly this number today, and the reconcile compares
            # against the sheet's own column, which sums them the same way.
            cur.execute("select count(distinct currency) from payments"
                        " where booking_id = %s;", (base,))
            mixed = (cur.fetchone()[0] or 0) > 1

            plan.append((base, lines, total, paid, mixed))
            for seq, ln in enumerate(lines, start=1):
                if seq > 1 and ln["sheet_row"]:
                    stamps.append({"range": f"{ID_COL}{ln['sheet_row']}",
                                   "values": [[f"{base}-{seq}"]]})

        print(f"{BOOKINGS_TAB}: {len(plan)} booking(s) with follower rows")
        for base, lines, total, paid, mixed in plan:
            flag = "  (mixed currency)" if mixed else ""
            print(f"  booking {base}: {lines[0]['guest_name']} — "
                  f"{len(lines)} lines, total {total:g}, paid {paid:g}{flag}")
            for seq, ln in enumerate(lines, start=1):
                tag = f"{base}" if seq == 1 else f"{base}-{seq}"
                gone = "" if seq == 1 else f", booking {ln['id']} deleted"
                print(f"    row {ln['sheet_row']}: U={tag}, "
                      f"{float(ln['paid'] or 0):g} {ln['method']}{gone}")

        if not apply:
            print("\ndry run — pass --apply to collapse")
            return

        for base, lines, total, paid, _mixed in plan:
            # Number the payments by the row they were recorded on. A payment
            # with no sheet_row is one the bot recorded as an event and owns no
            # line, so it keeps line_seq NULL and is left alone.
            for seq, ln in enumerate(lines, start=1):
                cur.execute("update payments set booking_id = %s, line_seq = %s"
                            " where sheet_row = %s;", (base, seq, ln["sheet_row"]))
            cur.execute("update bookings set total = %s, paid = %s, updated_at = now()"
                        " where id = %s;", (total, paid, base))

        # Written before the delete is committed: a row that names a booking
        # which no longer exists is an orphan, and reindex.py will not touch it.
        if stamps:
            ws.batch_update(stamps, value_input_option="RAW")
            print(f"\nstamped {len(stamps)} row(s) in column {ID_COL}")

        for base, lines, _total, _paid, _mixed in plan:
            for ln in lines[1:]:
                cur.execute("delete from bookings where id = %s;", (ln["id"],))
        conn.commit()

    deleted = sum(len(lines) - 1 for _b, lines, _t, _p, _m in plan)
    print(f"collapsed {len(plan)} booking(s), deleted {deleted} follower row(s)")


if __name__ == "__main__":
    main()
