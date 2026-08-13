"""Write each booking's database id into the spreadsheet, column U.

This is the stable key the migration has been missing. `sheet_row` cannot be
one: inserting a row renumbers every row beneath it, which is exactly what made
the first live reconcile report 26 differences that were not real.

Column U is chosen because the sheet is 27 columns wide and everything from U
rightwards was verified empty on 2026-08-09. Nothing shifts, no formula moves —
the 1,606 formulas in other tabs all address A–T — and the column can be cleared
again with no loss if this is ever unwound.

Once it is populated the mirror can tell its own rows from a human's, which is
what lets a hand-inserted row be ADOPTED into the database instead of silently
overwritten. That was the user's own question about option 1, and this is the
half of the answer that makes it safe.

    python supabase/write_sheet_ids.py            # report what it would write
    python supabase/write_sheet_ids.py --apply    # write column U
"""

import sys

import psycopg

from backfill import BOOKINGS_TAB, connect_args, open_sheet

ID_COL = "U"
ID_HEADER = "معرف النظام"


def db_ids():
    """sheet_row -> booking id, for every row the database knows about."""
    with psycopg.connect(**connect_args()) as conn, conn.cursor() as cur:
        cur.execute(
            "select sheet_row, id from bookings where sheet_row is not null"
            " order by sheet_row;")
        return dict(cur.fetchall())


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    apply = "--apply" in sys.argv
    ids = db_ids()
    if not ids:
        sys.exit("no bookings carry a sheet_row — nothing to key")

    # The only tool in this directory that asks for a writable token.
    ws = open_sheet(writable=apply).worksheet(BOOKINGS_TAB)
    last = max(ids)

    # Never blind-write: read what is there first. A non-empty cell that
    # disagrees with the database means someone has been in this column, and
    # that is a conversation, not something to overwrite.
    existing = ws.get(f"{ID_COL}1:{ID_COL}{last}")
    existing += [[]] * (last - len(existing))
    clashes = []
    for row in range(2, last + 1):
        was = (existing[row - 1] or [""])[0]
        was = str(was).strip()
        if was and was != str(ids.get(row, "")):
            clashes.append((row, was, ids.get(row)))

    # Row 1 is the header; rows the database does not know stay blank rather
    # than being given an id they have no business having.
    values = [[ID_HEADER]]
    for row in range(2, last + 1):
        values.append([str(ids[row])] if row in ids else [""])

    print(f"{BOOKINGS_TAB}: column {ID_COL}, rows 1–{last}")
    print(f"  ids to write:   {len(ids)}")
    print(f"  blanks left:    {last - 1 - len(ids)}")
    print(f"  existing clashes: {len(clashes)}")
    for row, was, now in clashes[:10]:
        print(f"    row {row}: sheet has {was!r}, db says {now}")

    if clashes and "--force" not in sys.argv:
        sys.exit("refusing to overwrite a column somebody else is using"
                 " — pass --force if the DATABASE mapping is the right one")
    if clashes:
        # After a row insert the stamps are one row out of step with the data,
        # and reindex.py trusts U — so it re-points the database to match stale
        # stamps and the two fight. The way out is to declare a winner. The
        # sheet's CONTENT is authoritative, the database has been synced to it
        # row by row, and U is bookkeeping the bot owns: so U is what gets
        # corrected, deliberately and only when asked.
        print(f"--force: overwriting {len(clashes)} stale stamp(s)")
    if not apply:
        print("\ndry run — pass --apply to write")
        return

    ws.update(values=values, range_name=f"{ID_COL}1:{ID_COL}{last}",
              value_input_option="RAW")
    print(f"\nwrote {ID_COL}1:{ID_COL}{last}")


if __name__ == "__main__":
    main()
