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

A booking can occupy more than one LINE. طريقة الدفع has room for one method, so
a guest who paid 600 in cash and 1600 by انستاباي needs two rows — and the second
one is money, not a guest, so it lives in `booking_lines` and is written out from
there. Column U says which line each row is: `21`, then `21-2`. The booking's own
row shows what is left after the other lines are taken out, so the sheet's lines
sum back to exactly the total the database holds.

**A line is a payment TYPE, not a payment.** A second payment in a method the
booking already has joins that line and its cell grows; only a method not seen on
this booking before opens a row, and that row is inserted directly under the
booking's block, moving every row below it down by one. So a guest who pays cash
three times occupies one cash line, and this script is the only thing that
allocates a row — the bot and the web UI record the money and leave the sheet
alone.

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
  b.merged_into,
  -- The booking's continuation LINES: one per payment METHOD beyond the
  -- booking's own. A line's money is the sum of the payments assigned to it, so
  -- a second cash payment lands on the cash line and the cell simply grows.
  (select coalesce(jsonb_agg(jsonb_build_object(
            'id', l.id, 'seq', l.line_seq, 'sheet_row', l.sheet_row,
            'amount', sums.amount, 'method', l.method, 'currency', l.currency,
            'payload', l.mirror_payload) order by l.line_seq), '[]'::jsonb)
     from booking_lines l
     join lateral (select coalesce(sum(p.amount), 0) as amount
                     from payments p
                    where p.booking_id = l.booking_id
                      and p.line_seq = l.line_seq) sums on true
    where l.booking_id = b.id) as lines,
  -- Payments that belong to no line yet. Every payment the bot and the web UI
  -- record arrives like this; deciding which line each one joins is what
  -- `plan_allocation` below does.
  (select coalesce(jsonb_agg(jsonb_build_object(
            'id', p.id, 'amount', p.amount, 'method', p.method,
            'currency', p.currency) order by p.paid_at, p.id), '[]'::jsonb)
     from payments p
    where p.booking_id = b.id and p.line_seq is null) as unallocated,
  -- The currency of the booking's OWN line, which is the currency of whatever
  -- has been assigned to line 1. Nothing to read means EGP, the default a
  -- payment is recorded with.
  (select p.currency from payments p
    where p.booking_id = b.id and p.line_seq = 1
    order by p.id limit 1) as primary_currency
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


def line_payload(row, line, sheet_row):
    """What a continuation line's row should show.

    Everything identifying the guest is repeated, because that is what the sheet
    has always held on these rows and what its own formulas read. Only the money
    and the method are the line's own — and column U, which says which line this
    is: `21-2`, booking 21, line 2.

    The money is the line's own payments summed, which is why a second كاش
    payment changes this cell rather than adding a row.

    **اجمالي سعر الحجز is left BLANK on a line row** (ruled 2026-08-18). The
    booking is worth what was agreed once, and that number stays whole on the
    booking's own row; a line is a second METHOD of paying it, not a second
    price. Writing the payment into L here as well would make the column sum to
    more than the booking — 13,500 for a 10,000 stay — and every formula that
    totals L reads that. Blank keeps the lines summing back to the booking.
    """
    want = desired(row, sheet_row)
    amount = money(line["amount"])
    want["total"] = ""
    want["paid"] = amount
    want["payment_method"] = s(line["method"])
    want["booking_id"] = f"{row['id']}-{line['seq']}"
    return want


def primary_payload(row, lines, sheet_row):
    """The booking's own row, with the money its other lines carry taken out.

    **اجمالي سعر الحجز is NOT reduced** (ruled 2026-08-18). The agreed price is
    a fact about the booking, so it stays whole here and the line rows leave
    their L blank — see line_payload. Between them the L column still sums to
    the booking and no formula that totals it is misled.

    اجمالي ما تم دفعه IS reduced, and has to be: the sheet has one paid cell per
    row and the lines each carry their own. Leaving the full 5,000 here while
    the line below shows 3,500 would count that payment twice.
    """
    want = desired(row, sheet_row)
    if not lines:
        return want
    spread = sum(float(ln["amount"] or 0) for ln in lines)
    want["paid"] = money(float(row["paid"] or 0) - spread)
    return want


DEFAULT_CURRENCY = "EGP"

# The fill given to a continuation row when this script opens one. Light enough
# that the sheet's own black text stays readable on it.
LINE_ROW_COLOUR = {"red": 0.85, "green": 0.78, "blue": 0.93}


def line_key(method, currency):
    """What makes two payments the same LINE.

    The rule is the payment TYPE: a second كاش joins the كاش line and its cell
    grows; a first انستاباي opens a row of its own. Currency is part of the
    identity because there are no exchange rates in this system — 1000 كاش جنيه
    and 50 كاش يورو are not 1050 of anything and cannot share a cell.
    """
    return (s(method).strip(), s(currency).strip() or DEFAULT_CURRENCY)


def plan_allocation(row):
    """Which line each of this booking's unassigned payments joins.

    Returns `(merges, new_lines, adopted)`:

      merges     [(payment_id, line_seq)] — the type is already on the sheet, so
                 the payment joins that row. Nothing is inserted.
      new_lines  [{seq, method, currency, amount, payment_ids}] — a type this
                 booking has not been paid in before. Each needs a row.
      adopted    the key line 1 takes on when the booking had no method at all.

    Two payments of the same new type in one run share ONE new line: three
    payments in انستاباي on a booking that had none produce one row holding
    their sum, not three rows.

    A payment arriving on a booking with no method yet fills the booking's own
    row instead of opening a second one. An empty طريقة الدفع cell with a
    populated line beneath it is not what anyone means by two payment methods.
    """
    lines = row["lines"] or []
    primary = line_key(row["payment_method"], row["primary_currency"])
    adopted = None

    seq_of = {}
    if primary[0]:
        seq_of[primary] = 1
    for ln in lines:
        seq_of.setdefault(line_key(ln["method"], ln["currency"]), ln["seq"])

    next_seq = max([1] + [ln["seq"] for ln in lines]) + 1
    merges, opened = [], {}
    for p in row["unallocated"] or []:
        key = line_key(p["method"], p["currency"])
        if not primary[0] and adopted is None:
            adopted = key
            seq_of.setdefault(key, 1)
        if key in seq_of:
            merges.append((p["id"], seq_of[key]))
        elif key in opened:
            opened[key]["payment_ids"].append(p["id"])
            opened[key]["amount"] += float(p["amount"] or 0)
        else:
            opened[key] = {"seq": next_seq, "method": key[0], "currency": key[1],
                           "amount": float(p["amount"] or 0),
                           "payment_ids": [p["id"]]}
            next_seq += 1
    return merges, list(opened.values()), adopted


def block_end(row):
    """The last sheet row this booking occupies — its own, or its lowest line."""
    rows = [row["sheet_row"]] + [ln["sheet_row"] for ln in (row["lines"] or [])]
    return max(r for r in rows if r is not None)


def shift_rows_down(cur, at_row):
    """Everything from `at_row` down moves one row further down.

    Renumbered through negatives first: `sheet_row` is UNIQUE and not
    deferrable, so a single incrementing UPDATE collides with a row it has not
    reached yet.
    """
    for table in ("bookings", "payments", "booking_lines"):
        cur.execute(f"update {table} set sheet_row = -(sheet_row + 1)"
                    f" where sheet_row >= %s;", (at_row,))
        cur.execute(f"update {table} set sheet_row = -sheet_row"
                    f" where sheet_row < 0;")


def open_line(cur, ws, row, line):
    """Give a new line a row in the sheet and a row in the database.

    The row goes directly under the booking's block, which is where a person
    would put it, and `inheritFromBefore` carries the formatting and the
    filled-down formulas of the row above — K, N, P, R, S and T are the sheet's
    and are never written by this script.

    Every row below the insert moves down by one, in the sheet and in all three
    tables that remember a row number, or the next run writes a guest's money
    onto whoever moved into their number.
    """
    cur.execute("insert into booking_lines (booking_id, line_seq, method, currency)"
                " values (%s, %s, %s, %s) returning id;",
                (row["id"], line["seq"], line["method"] or None, line["currency"]))
    line_id = cur.fetchone()[0]
    cur.execute("update payments set line_seq = %s where id = any(%s);",
                (line["seq"], line["payment_ids"]))

    at_row = block_end(row) + 1
    ws.insert_rows([[""]], row=at_row, inherit_from_before=True)
    # Purple, so a payment line is recognisable as one at a glance (asked for
    # 2026-08-18). `inheritFromBefore` has just copied the booking row's own
    # formatting onto it, which is what makes the two indistinguishable
    # otherwise. Colour only — no value is written here.
    ws.format(f"A{at_row}:U{at_row}", {"backgroundColor": LINE_ROW_COLOUR})
    shift_rows_down(cur, at_row)
    cur.execute("update booking_lines set sheet_row = %s where id = %s;",
                (at_row, line_id))
    return line_id, at_row


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

    def load_rows(cur):
        cur.execute(SELECT)
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    def read_grid():
        """The block twice: values as displayed, and the same cells as formulas.

        A cell holding `=500*I10` is someone saying "500 a night, however long
        this turns out to be" — a live number the sheet recomputes. Overwriting
        it with whatever scalar the database happens to hold would silently
        destroy that intent on every open-ended stay, which the scope document
        named as the one mistake that would make this migration a net loss. So a
        formula cell belongs to the sheet, and the mirror leaves it alone.
        """
        known = {b["sheet_row"] for b in load_bookings(sh)}
        last = max(known) if known else 1
        values = {i: cells for i, cells
                  in enumerate(ws.get(f"A2:U{last}"), start=2)}
        formulas = {i: cells for i, cells
                    in enumerate(ws.get(f"A2:U{last}",
                                        value_render_option="FORMULA"), start=2)}
        return values, formulas, last

    with psycopg.connect(**connect_args()) as conn, conn.cursor() as cur:
        rows = load_rows(cur)

        # Which line every unassigned payment belongs on. A type already on the
        # sheet grows its own cell; a type not seen on this booking before needs
        # a row, and that row is INSERTED, which moves every row below it.
        merges, opens, adoptions = [], [], []
        for row in rows:
            if row["sheet_row"] is None:
                continue        # nothing to insert under yet; it is appended below
            m, new_lines, adopted = plan_allocation(row)
            merges.extend((row, pid, seq) for pid, seq in m)
            opens.extend((row, line) for line in new_lines)
            if adopted:
                adoptions.append((row, adopted))

        print(f"payment lines: {len(merges)} joining a line already there,"
              f" {len(opens)} new line(s), {len(adoptions)} filling an empty method")
        for row, line in opens[:10]:
            print(f"    booking {row['id']} {row['guest_name']}:"
                  f" {line['method']} {line['amount']:g} {line['currency']}"
                  f" -> line {line['seq']}, a row under {block_end(row)}")
        for row, pid, seq in merges[:10]:
            print(f"    payment {pid} -> booking {row['id']} line {seq}")

        fresh_lines = set()
        if apply and (merges or opens or adoptions):
            for row, adopted in adoptions:
                cur.execute("update bookings set payment_method = %s where id = %s;",
                            (adopted[0], row["id"]))
            for _row, pid, seq in merges:
                cur.execute("update payments set line_seq = %s where id = %s;",
                            (seq, pid))
            # Bottom of the sheet upwards, so an insert never moves the row a
            # later insert was measured against.
            for row, line in sorted(opens, key=lambda o: block_end(o[0]),
                                    reverse=True):
                line_id, at_row = open_line(cur, ws, row, line)
                fresh_lines.add(line_id)
                print(f"  inserted row {at_row} for booking {row['id']}"
                      f" line {line['seq']} ({line['method']})")
            conn.commit()
            # The inserts moved rows and the merges moved money, so both sides
            # are re-read before anything is compared against anything.
            rows = load_rows(cur)

        by_row, formulas_by_row, last_row = read_grid()

        writes, seeded, appends, conflicts, skipped_mixed = [], [], [], [], []
        agreed = formula_owned = 0
        # A row this run inserted is still BLANK, so `load_bookings` — which
        # knows a row by its guest name — cannot see it, and the append below
        # would hand a UI booking a row number that already belongs to a line.
        # The database remembers every row it has given out; trust that too.
        claimed = [r["sheet_row"] for r in rows if r["sheet_row"] is not None]
        claimed += [ln["sheet_row"] for r in rows for ln in (r["lines"] or [])
                    if ln["sheet_row"] is not None]
        next_row = max([last_row] + claimed) + 1

        # One item per sheet LINE, not per booking: a booking paid in two methods
        # owns two rows, and each is checked and written on its own. `line` is
        # None for the booking's own row.
        items = []
        for row in rows:
            if row["mixed_currency"]:
                skipped_mixed.append(row)
                continue

            if row["sheet_row"] is None:
                row["_target_row"] = next_row
                appends.append(row)
                next_row += 1
                continue

            lines = row["lines"] or []
            items.append((row, None, row["sheet_row"],
                          primary_payload(row, lines, row["sheet_row"]),
                          row["mirror_payload"]))
            for ln in lines:
                # A payment with no row of its own is one the bot recorded as an
                # event. It has no line to write until something allocates one.
                if ln["sheet_row"] is None:
                    continue
                items.append((row, ln, ln["sheet_row"],
                              line_payload(row, ln, ln["sheet_row"]),
                              ln["payload"]))

        for row, line, target, want, payload in items:
            have = observed(by_row.get(target), target)
            owned = sheet_owned_keys(formulas_by_row.get(target))
            if owned:
                formula_owned += len(owned)

            if not differing(want, have, owned):
                agreed += 1
                if payload is None:
                    seeded.append((row, line, target, want, owned))
                continue

            if payload is None:
                # Never mirrored, and it does not already agree. Could be drift,
                # could be a hand edit; either way a person decides, not this.
                # `--assert-first-run` is that person deciding, once, after the
                # reconcile has been checked.
                #
                # A row this run inserted itself is the exception: it is blank
                # because nothing has been written into it yet, and reporting
                # that as a possible hand edit would leave the sheet with an
                # empty line and no way to fill it.
                if assert_first or (line and line["id"] in fresh_lines):
                    writes.append((row, line, target, want, owned))
                else:
                    conflicts.append((row, target, want, have, owned, "never mirrored"))
            elif differing(payload, have, owned):
                conflicts.append((row, target, want, have, owned,
                                  "edited by hand since last mirror"))
            else:
                writes.append((row, line, target, want, owned))

        print(f"{BOOKINGS_TAB}: {len(rows)} bookings on {len(items)} lines,"
              f" sheet rows 2–{last_row}")
        print(f"  already correct:        {agreed}")
        print(f"  to write:               {len(writes)}")
        for row, line, target, want, _owned in writes[:10]:
            tag = f" (line {line['seq']})" if line else ""
            print(f"    row {target}: {want['guest_name']}{tag}")
        print(f"  to append (no row yet): {len(appends)}")
        for row in appends[:10]:
            print(f"    -> row {row['_target_row']}: {row['guest_name']}")
        print(f"  to seed (agree, first run): {len(seeded)}")
        print(f"  cells left to the sheet (formulas): {formula_owned}")
        print(f"  CONFLICTS (skipped):    {len(conflicts)}")
        for row, target, want, have, owned, why in conflicts[:10]:
            print(f"    row {target}: {row['guest_name']} — {why}")
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

        for _row, _line, target, want, owned in writes:
            stage(target, want, owned)
        for row in appends:
            want = desired(row, row["_target_row"])
            stage(row["_target_row"], want, set())
            row["_payload"] = want

        if batch:
            # USER_ENTERED so =TODAY()-J{r} lands as a formula; the leading
            # apostrophe above is what stops a phone number becoming a float.
            ws.batch_update(batch, value_input_option="USER_ENTERED")

        def record(row, line, want):
            """Remember what was written, on whatever owns the line.

            A continuation line's record lives on the LINE, not the booking:
            one `mirror_payload` per booking could only describe one row, and
            the hand-edit check needs to know what each row was left holding.
            """
            blob = json.dumps(want, ensure_ascii=False)
            if line is None:
                cur.execute("update bookings set mirror_payload = %s,"
                            " mirrored_at = now() where id = %s;", (blob, row["id"]))
            else:
                cur.execute("update booking_lines set mirror_payload = %s,"
                            " mirrored_at = now() where id = %s;", (blob, line["id"]))

        for row, line, _target, want, _owned in writes:
            record(row, line, want)
        for row, line, _target, want, _owned in seeded:
            record(row, line, want)
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
