"""
Load the spreadsheet into Supabase, and reconcile the two afterwards.

    python supabase/backfill.py --dry-run          # print SQL + a data report
    python supabase/backfill.py --out seed.sql     # write the SQL to a file
    python supabase/backfill.py --apply            # execute (needs SUPABASE_DB_URL)
    python supabase/backfill.py --reconcile        # compare db against the sheet

Read-only against Google either way: it never writes to the spreadsheet.

Every statement is an upsert keyed on `sheet_row`, so running this twice is
harmless and converges rather than duplicating. That matters during the trust
period, when this will be re-run repeatedly to re-sync after manual sheet edits.
"""

import argparse
import os
import re
import sys

import gspread
from google.oauth2.service_account import Credentials

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

SHEET_ID = "1CiHciOeeyRMx9vz5cP0Xlid-jqM_gVjW3sUfore84S8"
BOOKINGS_TAB = "إدخال الحجوزات"
EXPENSES_TAB = "مصروفات عامة"
AVAILABILITY_TAB = "الإتاحة"

# إدخال الحجوزات, A–T. Only the columns the bot owns are read; the sheet's
# formula columns (K, N, P, R, S, T) are derived here instead of imported.
B = dict(booking_ref=0, guest_ref=1, guest_name=2, booking_type=3, phone=5,
         apartment=6, room=7, nights=8, arrival=9, total=11, paid=12,
         payment=14, notes=16)

# مصروفات عامة, A–H.
E = dict(spent_at=0, item=1, amount=2, apartment=3, notes=4, payment=5,
         responsible=6, expense_ref=7)

ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Column U holds the booking's database id. A booking that needs a second sheet
# LINE — a payment in another method, which the sheet has to show on its own row
# because طريقة الدفع has room for exactly one — carries the same id with a
# sequence suffix: `413`, then `413-2`, `413-3`. The base is always the booking,
# so a suffixed line is a PAYMENT of a booking that already exists, and never a
# booking of its own. Everything that reads column U has to know that before
# anything writes a suffix, or the first `413-2` in the sheet gets adopted as a
# second booking for the same guest — which is the bug this ordering avoids.
SHEET_ID_RE = re.compile(r"^(\d+)(?:-(\d+))?$")


def parse_sheet_id(raw):
    """Column U as (booking id, line sequence), or (None, None).

    `413` is the booking's own line and reads as sequence 1. `413-2` is its
    second line. Anything else — blank, a stray note, a half-typed id — is not
    an identity, and is reported as unstamped rather than guessed at.
    """
    m = SHEET_ID_RE.match(str(raw or "").strip())
    if not m:
        return None, None
    seq = int(m.group(2) or 1)
    # Sequences start at 1, and `413-0` is a typo rather than a line. Reading it
    # as line zero would file a payment under a line no mirror will ever write.
    return (None, None) if seq < 1 else (int(m.group(1)), seq)


# Connection. Prefer SUPABASE_TRANSACTION_URL: the project's direct host
# (db.<ref>.supabase.co) publishes an AAAA record only and is unreachable from an
# IPv4 network, so the pooler is the way in. If only the direct URL is present it
# is rewritten onto the pooler, which needs the region — hence the preference for
# being told outright.
POOLER_FALLBACK_HOST = "aws-1-eu-west-1.pooler.supabase.com"


def env_value(key):
    with open(os.path.join(REPO, ".env"), encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.strip().startswith(key):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def connect_args():
    url = env_value("SUPABASE_TRANSACTION_URL")
    if url:
        m = re.match(r"^postgresql://([^:]+):([^@]*)@([^:]+):(\d+)/(\w+)", url)
        if not m:
            sys.exit("SUPABASE_TRANSACTION_URL is not a postgresql:// URI")
        user, pw, host, port, db = m.groups()
        port = int(port)
    else:
        url = env_value("SUPABASE_DB_URL")
        if not url:
            sys.exit("Neither SUPABASE_TRANSACTION_URL nor SUPABASE_DB_URL is set "
                     "— see supabase/README.md")
        m = re.match(r"^postgresql://[^:]+:([^@]*)@db\.([^.]+)\.supabase\.co:\d+/(\w+)", url)
        if not m:
            sys.exit("SUPABASE_DB_URL is not the direct-connection URI this expects")
        pw, ref, db = m.groups()
        user, host, port = f"postgres.{ref}", POOLER_FALLBACK_HOST, 6543
    return dict(host=host, port=port, user=user, password=pw, dbname=db,
                # Transaction pooling shares connections between clients, so a
                # named prepared statement would be executed on a connection that
                # never prepared it.
                prepare_threshold=None)


def q(v):
    """Quote for SQL. None/'' become NULL rather than an empty string."""
    if v is None or v == "":
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def qnum(v):
    if v is None or v == "":
        return "NULL"
    try:
        f = float(str(v).replace(",", ""))
    except ValueError:
        return "NULL"
    return str(int(f)) if f.is_integer() else str(f)


def numeric(v):
    """A sheet cell as a number, or None.

    The sheet formats larger amounts with thousands separators, so a paid cell
    can arrive as the string "2,225.00". Passed straight to psycopg as a
    parameter for a numeric column that is a hard error, which is how the
    snapshot load first failed — `qnum` had the comma handling but only the
    SQL-building path went through it.
    """
    if v is None or v == "":
        return None
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return None


def text_or_none(v):
    """An empty cell is absent, not the empty string.

    The reconcile compares with IS DISTINCT FROM, under which '' and NULL differ.
    The n8n snapshot node emits NULL for a blank cell, so this path has to as
    well or the two producers disagree about the same sheet — which is how row 9
    (a guest with no apartment, no room and no arrival) showed up as a
    difference against a database that says exactly the same thing.
    """
    if v is None or v == "":
        return None
    return v


def cell(row, idx):
    row = list(row) + [""] * 24
    return str(row[idx]).strip()


def open_sheet(writable=False):
    """The bookings spreadsheet.

    Read-only by default, and deliberately: this script's whole job is to copy
    OUT of the sheet, and a token that cannot write is a stronger guarantee of
    that than any amount of care in the code. `writable=True` is opt-in for the
    few tools that must write — currently only write_sheet_ids.py.
    """
    scope = "spreadsheets" if writable else "spreadsheets.readonly"
    creds = Credentials.from_service_account_file(
        os.path.join(REPO, "service_account.json"),
        scopes=[f"https://www.googleapis.com/auth/{scope}"])
    return gspread.authorize(creds).open_by_key(SHEET_ID)


def load_registry(sh):
    """الإتاحة A:B — one row per apartment+room, already maintained by hand."""
    reg = {}
    for r in sh.worksheet(AVAILABILITY_TAB).get("A5:B300"):
        if len(r) >= 2 and str(r[0]).strip() and str(r[1]).strip():
            reg.setdefault(str(r[0]).strip(), [])
            if str(r[1]).strip() not in reg[str(r[0]).strip()]:
                reg[str(r[0]).strip()].append(str(r[1]).strip())
    return reg


def load_bookings(sh):
    """Rows keyed by their true sheet row, skipping blanks and formula-only rows."""
    ws = sh.worksheet(BOOKINGS_TAB)
    # A:U, not A:T — column U carries the booking id, and the snapshot has to
    # record it or this script and the n8n node disagree about the same sheet
    # again (that cost three false-difference bugs on 2026-08-09).
    values = ws.get("A2:U990")
    formulas = ws.get("A2:U990", value_render_option="FORMULA")
    out = []
    for i, row in enumerate(values, start=2):
        name = cell(row, B["guest_name"])
        if not name:
            continue                        # formula-only tail rows
        frow = formulas[i - 2] if i - 2 < len(formulas) else []
        nights_raw = cell(row, B["nights"])
        # A live formula in عدد الليالي is what "open-ended" means in the sheet.
        is_open = str(cell(frow, B["nights"])).startswith("=")
        id_of, line_seq = parse_sheet_id(cell(row, 20))
        out.append({
            "sheet_row": i,
            "booking_ref": cell(row, B["booking_ref"]),
            "guest_ref": cell(row, B["guest_ref"]),
            "guest_name": name,
            "booking_type": cell(row, B["booking_type"]),
            "phone": cell(row, B["phone"]),
            "apartment": cell(row, B["apartment"]),
            "room": cell(row, B["room"]),
            "arrival": cell(row, B["arrival"]) if ISO.match(cell(row, B["arrival"])) else "",
            "nights": "" if is_open else nights_raw,
            # What the cell DISPLAYS, open-ended or not. `nights` above is the
            # modelled value and is deliberately blank on an open stay; this is
            # the evaluated one, and it is what the snapshot has to record —
            # `sheet_snapshot` means "what the sheet currently shows", and
            # `bookings_live.effective_nights` reproduces exactly that number
            # from the database side. Storing NULL here instead reported all
            # seven open stays as differing every run.
            "nights_shown": nights_raw,
            # Column U (index 20), the booking's database id. Blank on a row
            # nothing has stamped yet.
            "booking_id": cell(row, 20),
            # The same cell, read as an identity. `id_of` is the booking this
            # line belongs to and `line_seq` which of its lines this is.
            "id_of": id_of,
            "line_seq": line_seq,
            # A continuation line carries money and a method for a booking whose
            # own row is elsewhere, so it is not a booking: it must not be
            # inserted as one, snapshotted as one, or adopted as one.
            "is_payment_line": line_seq is not None and line_seq > 1,
            "is_open": is_open,
            "total": cell(row, B["total"]),
            "paid": cell(row, B["paid"]),
            "payment": cell(row, B["payment"]),
            "notes": cell(row, B["notes"]),
            # A hand-typed =500*I{row} is a nightly rate; keep the intent, and
            # keep the raw text for the ones no single rate can express.
            "nightly_rate": rate_and_adjustment(cell(frow, B["total"]))[0],
            # A lump sum written off the nightly rate — `-2200` in
            # `=(650*I18)-2200`. Kept apart from the rate so the database can
            # reproduce the sheet's own arithmetic on an open stay.
            "total_adjustment": rate_and_adjustment(cell(frow, B["total"]))[1],
            "total_formula": (cell(frow, B["total"])
                              if str(cell(frow, B["total"])).startswith("=") else ""),
            "segments": rate_segments(cell(frow, B["total"])),
            "cancelled": "ملغي" in cell(row, B["notes"]),
        })
    return out


def rate_segments(total_formula):
    """
    Split `=940*2+650*8` into [(940, 2), (650, 8)] — rate and nights per segment.

    A hand-typed total made of rate*nights terms is someone pricing a stay that
    changed partway through, because the guest moved room. It is a price agreed
    once, not a live calculation — the segments record how it was arrived at, and
    never override the total. Returns [] when the shape is anything else.
    """
    body = str(total_formula or "").strip().lstrip("=")
    if not body:
        return []
    terms = body.split("+")
    out = []
    for term in terms:
        m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*\*\s*(\d+)\s*$", term)
        if not m:
            return []                    # not a clean rate*nights sum; leave it alone
        out.append((m.group(1), int(m.group(2))))
    return out if len(out) > 1 else []


# `=500*I10`, and the same thing with a lump sum written off it:
# `=(650*I18)-2200`, a guest billed 650 a night less a 2200 credit.
RATE_FORMULA = re.compile(
    r"^=\s*\(?\s*(\d+(?:\.\d+)?)\s*\*\s*I\d+\s*\)?\s*(?:([-+])\s*(\d+(?:\.\d+)?)\s*)?$")


def rate_and_adjustment(total_formula):
    """`=(650*I18)-2200` in اجمالي سعر الحجز, as ('650', '-2200').

    The rate alone was not enough. Row 18 is billed 650 a night with 2200 taken
    off, and reading only the rate left the database recomputing 650 × nights —
    a figure 2200 short of what the sheet shows, growing by one night's drift
    every day. The daily reconcile reported it every morning, and a report that
    cries wolf daily is one nobody reads by the end of the week.
    """
    m = RATE_FORMULA.match(str(total_formula or "").strip())
    if not m:
        return "", ""
    rate, sign, offset = m.groups()
    return rate, ("" if offset is None else f"{'-' if sign == '-' else ''}{offset}")


def nightly_rate_of(total_formula):
    """`=500*I10` in اجمالي سعر الحجز means 500 a night. Preserve the rate."""
    return rate_and_adjustment(total_formula)[0]


def add_money(a, b):
    """Two money cells, summed, in the shape the rest of this file expects."""
    total = (numeric(a) or 0) + (numeric(b) or 0)
    return str(int(total)) if float(total).is_integer() else str(total)


def fold_lines(bookings, lines):
    """Each booking with the money from its continuation lines added in.

    مروان's stay is 600 on one row and 1600 on the next, and the stay really
    cost 2200. The database holds one booking, so it holds 2200 — and this is
    where that sum is made, because an --apply that wrote only the first line's
    total would silently undo the collapse every time it ran.

    Returns copies. The snapshot is built from the unfolded rows, since
    `reconcile_bookings` does its own folding and would count the money twice.
    """
    out = {b["sheet_row"]: dict(b) for b in bookings}
    by_id = {b["id_of"]: b for b in out.values() if b["id_of"]}
    for ln in lines:
        base = by_id.get(ln["id_of"])
        if base is None:
            continue        # a line naming no booking; reindex reports it
        base["total"] = add_money(base["total"], ln["total"])
        base["paid"] = add_money(base["paid"], ln["paid"])
    return [out[r] for r in sorted(out)]


def load_expenses(sh):
    ws = sh.worksheet(EXPENSES_TAB)
    out = []
    for i, row in enumerate(ws.get("A2:H500"), start=2):
        if not cell(row, E["item"]):
            continue
        out.append({
            "sheet_row": i,
            "spent_at": cell(row, E["spent_at"]),
            "item": cell(row, E["item"]),
            "amount": cell(row, E["amount"]),
            "apartment": cell(row, E["apartment"]),
            "notes": cell(row, E["notes"]),
            "payment": cell(row, E["payment"]),
            "responsible": cell(row, E["responsible"]),
            "expense_ref": cell(row, E["expense_ref"]),
        })
    return out


def build_sql(reg, bookings, expenses):
    out = ["-- generated by supabase/backfill.py — safe to re-run", "begin;", ""]

    out.append("-- registry, from الإتاحة")
    for apt, rooms in reg.items():
        out.append(f"insert into apartments (name) values ({q(apt)}) "
                   f"on conflict (name) do nothing;")
        for room in rooms:
            out.append(
                f"insert into rooms (apartment_id, number) "
                f"select id, {q(room)} from apartments where name = {q(apt)} "
                f"on conflict (apartment_id, number) do nothing;")
    out.append("")

    out.append("-- bookings")
    for b in bookings:
        room_sql = "NULL"
        if b["apartment"] and b["room"]:
            room_sql = (f"(select r.id from rooms r join apartments a on a.id = r.apartment_id "
                        f"where a.name = {q(b['apartment'])} and r.number = {q(b['room'])})")
        out.append(
            "insert into bookings (sheet_row, booking_ref, guest_ref, guest_name, "
            "booking_type, phone, room_id, apartment_name, room_number, arrival, nights, open_ended, "
            "nightly_rate, total_adjustment, total, total_formula, paid, payment_method, notes, "
            "cancelled_at, source) values ("
            f"{b['sheet_row']}, {q(b['booking_ref'])}, {q(b['guest_ref'])}, {q(b['guest_name'])}, "
            f"{q(b['booking_type'])}, {q(b['phone'])}, {room_sql}, {q(b['apartment'])}, "
            f"{q(b['room'])}, {q(b['arrival'])}::date, {qnum(b['nights'])}, "
            f"{'true' if b['is_open'] else 'false'}, "
            f"{qnum(b['nightly_rate'])}, {qnum(b['total_adjustment'])}, "
            f"{qnum(b['total'])}, {q(b['total_formula'])}, "
            f"coalesce({qnum(b['paid'])}, 0), "
            f"{q(b['payment'])}, {q(b['notes'])}, "
            f"{'now()' if b['cancelled'] else 'NULL'}, 'backfill')\n"
            "on conflict (sheet_row) do update set "
            "booking_ref = excluded.booking_ref, guest_ref = excluded.guest_ref, "
            "guest_name = excluded.guest_name, booking_type = excluded.booking_type, "
            "phone = excluded.phone, room_id = excluded.room_id, "
            "apartment_name = excluded.apartment_name, room_number = excluded.room_number, "
            "arrival = excluded.arrival, nights = excluded.nights, "
            "open_ended = excluded.open_ended, "
            "nightly_rate = excluded.nightly_rate, "
            "total_adjustment = excluded.total_adjustment, total = excluded.total, "
            "total_formula = excluded.total_formula, "
            "paid = excluded.paid, payment_method = excluded.payment_method, "
            "notes = excluded.notes, cancelled_at = excluded.cancelled_at, "
            "updated_at = now();")
    out.append("")

    out.append("-- expenses")
    for e in expenses:
        out.append(
            "insert into expenses (sheet_row, expense_ref, item, amount, apartment_id, "
            "apartment_name, notes, payment_method, responsible, spent_at, source) values ("
            f"{e['sheet_row']}, {q(e['expense_ref'])}, {q(e['item'])}, {qnum(e['amount'])}, "
            f"(select id from apartments where name = {q(e['apartment'])}), "
            f"{q(e['apartment'])}, {q(e['notes'])}, {q(e['payment'])}, {q(e['responsible'])}, "
            f"{q(e['spent_at'])}::timestamptz, 'backfill')\n"
            "on conflict (sheet_row) do update set "
            "apartment_id = excluded.apartment_id, "
            "expense_ref = excluded.expense_ref, item = excluded.item, "
            "amount = excluded.amount, apartment_name = excluded.apartment_name, "
            "notes = excluded.notes, payment_method = excluded.payment_method, "
            "responsible = excluded.responsible, spent_at = excluded.spent_at;")

    out.append("")
    out.append("-- stay segments, for bookings that changed room or rate mid-stay")
    for b in bookings:
        if not b["segments"]:
            continue
        out.append(f"delete from booking_stays where booking_id = "
                   f"(select id from bookings where sheet_row = {b['sheet_row']});")
        day = 0
        for seq, (rate, nights) in enumerate(b["segments"], start=1):
            last = seq == len(b["segments"])
            # Only the final segment can still be running.
            open_seg = "true" if (last and b["is_open"]) else "false"
            # The earlier room is not in the sheet and the user has confirmed it
            # does not matter; the rate history is the part worth keeping.
            note = ("earlier room not recorded, and not needed"
                    if not last else "current room, as recorded in the sheet")
            room_sql = ("NULL" if not last else
                        (f"(select r.id from rooms r join apartments a on a.id = r.apartment_id "
                         f"where a.name = {q(b['apartment'])} and r.number = {q(b['room'])})"
                         if b["apartment"] and b["room"] else "NULL"))
            out.append(
                "insert into booking_stays (booking_id, seq, room_id, apartment_name, "
                "room_number, from_date, nights, open_ended, nightly_rate, note) "
                f"select id, {seq}, {room_sql}, "
                f"{q(b['apartment']) if last else 'NULL'}, "
                f"{q(b['room']) if last else 'NULL'}, "
                f"{q(b['arrival'])}::date + {day}, {nights}, {open_seg}, {rate}, {q(note)} "
                f"from bookings where sheet_row = {b['sheet_row']} "
                "on conflict (booking_id, seq) do update set "
                "nights = excluded.nights, nightly_rate = excluded.nightly_rate, "
                "open_ended = excluded.open_ended, note = excluded.note;")
            day += nights

    out += ["", "commit;"]
    return "\n".join(out)


def report(reg, bookings, expenses):
    print(f"registry:  {len(reg)} apartments, {sum(len(v) for v in reg.values())} rooms")
    print(f"bookings:  {len(bookings)}")
    print(f"expenses:  {len(expenses)}\n")

    def flag(label, rows):
        if rows:
            print(f"  {label:34} {len(rows):3}  rows {[r['sheet_row'] for r in rows][:8]}")

    print("rows that a stricter schema would reject (accepted for now, on purpose):")
    flag("no room", [b for b in bookings if not b["room"]])
    flag("no apartment", [b for b in bookings if not b["apartment"]])
    flag("no arrival date", [b for b in bookings if not b["arrival"]])
    flag("no guest ref (ID)", [b for b in bookings if not b["guest_ref"]])
    off = [b for b in bookings if b["apartment"] and b["apartment"] not in reg]
    flag("apartment not in الإتاحة", off)
    bad = [b for b in bookings
           if b["apartment"] in reg and b["room"] and b["room"] not in reg[b["apartment"]]]
    flag("room not in الإتاحة", bad)

    seen = {}
    for b in bookings:
        if b["guest_ref"]:
            seen.setdefault(b["guest_ref"], []).append(b["sheet_row"])
    dup = {k: v for k, v in seen.items() if len(v) > 1}
    if dup:
        print(f"  {'duplicate guest refs':34} {len(dup):3}  {dup}")

    print()
    print(f"open-ended stays:            {len([b for b in bookings if b['is_open']])}")
    rates = [b for b in bookings if b["nightly_rate"]]
    print(f"nightly-rate formulas kept:  {len(rates)} "
          f"{[(b['sheet_row'], b['nightly_rate']) for b in rates]}")
    multi = [b for b in bookings if b["segments"]]
    if multi:
        print("bookings split across rooms/rates (modelled in booking_stays):")
        for b in multi:
            print(f"    row {b['sheet_row']}: {b['total_formula']} -> "
                  + " + ".join(f"{n}n @ {r}" for r, n in b["segments"]))
    odd = [b for b in bookings
           if b["total_formula"] and not b["nightly_rate"] and not b["segments"]]
    if odd:
        print("hand-entered totals in a shape nothing understands (value kept as-is):")
        for b in odd:
            print(f"    row {b['sheet_row']}: {b['total_formula']}")
    print(f"cancelled:                   {len([b for b in bookings if b['cancelled']])}")


def main():
    # Every guest name, apartment and note in this data is Arabic, and a Windows
    # console defaults to cp1252, which cannot encode any of it. Without this the
    # reconcile does its work and then dies printing the answer.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--reconcile", action="store_true")
    args = ap.parse_args()

    sh = open_sheet()
    reg = load_registry(sh)
    # A continuation line is money, not a booking. Left in, every one of them
    # would be inserted as a booking of its own on the next --apply, and then
    # reported as an extra guest by every reconcile afterwards.
    rows = load_bookings(sh)
    lines = [b for b in rows if b["is_payment_line"]]
    bookings = fold_lines([b for b in rows if not b["is_payment_line"]], lines)
    expenses = load_expenses(sh)

    report(reg, bookings, expenses)
    if lines:
        print(f"payment lines (not bookings):  {len(lines)}")
        for b in lines:
            print(f"    row {b['sheet_row']}: {b['booking_id']} — "
                  f"{b['paid']} {b['payment']}")
        print()
    sql = build_sql(reg, bookings, expenses)

    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(sql + "\n")
        print(f"\nwrote {args.out} ({len(sql.splitlines())} lines)")
    if args.dry_run and not args.out:
        print("\n" + "\n".join(sql.splitlines()[:40]) + "\n  …")

    if args.apply or args.reconcile:
        try:
            import psycopg
        except ImportError:
            sys.exit("pip install 'psycopg[binary]'")
        with psycopg.connect(**connect_args()) as conn:
            if args.apply:
                with conn.cursor() as cur:
                    cur.execute(sql)
                print("applied")
            if args.reconcile:
                with conn.cursor() as cur:
                    cur.execute("truncate sheet_snapshot;")
                    # Every line, continuation lines included. They are not
                    # bookings, but they hold part of a booking's money, and
                    # `reconcile_bookings` folds them back in before comparing —
                    # leave them out and every booking that was paid twice looks
                    # short by the amount on its second line.
                    for b in rows:
                        cur.execute(
                            "insert into sheet_snapshot (sheet_row, guest_name, apartment_name,"
                            " room_number, arrival, nights, total, paid, payment_method, notes,"
                            " booking_id, line_seq) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                            (b["sheet_row"], text_or_none(b["guest_name"]),
                             text_or_none(b["apartment"]), text_or_none(b["room"]),
                             b["arrival"] or None, numeric(b["nights_shown"]),
                             numeric(b["total"]), numeric(b["paid"]),
                             text_or_none(b["payment"]), text_or_none(b["notes"]),
                             b["id_of"], b["line_seq"]))
                    cur.execute("select * from reconcile_bookings order by sheet_row;")
                    rows = cur.fetchall()
                print(f"\nreconcile: {len(rows)} discrepancies")
                for r in rows[:20]:
                    print("  ", r)


if __name__ == "__main__":
    main()
