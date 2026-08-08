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


def cell(row, idx):
    row = list(row) + [""] * 24
    return str(row[idx]).strip()


def open_sheet():
    creds = Credentials.from_service_account_file(
        os.path.join(REPO, "service_account.json"),
        scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
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
    values = ws.get("A2:T990")
    formulas = ws.get("A2:T990", value_render_option="FORMULA")
    out = []
    for i, row in enumerate(values, start=2):
        name = cell(row, B["guest_name"])
        if not name:
            continue                        # formula-only tail rows
        frow = formulas[i - 2] if i - 2 < len(formulas) else []
        nights_raw = cell(row, B["nights"])
        # A live formula in عدد الليالي is what "open-ended" means in the sheet.
        is_open = str(cell(frow, B["nights"])).startswith("=")
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
            "is_open": is_open,
            "total": cell(row, B["total"]),
            "paid": cell(row, B["paid"]),
            "payment": cell(row, B["payment"]),
            "notes": cell(row, B["notes"]),
            # A hand-typed =500*I{row} is a nightly rate; keep the intent, and
            # keep the raw text for the ones no single rate can express.
            "nightly_rate": nightly_rate_of(cell(frow, B["total"])),
            "total_formula": (cell(frow, B["total"])
                              if str(cell(frow, B["total"])).startswith("=") else ""),
            "cancelled": "ملغي" in cell(row, B["notes"]),
        })
    return out


def nightly_rate_of(total_formula):
    """`=500*I10` in اجمالي سعر الحجز means 500 a night. Preserve the rate."""
    m = re.match(r"^=\s*(\d+(?:\.\d+)?)\s*\*\s*I\d+\s*$", str(total_formula or "").strip())
    return m.group(1) if m else ""


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
            "booking_type, phone, room_id, apartment_name, room_number, arrival, nights, "
            "nightly_rate, total, total_formula, paid, payment_method, notes, cancelled_at, "
            "source) values ("
            f"{b['sheet_row']}, {q(b['booking_ref'])}, {q(b['guest_ref'])}, {q(b['guest_name'])}, "
            f"{q(b['booking_type'])}, {q(b['phone'])}, {room_sql}, {q(b['apartment'])}, "
            f"{q(b['room'])}, {q(b['arrival'])}::date, {qnum(b['nights'])}, "
            f"{qnum(b['nightly_rate'])}, {qnum(b['total'])}, {q(b['total_formula'])}, "
            f"coalesce({qnum(b['paid'])}, 0), "
            f"{q(b['payment'])}, {q(b['notes'])}, "
            f"{'now()' if b['cancelled'] else 'NULL'}, 'backfill')\n"
            "on conflict (sheet_row) do update set "
            "booking_ref = excluded.booking_ref, guest_ref = excluded.guest_ref, "
            "guest_name = excluded.guest_name, booking_type = excluded.booking_type, "
            "phone = excluded.phone, room_id = excluded.room_id, "
            "apartment_name = excluded.apartment_name, room_number = excluded.room_number, "
            "arrival = excluded.arrival, nights = excluded.nights, "
            "nightly_rate = excluded.nightly_rate, total = excluded.total, "
            "total_formula = excluded.total_formula, "
            "paid = excluded.paid, payment_method = excluded.payment_method, "
            "notes = excluded.notes, cancelled_at = excluded.cancelled_at, "
            "updated_at = now();")
    out.append("")

    out.append("-- expenses")
    for e in expenses:
        out.append(
            "insert into expenses (sheet_row, expense_ref, item, amount, apartment_name, "
            "notes, payment_method, responsible, spent_at, source) values ("
            f"{e['sheet_row']}, {q(e['expense_ref'])}, {q(e['item'])}, {qnum(e['amount'])}, "
            f"{q(e['apartment'])}, {q(e['notes'])}, {q(e['payment'])}, {q(e['responsible'])}, "
            f"{q(e['spent_at'])}::timestamptz, 'backfill')\n"
            "on conflict (sheet_row) do update set "
            "expense_ref = excluded.expense_ref, item = excluded.item, "
            "amount = excluded.amount, apartment_name = excluded.apartment_name, "
            "notes = excluded.notes, payment_method = excluded.payment_method, "
            "responsible = excluded.responsible, spent_at = excluded.spent_at;")

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
    odd = [b for b in bookings if b["total_formula"] and not b["nightly_rate"]]
    if odd:
        print("hand-entered totals with no single rate (value kept, text preserved):")
        for b in odd:
            print(f"    row {b['sheet_row']}: {b['total_formula']}  "
                  f"{'OPEN — needs a rate!' if b['is_open'] else 'closed, fixed total, fine'}")
    print(f"cancelled:                   {len([b for b in bookings if b['cancelled']])}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--reconcile", action="store_true")
    args = ap.parse_args()

    sh = open_sheet()
    reg = load_registry(sh)
    bookings = load_bookings(sh)
    expenses = load_expenses(sh)

    report(reg, bookings, expenses)
    sql = build_sql(reg, bookings, expenses)

    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(sql + "\n")
        print(f"\nwrote {args.out} ({len(sql.splitlines())} lines)")
    if args.dry_run and not args.out:
        print("\n" + "\n".join(sql.splitlines()[:40]) + "\n  …")

    if args.apply or args.reconcile:
        url = os.environ.get("SUPABASE_DB_URL")
        if not url:
            sys.exit("SUPABASE_DB_URL is not set — see supabase/README.md")
        try:
            import psycopg
        except ImportError:
            sys.exit("pip install 'psycopg[binary]'")
        with psycopg.connect(url) as conn:
            if args.apply:
                with conn.cursor() as cur:
                    cur.execute(sql)
                print("applied")
            if args.reconcile:
                with conn.cursor() as cur:
                    cur.execute("truncate sheet_snapshot;")
                    for b in bookings:
                        cur.execute(
                            "insert into sheet_snapshot (sheet_row, guest_name, apartment_name,"
                            " room_number, arrival, nights, total, paid, payment_method, notes)"
                            " values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                            (b["sheet_row"], b["guest_name"], b["apartment"], b["room"],
                             b["arrival"] or None, b["nights"] or None, b["total"] or None,
                             b["paid"] or None, b["payment"], b["notes"]))
                    cur.execute("select * from reconcile_bookings order by sheet_row;")
                    rows = cur.fetchall()
                print(f"\nreconcile: {len(rows)} discrepancies")
                for r in rows[:20]:
                    print("  ", r)


if __name__ == "__main__":
    main()
