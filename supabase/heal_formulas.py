"""Put back the sheet formulas that go missing from K, N, P, R and S.

Reported repeatedly: rows appear whose calculated columns are blank. Measured on
2026-08-11, rows 62 and 63 had N نسبة البرنامج, P المتبقي, R تاريخ الإدخال and
S صافي الدخل empty while rows 61 and 64 had them. K survives everywhere because
it is an array formula; the other four are per-row and do not regenerate.

Two things produce that, and this repairs both without needing to know which:

  * a writer that sends a full-width row — Google's `append` blanks every column
    the mapping does not mention;
  * the fill-down simply running out, because those formulas only exist as far
    down as somebody once dragged them.

The pattern is taken from a healthy row rather than hard-coded, so it survives
the formulas being edited: whatever row 3 does with its own row number, every
other row is made to do with its own. Read-only unless --apply.

    python supabase/heal_formulas.py            # report
    python supabase/heal_formulas.py --apply    # restore
"""

import re
import sys

from backfill import BOOKINGS_TAB, open_sheet

# Per-row calculated columns. K is deliberately absent: it is an array formula
# owned by its header cell, and writing per-row formulas into it would fight it.
HEAL = {"N": 13, "P": 15, "S": 18}
NAME_IDX = 2                       # C اسم المقيم — a row with a guest is a real row
DONOR_MIN = 3                      # never learn the pattern from the header


def retarget(formula, from_row, to_row):
    """The same formula, pointing at its own row.

    A1 references carrying an explicit row (L12, $M12) are moved; anything
    absolute in both parts ($M$3), or a function name that happens to look like
    a reference, is left alone.
    """
    def sub(m):
        col, dollar, row = m.group(1), m.group(2), m.group(3)
        if dollar or int(row) != from_row:
            return m.group(0)
        return f"{col}{to_row}"

    return re.sub(r"(\$?[A-Z]{1,2})(\$?)(\d+)", lambda m: sub(m), formula)


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    apply = "--apply" in sys.argv
    ws = open_sheet(writable=apply).worksheet(BOOKINGS_TAB)
    grid = ws.get("A1:U990", value_render_option="FORMULA")

    def cell(row_cells, idx):
        return str(row_cells[idx]).strip() if row_cells and idx < len(row_cells) else ""

    # Rows that carry a guest name are the ones that should be calculating.
    data_rows = [i for i, cells in enumerate(grid, start=1)
                 if i > 1 and cell(cells, NAME_IDX)]

    donors = {}
    for letter, idx in HEAL.items():
        for i in data_rows:
            if i < DONOR_MIN:
                continue
            f = cell(grid[i - 1], idx)
            if f.startswith("="):
                donors[letter] = (i, f)
                break

    missing = {letter: [] for letter in HEAL}
    for i in data_rows:
        for letter, idx in HEAL.items():
            if not cell(grid[i - 1], idx).startswith("="):
                missing[letter].append(i)

    total = sum(len(v) for v in missing.values())
    print(f"{BOOKINGS_TAB}: {len(data_rows)} rows with a guest name")
    for letter, idx in HEAL.items():
        donor = donors.get(letter)
        src = f"from row {donor[0]}: {donor[1]}" if donor else "NO DONOR FOUND"
        print(f"  {letter}: {len(missing[letter])} row(s) missing   {src}")
        if missing[letter]:
            print(f"      {missing[letter][:15]}")
    print(f"  total cells to restore: {total}")

    if not total:
        print("nothing to heal")
        return
    absent = [c for c in HEAL if c not in donors and missing[c]]
    if absent:
        sys.exit(f"refusing to guess: no formula to copy for column(s) {absent}")
    if not apply:
        print("\ndry run — pass --apply to restore")
        return

    batch = []
    for letter, rows in missing.items():
        donor_row, donor_formula = donors[letter]
        for i in rows:
            batch.append({"range": f"{letter}{i}",
                          "values": [[retarget(donor_formula, donor_row, i)]]})
    ws.batch_update(batch, value_input_option="USER_ENTERED")
    print(f"\nrestored {len(batch)} formula cell(s)")


if __name__ == "__main__":
    main()
