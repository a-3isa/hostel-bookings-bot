/**
 * Turns the Brain's named save.fields into one flat row for the Google Sheets
 * `update` node, and works out which row to write.
 *
 * The row comes from the Sheets API's own `values` array — A1:J2000, read by
 * "Read Booking Key". Its length IS the last occupied row: the API trims
 * trailing empty rows, keeps interior blanks as empty arrays, and counts from
 * row 1. So the next free row is one below it, and nothing here has to guess
 * what n8n considered a header or how it numbered what it returned.
 *
 * Both earlier attempts got that wrong in the same place. Counting the items a
 * Sheets node returned wrote an expense over a hand-typed row on 2026-08-14 —
 * that row's key column was empty, so the count never saw it. Taking
 * max(row_number) + 1 instead was one short, because the node numbers rows from
 * its own view of the range and not the sheet's: it wrote over the last row of
 * both tabs, reported 2026-08-15.
 *
 * The range stops at J deliberately. K, N, P, R, S and T carry fill-down
 * formulas that evaluate to '' far below the data, and a row answering '' would
 * count as occupied — every write would land at the bottom of the sheet.
 */

const save = $('Brain').first().json.save;

/** The first free row, from whichever shape the read produced. */
function nextRow() {
  const items = $input.all();
  const head = items.length ? items[0].json : null;

  // The Sheets API response. `values` is absent entirely on an empty tab.
  if (head && Object.prototype.hasOwnProperty.call(head, 'range')) {
    return (Array.isArray(head.values) ? head.values.length : 0) + 1;
  }

  // Fallback: a Sheets node's items, one per row. Only reachable if the read is
  // swapped back; kept so a half-applied deploy appends below the data rather
  // than into the middle of it.
  const rows = items.filter((i) => {
    if (!i.json) return false;
    return Object.keys(i.json).some(
      (k) => k !== 'row_number' && i.json[k] !== '' && i.json[k] != null,
    );
  });
  const numbered = rows
    .map((i) => Number(i.json.row_number))
    .filter((n) => Number.isFinite(n));
  return numbered.length ? Math.max(...numbered) + 1 : rows.length + 2;
}

const r = nextRow();

// The sheet's own calculated columns. Never written, on any path: a value —
// even '' — replaces the formula with a dead number, and the Dashboard and the
// per-property tabs all read them. A hard filter, not a convention.
const FORMULA_COLS = [
  'تاريخ المغادرة',   // K = J + I
  'نسبة البرنامج',    // N
  'المتبقي',          // P = L - M
  'تاريخ الإدخال',    // R
  'صافي الدخل',       // S = L - N
  'آخر تعديل',        // T
];

const out = { row_number: r };
for (const k of Object.keys(save.fields)) {
  if (FORMULA_COLS.indexOf(k) !== -1) continue;
  const v = save.fields[k];
  // e.g. the open-ended nights cell '=TODAY()-J{r}'
  out[k] = typeof v === 'string' ? v.replace(/\{r\}/g, String(r)) : v;
}

/**
 * P المتبقي — the sheet's own FORMULA, written by us. Never a number.
 *
 * P is still off-limits to `save.fields` (the filter above), and for the same
 * reason as ever: a computed value written into P is dead the moment the next
 * payment lands, and the Dashboard and every per-property tab read P expecting
 * it to track L − M.
 *
 * What changed is who puts the formula there. It used to be the sheet's own
 * fill-down, and a fill-down only reaches as far as somebody once dragged it —
 * measured 2026-09-21, it stops at row 89 while the last booking is on row 88.
 * The very next booking is fine and the one after it gets a permanently blank
 * P, which is the "rows whose calculated columns are empty" that
 * `supabase/heal_formulas.py` exists to repair after the fact.
 *
 * So the row carries its own formula down with it. The text is the sheet's,
 * copied off a healthy row, not an invention: the IF(C…) guard is what keeps a
 * half-written row from showing a stray 0, and the IFERROR keeps a non-numeric
 * L (a mixed-currency note, say) from spreading #VALUE! across the tab.
 *
 * N نسبة البرنامج, S صافي الدخل, R تاريخ الإدخال and T آخر تعديل still depend on
 * the fill-down and still need `heal_formulas.py`. Only P was asked for; each of
 * the others has a different pattern and one of them (N) branches on نوع الحجز.
 */
out['المتبقي'] = '=IF(C{r}="","",IFERROR(L{r}-M{r},""))'.replace(/\{r\}/g, String(r));

return [{ json: out }];
