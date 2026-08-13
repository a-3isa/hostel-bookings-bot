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

    python supabase/reindex.py            # report only
    python supabase/reindex.py --apply    # re-point, adopt, write U
"""

import sys

import psycopg

from backfill import (BOOKINGS_TAB, connect_args, load_bookings, numeric,
                      open_sheet, text_or_none)

ID_COL = "U"


def sheet_ids(ws, last_row):
    """sheet_row -> booking id, from column U. Blank and non-numeric are None."""
    got = ws.get(f"{ID_COL}2:{ID_COL}{last_row}")
    out = {}
    for i, row in enumerate(got, start=2):
        raw = str((row or [""])[0]).strip()
        out[i] = int(raw) if raw.isdigit() else None
    for row in range(2, last_row + 1):
        out.setdefault(row, None)
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

    with psycopg.connect(**connect_args()) as conn, conn.cursor() as cur:
        cur.execute("select id, sheet_row from bookings;")
        db_row = dict(cur.fetchall())

        repoint, adoptable, orphans = [], [], []
        for row in sorted(rows):
            bid = ids.get(row)
            if bid is None:
                adoptable.append(row)
            elif bid not in db_row:
                orphans.append((row, bid))
            elif db_row[bid] != row:
                repoint.append((bid, db_row[bid], row))

        # A booking whose row vanished from the sheet: not deleted here, because
        # "the row is gone" and "the row moved past the range we read" are the
        # same shape from this side.
        seen_ids = {b for b in ids.values() if b is not None}
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
        print(f"  in db, not found in the sheet:  {len(vanished)}")

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
        targets = {now for _bid, _was, now in repoint}
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

        written = []
        for row in adoptable:
            new_id = adopt(cur, rows[row])
            written.append({"range": f"{ID_COL}{row}", "values": [[str(new_id)]]})
            print(f"  adopted row {row} as booking {new_id}")

        conn.commit()

    if written:
        ws.batch_update(written, value_input_option="RAW")
        print(f"\nwrote {len(written)} id(s) into column {ID_COL}")
    print(f"re-pointed {len(repoint)}, adopted {len(written)}")


if __name__ == "__main__":
    main()
