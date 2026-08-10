"""Write the database out to the spreadsheet. Phase 4c, the flip.

Direction is one way: Postgres → sheet. People edit through the web UI or the
bot, both of which write Postgres, and this puts the result where the nine other
tabs and 1,606 formulas can still see it. Two-way sync was considered and
rejected in the scope document: no reliable conflict rule exists when both sides
can change the same cell, and the failure mode is silent divergence.

What it writes, per booking, and nothing else:

    A–D, F–J   identity, room and dates      L, M   total and paid
    O          payment method                Q      notes
    U          the booking id

    E   الجنسية is retired and left exactly as found.
    K, N, P, R, S, T   sheet formulas. Writing them — even '' — destroys them.

Three things make it safe to run repeatedly:

  * **It never overwrites a hand edit.** `bookings.mirror_payload` records what
    this script last wrote. If the sheet still matches that, nobody has touched
    the row and writing is safe. If it does not, a person edited it, and the row
    is reported and skipped rather than flattened.
  * **A row it has never written is seeded, not asserted.** On the first run
    every row is unknown, so a row that already agrees with the database is
    simply recorded as mirrored. One that disagrees is reported — it is either a
    hand edit or a real drift, and both want a human.
  * **Mixed-currency bookings are skipped.** The sheet has one paid cell, and
    "650 EGP + 40 USD" is not a number. Reported, never converted.

Bookings with no sheet_row — everything the web UI creates — are appended to the
bottom and stamped with their id, which is how a UI booking becomes visible to
the sheet at all.

    python supabase/mirror.py            # report what it would do
    python supabase/mirror.py --apply    # write
"""

import json
import sys

import psycopg

from backfill import BOOKINGS_TAB, connect_args, load_bookings, open_sheet

# Column letter -> the key used in the payload. Order matters only for reading.
COLUMNS = [
    ("A", "booking_ref"), ("B", "guest_ref"), ("C", "guest_name"),
    ("D", "booking_type"), ("F", "phone"), ("G", "apartment_name"),
    ("H", "room_number"), ("I", "nights_cell"), ("J", "arrival"),
    ("L", "total"), ("M", "paid"), ("O", "payment_method"), ("Q", "notes"),
    ("U", "booking_id"),
]

# Written back with a leading apostrophe so Sheets keeps them as text: a phone
# with a leading zero, or an id that looks like a number and is not one.
TEXT_FORCED = {"booking_ref", "guest_ref", "phone"}

# The blocks actually sent to the API. E is absent on purpose.
WRITE_RANGES = [("A", "D"), ("F", "J"), ("L", "M"), ("O", "O"), ("Q", "Q"),
                ("U", "U")]

SELECT = """
select
  b.id, b.sheet_row, b.booking_ref, b.guest_ref, b.guest_name, b.booking_type,
  b.phone, b.apartment_name, b.room_number, b.arrival, b.nights, b.open_ended,
  b.total, b.paid, b.payment_method, b.notes, b.mirror_payload,
  -- Deliberately NOT the booking's combined methods.
  --
  -- The mirror briefly wrote "انستاباي + فودافون كاش" into one cell, on the
  -- reasoning that the sheet's single method column was the reason people
  -- inserted rows. It is not the whole reason: the Dashboard tab and other
  -- sheets read طريقة الدفع per row and count on one payment per line, so a
  -- combined string is not a tidier version of the same fact — it is a value
  -- those formulas cannot read. One line, one method.
  b.payment_method as paid_methods,
  (select count(distinct p.currency) > 1
     from payments p where p.booking_id = coalesce(b.merged_into, b.id))
    as mixed_currency,
  -- A booking spread over continuation lines keeps each line's OWN method.
  -- Combining them there would stamp "انستاباي + كاش" on both of مروان's rows
  -- and lose which line was which payment — the aggregate belongs on a booking
  -- that occupies a single line, where the sheet otherwise has room for one
  -- method and the second is simply lost.
  (b.merged_into is not null
   or exists (select 1 from bookings f where f.merged_into = b.id)) as multi_line,
  b.merged_into
from bookings b
order by b.sheet_row nulls last, b.id;
"""


def s(v):
    return "" if v is None else str(v)


def money(v):
    """Numbers the way the sheet holds them: 2640, not 2640.00."""
    if v is None:
        return ""
    f = float(v)
    return str(int(f)) if f == int(f) else str(f)


def desired(row, sheet_row):
    """The cell values this booking should produce, keyed as in COLUMNS."""
    # An open-ended stay is a live formula in the sheet, exactly as the bot
    # writes it — عدد الليالي has to keep counting up on its own.
    nights_cell = (f"=TODAY()-J{sheet_row}" if row["open_ended"]
                   else ("" if row["nights"] is None else str(row["nights"])))
    return {
        "booking_ref": s(row["booking_ref"]),
        "guest_ref": s(row["guest_ref"]),
        "guest_name": s(row["guest_name"]),
        "booking_type": s(row["booking_type"]),
        "phone": s(row["phone"]),
        "apartment_name": s(row["apartment_name"]),
        "room_number": s(row["room_number"]),
        "nights_cell": nights_cell,
        "arrival": "" if row["arrival"] is None else row["arrival"].isoformat(),
        "total": money(row["total"]),
        "paid": money(row["paid"]),
        # This line's own method, always. See paid_methods in the query.
        "payment_method": s(row["payment_method"]),
        "notes": s(row["notes"]),
        "booking_id": str(row["id"]),
    }


def observed(sheet_row_values, sheet_row):
    """What the sheet currently shows, in the same shape as desired()."""
    def col(letter):
        idx = ord(letter) - ord("A")
        cells = sheet_row_values or []
        return s(cells[idx]).strip() if idx < len(cells) else ""

    out = {}
    for letter, key in COLUMNS:
        out[key] = col(letter)
    return out


def sheet_owned_keys(formula_cells):
    """Columns whose sheet cell holds a formula, and so are not ours to write.

    `=500*I10` in اجمالي سعر الحجز is someone saying "500 a night, however long
    this turns out to be" — a live number the sheet recomputes as the stay runs.
    Replacing it with a scalar loses the intent silently, so those cells stay
    the sheet's.
    """
    owned = set()
    for letter, key in COLUMNS:
        idx = ord(letter) - ord("A")
        cells = formula_cells or []
        cell = str(cells[idx]).strip() if idx < len(cells) else ""
        if cell.startswith("="):
            owned.add(key)
    return owned


MONEY_KEYS = {"total", "paid"}


def same_cell(key, a, b):
    """Is what the sheet shows the same value as what the database holds?

    Money is compared as a NUMBER. The sheet formats 2064 as '2,064.00' and an
    empty cell means zero, so comparing the text called all 59 rows a conflict
    on the first dry run.
    """
    if key in MONEY_KEYS:
        def n(v):
            v = str(v).replace(",", "").strip()
            if v in ("", "-"):
                return 0.0
            try:
                return float(v)
            except ValueError:
                return None
        na, nb = n(a), n(b)
        if na is not None and nb is not None:
            return na == nb
    return str(a).strip() == str(b).strip()


def differing(want, have, sheet_owned):
    """Keys where the sheet and the database really disagree."""
    return [k for k in comparable(want)
            if k not in sheet_owned and not same_cell(k, want[k], have.get(k, ""))]


def comparable(payload):
    """Drop the parts that cannot be compared cell-for-cell.

    عدد الليالي on an open stay is a formula in the sheet and an evaluated
    number in a values read, so the two never match textually. The database
    already models that as open_ended, and the reconcile compares the number
    itself — so it is excluded here rather than reported as a difference every
    single run.
    """
    return {k: v for k, v in payload.items() if k != "nights_cell"}


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    apply = "--apply" in sys.argv
    # On the first run nothing has a payload, so every row that disagrees looks
    # identical to a hand edit and is skipped. This says "I have read the
    # reconcile and the database is right" — once, deliberately, and never
    # needed again because from then on every row carries what was last written.
    assert_first = "--assert-first-run" in sys.argv
    sh = open_sheet(writable=apply)
    ws = sh.worksheet(BOOKINGS_TAB)

    # The whole block in one read, values as displayed.
    known = {b["sheet_row"] for b in load_bookings(sh)}
    last_row = max(known) if known else 1
    grid = ws.get(f"A2:U{last_row}")
    # The same block as FORMULAS. A cell holding `=500*I10` is someone saying
    # "500 a night, however long this turns out to be" — a live number the sheet
    # recomputes. Overwriting it with whatever scalar the database happens to
    # hold would silently destroy that intent on every open-ended stay, which
    # the scope document named as the one mistake that would make this migration
    # a net loss. So a formula cell belongs to the sheet, and the mirror leaves
    # it exactly alone.
    formula_grid = ws.get(f"A2:U{last_row}", value_render_option="FORMULA")
    by_row, formulas_by_row = {}, {}
    for i, cells in enumerate(grid, start=2):
        by_row[i] = cells
    for i, cells in enumerate(formula_grid, start=2):
        formulas_by_row[i] = cells

    with psycopg.connect(**connect_args()) as conn, conn.cursor() as cur:
        cur.execute(SELECT)
        cols = [c.name for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]

        writes, seeded, appends, conflicts, skipped_mixed = [], [], [], [], []
        agreed = formula_owned = 0
        next_row = last_row + 1

        for row in rows:
            if row["mixed_currency"]:
                skipped_mixed.append(row)
                continue

            if row["sheet_row"] is None:
                row["_target_row"] = next_row
                appends.append(row)
                next_row += 1
                continue

            target = row["sheet_row"]
            want = desired(row, target)
            have = observed(by_row.get(target), target)
            owned = sheet_owned_keys(formulas_by_row.get(target))
            payload = row["mirror_payload"]
            if owned:
                formula_owned += len(owned)

            if not differing(want, have, owned):
                agreed += 1
                if payload is None:
                    seeded.append((row, want, owned))
                continue

            if payload is None:
                # Never mirrored, and it does not already agree. Could be drift,
                # could be a hand edit; either way a person decides, not this.
                # `--assert-first-run` is that person deciding, once, after the
                # reconcile has been checked.
                if assert_first:
                    writes.append((row, want, owned))
                else:
                    conflicts.append((row, want, have, owned, "never mirrored"))
            elif differing(payload, have, owned):
                conflicts.append((row, want, have, owned,
                                  "edited by hand since last mirror"))
            else:
                writes.append((row, want, owned))

        print(f"{BOOKINGS_TAB}: {len(rows)} bookings, sheet rows 2–{last_row}")
        print(f"  already correct:        {agreed}")
        print(f"  to write:               {len(writes)}")
        for row, want, _owned in writes[:10]:
            print(f"    row {row['sheet_row']}: {want['guest_name']}")
        print(f"  to append (no row yet): {len(appends)}")
        for row in appends[:10]:
            print(f"    -> row {row['_target_row']}: {row['guest_name']}")
        print(f"  to seed (agree, first run): {len(seeded)}")
        print(f"  cells left to the sheet (formulas): {formula_owned}")
        print(f"  CONFLICTS (skipped):    {len(conflicts)}")
        for row, want, have, owned, why in conflicts[:10]:
            print(f"    row {row['sheet_row']}: {row['guest_name']} — {why}")
            for k in differing(want, have, owned)[:4]:
                print(f"        {k}: sheet {have.get(k)!r} / db {want[k]!r}")
        print(f"  mixed currency (skipped): {len(skipped_mixed)}")
        for row in skipped_mixed[:5]:
            print(f"    row {row['sheet_row']}: {row['guest_name']}")

        if not apply:
            print("\ndry run — pass --apply to write")
            return

        batch = []

        def stage(target, payload, owned):
            for start, end in WRITE_RANGES:
                letters = [chr(c) for c in range(ord(start), ord(end) + 1)]
                keys = [dict(COLUMNS).get(letter) for letter in letters]
                # A block containing even one sheet-owned cell is sent
                # cell-by-cell instead, so a live `=500*I10` next to a plain
                # room number does not get flattened along with it.
                if any(k in owned for k in keys):
                    for letter, key in zip(letters, keys):
                        if key in owned:
                            continue
                        v = payload[key]
                        if key in TEXT_FORCED and v:
                            v = "'" + v
                        batch.append({"range": f"{letter}{target}", "values": [[v]]})
                    continue
                values = []
                for key in keys:
                    v = payload[key]
                    if key in TEXT_FORCED and v:
                        v = "'" + v
                    values.append(v)
                batch.append({"range": f"{start}{target}:{end}{target}",
                              "values": [values]})

        for row, want, owned in writes:
            stage(row["sheet_row"], want, owned)
        for row in appends:
            want = desired(row, row["_target_row"])
            stage(row["_target_row"], want, set())
            row["_payload"] = want

        if batch:
            # USER_ENTERED so =TODAY()-J{r} lands as a formula; the leading
            # apostrophe above is what stops a phone number becoming a float.
            ws.batch_update(batch, value_input_option="USER_ENTERED")

        for row, want, _owned in writes:
            cur.execute("update bookings set mirror_payload = %s, mirrored_at = now()"
                        " where id = %s;", (json.dumps(want, ensure_ascii=False), row["id"]))
        for row, want, _owned in seeded:
            cur.execute("update bookings set mirror_payload = %s, mirrored_at = now()"
                        " where id = %s;", (json.dumps(want, ensure_ascii=False), row["id"]))
        for row in appends:
            cur.execute("update bookings set sheet_row = %s, mirror_payload = %s,"
                        " mirrored_at = now() where id = %s;",
                        (row["_target_row"],
                         json.dumps(row["_payload"], ensure_ascii=False), row["id"]))
        conn.commit()

    print(f"\nwrote {len(writes)}, appended {len(appends)}, seeded {len(seeded)},"
          f" left {len(conflicts)} conflict(s) alone")


if __name__ == "__main__":
    main()
