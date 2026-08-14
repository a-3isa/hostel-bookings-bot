/**
 * Turns the Brain's named save.fields into one flat row for the Google Sheets
 * `update` node, and works out which row to write.
 *
 * The read is A2:J2000: every column up to تاريخ البداية, all of them typed.
 * It stops at J on purpose — K, N, P, R, S and T carry fill-down formulas that
 * evaluate to '' on empty rows, and a blank row that answers '' would be read
 * as occupied and push every write to the bottom of the sheet.
 *
 * It used to read C اسم المقيم alone and COUNT what came back. On 2026-08-14
 * that wrote an expense over a hand-typed row on the other tab, for the exact
 * reason it could here too: a row whose key column is empty is a row the count
 * cannot see, and the next save lands on top of it.
 */

const save = $('Brain').first().json.save;

// alwaysOutputData is on for the read, so an empty sheet arrives as a single
// blank item. `row_number` is the sheet's own row and is always present, so a
// row is "occupied" only if something OTHER than that has a value.
const rows = $input.all().filter((i) => {
  if (!i.json) return false;
  return Object.keys(i.json).some(
    (k) => k !== 'row_number' && i.json[k] !== '' && i.json[k] != null,
  );
});

// The LAST occupied row, not how many there are.
const numbered = rows
  .map((i) => Number(i.json.row_number))
  .filter((n) => Number.isFinite(n));
const r = numbered.length ? Math.max(...numbered) + 1 : rows.length + 2;

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

return [{ json: out }];
