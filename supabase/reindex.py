"""Make column U the key, and adopt rows nobody told the database about.

This is what retires `sheet_row` as an identity. Until now a row inserted by
hand renumbered every row beneath it, and the next reconcile reported a wall of
differences that were not real — 26 of them, the first time it happened.

With each booking's id written in column U (see write_sheet_ids.py) the sheet
itself says which booking each row is, so an insert stops being ambiguous:

  * **re-point** — U says row 30 is booking 21, the database thinks booking 21
    is on row 29, so the database is wrong about the row and is corrected. No
    guessing, no comparison of names and dates.
  * **adopt** — a row with no id is one the database has never seen: typed
    straight into the sheet, or appended by the bot before the mirror existed.
    It is inserted and its new id written back into U. This is the answer to
    "what if someone needs to add a row by hand" — they can, and it gets picked
    up rather than overwritten.
  * **orphan** — an id in U that no booking has. Reported, never acted on: it
    means someone copied a row, and which of the two is real is a question for a
    person.
  * **payment line** — a suffixed id, `413-2`. The row belongs to booking 413
    and holds one of its payments; it is never a booking, so it is never
    adopted. Its row is re-pointed on the PAYMENT, not on any booking.

    python supabase/reindex.py            # report only
    python supabase/reindex.py --apply    # re-point, adopt, write U
"""

import sys

import psycopg

from backfill import (BOOKINGS_TAB, connect_args, load_bookings, numeric,
                      open_sheet, parse_sheet_id, text_or_none)

ID_COL = "U"


def sheet_ids(ws, last_row):
    """sheet_row -> (booking id, line sequence), from column U.

    An unstamped or unreadable cell is (None, None). `413` reads as sequence 1,
    the booking's own line; `413-2` as sequence 2, a continuation line.
    """
    got = ws.get(f"{ID_COL}2:{ID_COL}{last_row}")
    out = {}
    for i, row in enumerate(got, start=2):
        out[i] = parse_sheet_id((row or [""])[0])
    for row in range(2, last_row + 1):
        out.setdefault(row, (None, None))
    return out


def adopt(cur, b):
    """Insert a booking the database has never seen. Returns its new id."""
    cur.execute(
        """
        insert into bookings (sheet_row, booking_ref, guest_ref, guest_name,
            booking_type, phone, apartment_name, room_number, room_id, arrival,
            nights, open_ended, total, paid, payment_method, notes, source)
        values (%s, %s, %s, %s, %s, %s, %s, %s,
                (select r.id from rooms r join apartments a on a.id = r.apartment_id
                  where a.name = %s and r.number = %s),
                %s, %s, %s, %s, %s, %s, %s, 'sheet')
        returning id;
        """,
        (b["sheet_row"], text_or_none(b["booking_ref"]), text_or_none(b["guest_ref"]),
         text_or_none(b["guest_name"]), text_or_none(b["booking_type"]),
         text_or_none(b["phone"]), text_or_none(b["apartment"]), text_or_none(b["room"]),
         text_or_none(b["apartment"]), text_or_none(b["room"]),
         b["arrival"] or None, numeric(b["nights"]), b["is_open"],
         numeric(b["total"]), numeric(b["paid"]) or 0,
         text_or_none(b["payment"]), text_or_none(b["notes"])))
    return cur.fetchone()[0]


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    apply = "--apply" in sys.argv
    sh = open_sheet(writable=apply)
    ws = sh.worksheet(BOOKINGS_TAB)
    rows = {b["sheet_row"]: b for b in load_bookings(sh)}
    last = max(rows) if rows else 1
    ids = sheet_ids(ws, last)
    # A continuation line whose stamp column U could not spell. `16-2` reads as
    # line 2 straight from the cell; row 18 carries a bare `16` because it was
    # merged into row 17 by hand, and read literally that says booking 16 lives
    # on row 18 — which would re-point the booking off its own row. load_bookings
    # recognises the shape and hands back the real sequence, so take its answer.
    for row, b in rows.items():
        if b["is_payment_line"] and ids.get(row, (None, None))[1] != b["line_seq"]:
            ids[row] = (b["id_of"], b["line_seq"])

    with psycopg.connect(**connect_args()) as conn, conn.cursor() as cur:
        cur.execute("select id, sheet_row from bookings;")
        db_row = dict(cur.fetchall())

        repoint, adoptable, orphans, unrecorded = [], [], [], []
        line_moves = []
        for row in sorted(rows):
            bid, seq = ids.get(row, (None, None))
            if bid is None:
                adoptable.append(row)
            elif bid not in db_row:
                orphans.append((row, bid))
            elif seq > 1:
                # A continuation line. Its row belongs to the payment recorded
                # on it, and moves independently of the booking's own row — a
                # booking with two lines would otherwise have both stamped with
                # the same new row, which is what `sheet_row` alone could never
                # express.
                cur.execute("select id, sheet_row from booking_lines"
                            " where booking_id = %s and line_seq = %s;", (bid, seq))
                got = cur.fetchone()
                if got is None:
                    unrecorded.append((row, bid, seq))
                elif got[1] != row:
                    line_moves.append((got[0], got[1], row))
            elif db_row[bid] != row:
                repoint.append((bid, db_row[bid], row))

        # A booking whose row vanished from the sheet: not deleted here, because
        # "the row is gone" and "the row moved past the range we read" are the
        # same shape from this side.
        seen_ids = {b for b, _seq in ids.values() if b is not None}
        vanished = [(bid, r) for bid, r in db_row.items()
                    if r is not None and bid not in seen_ids]

        print(f"{BOOKINGS_TAB}: rows 2–{last}")
        print(f"  re-point (U disagrees with db): {len(repoint)}")
        for bid, was, now in repoint[:10]:
            print(f"    booking {bid}: row {was} -> {now}")
        print(f"  adopt (no id in U):             {len(adoptable)}")
        for row in adoptable[:10]:
            print(f"    row {row}: {rows[row]['guest_name']}")
        print(f"  orphan ids (no such booking):   {len(orphans)}")
        for row, bid in orphans[:10]:
            print(f"    row {row}: U says {bid}")
        print(f"  payment lines to re-point:      {len(line_moves)}")
        for pid, was, now in line_moves[:10]:
            print(f"    payment {pid}: row {was} -> {now}")
        print(f"  payment lines with no payment:  {len(unrecorded)}")
        for row, bid, seq in unrecorded[:10]:
            print(f"    row {row}: U says {bid}-{seq}, booking {bid} has no line {seq}")
        print(f"  in db, not found in the sheet:  {len(vanished)}")
        # Named, unlike the count alone this used to print. Nothing here acts on
        # them — see above — but "two bookings are in the database and not in the
        # sheet" is not something a person can check without knowing WHICH two,
        # and the answer decides whether they are duplicates to delete or rows
        # somebody removed by mistake.
        for bid, r in vanished[:10]:
            cur.execute("select guest_name, apartment_name, arrival, total, paid,"
                        " source, created_at from bookings where id = %s;", (bid,))
            g = cur.fetchone()
            if g:
                print(f"    booking {bid}: db row {r} — {g[0]}, {g[1]}, "
                      f"{g[2]}, total {g[3]}, paid {g[4]}, {g[5]} {g[6]:%Y-%m-%d %H:%M}")
            else:
                print(f"    booking {bid}: db row {r}")

        if not apply:
            print("\ndry run — pass --apply to write")
            return

        # Two phases, because sheet_row is unique: parking the moved rows on
        # negative numbers first means a swap (29->30, 30->29) cannot collide
        # with itself half way through.
        # Park every booking that currently sits on a row somebody is moving
        # INTO, not just the movers. A booking outside the move set holding a
        # target row makes the second phase collide — seen live on 2026-08-12,
        # where a duplicate created from a blank inserted row occupied row 18
        # and the re-point died on bookings_sheet_row_key.
        #
        # ADOPTED rows are targets too. That was missing until 2026-08-22, when
        # a test booking whose sheet row had been deleted was still holding row
        # 105 in the database while a hand-typed booking on the sheet's row 105
        # was being adopted: the insert died on the same unique constraint and
        # took the whole run with it. An adoption claims a row exactly as a
        # re-point does, so it needs the row cleared exactly as one does.
        targets = {now for _bid, _was, now in repoint} | set(adoptable)
        movers = {bid for bid, _was, _now in repoint}
        cur.execute("select id from bookings where sheet_row = any(%s) and id <> all(%s);",
                    (list(targets), list(movers) or [0]))
        squatters = [r[0] for r in cur.fetchall()]
        for bid in squatters:
            cur.execute("update bookings set sheet_row = %s where id = %s;", (-bid, bid))
        if squatters:
            print(f"  parked {len(squatters)} row(s) that were sitting on a target row:"
                  f" {squatters[:10]}")

        for bid, _was, _now in repoint:
            cur.execute("update bookings set sheet_row = %s where id = %s;", (-bid, bid))
        for bid, _was, now in repoint:
            cur.execute("update bookings set sheet_row = %s where id = %s;", (now, bid))

        # Payments carry a sheet_row of their own — the LINE they were recorded
        # on, which for a continuation line is not the booking's own row. So
        # they move by old row, not by booking: a booking with two payment lines
        # would otherwise have both stamped with the same new row.
        for _bid, was, _now in repoint:
            cur.execute("update payments set sheet_row = %s where sheet_row = %s;",
                        (-was, was))
        for _bid, was, now in repoint:
            cur.execute("update payments set sheet_row = %s where sheet_row = %s;",
                        (now, -was))

        # Continuation lines, re-pointed from column U rather than dragged along
        # by a booking. Parked on negative ids first for the same reason the
        # bookings are: booking_lines.sheet_row is unique, so two lines swapping
        # rows collide half way through a one-phase update.
        for lid, _was, _now in line_moves:
            cur.execute("update booking_lines set sheet_row = %s where id = %s;",
                        (-lid, lid))
        for lid, _was, now in line_moves:
            cur.execute("update booking_lines set sheet_row = %s where id = %s;",
                        (now, lid))

        written = []
        for row in adoptable:
            new_id = adopt(cur, rows[row])
            written.append({"range": f"{ID_COL}{row}", "values": [[str(new_id)]]})
            print(f"  adopted row {row} as booking {new_id}")

        conn.commit()

    if written:
        ws.batch_update(written, value_input_option="RAW")
        print(f"\nwrote {len(written)} id(s) into column {ID_COL}")
    print(f"re-pointed {len(repoint)} booking(s) and {len(line_moves)} payment line(s),"
          f" adopted {len(written)}")


if __name__ == "__main__":
    main()
