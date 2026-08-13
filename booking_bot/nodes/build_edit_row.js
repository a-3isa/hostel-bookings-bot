/**
 * Flattens an edit/cancel save into one item for the Google Sheets `update` node.
 *
 * Unlike the append path there is no row arithmetic here — the row came from the
 * lookup. Only the columns the user actually changed are emitted, and the write
 * node uses autoMapInputData, so every other column (including the formula
 * columns K, N, P, R, S, T) is left untouched. Writing an unchanged value back
 * would be wrong for عدد الليالي in particular: the sheet may hold a live
 * =TODAY()-J{row} formula there and reading it back gives only its result.
 */

const save = $('Brain').first().json.save;

// The sheet's own calculated columns. Nothing this bot writes may ever name
// one: writing a value — even '' — replaces the formula with a dead number, and
// the Dashboard and every per-property tab read them.
//
// This is a hard filter rather than a convention. The Brain is careful today,
// but "careful" is what every one of these columns had before it was found
// empty, and a guard costs one line where an audit costs an afternoon.
const FORMULA_COLS = [
  'تاريخ المغادرة',   // K = J + I
  'نسبة البرنامج',    // N
  'المتبقي',          // P = L - M
  'تاريخ الإدخال',    // R
  'صافي الدخل',       // S = L - N
  'آخر تعديل',        // T
];

const fields = {};
for (const k of Object.keys(save.fields || {})) {
  if (FORMULA_COLS.indexOf(k) !== -1) continue;
  fields[k] = save.fields[k];
}

return [{ json: { row_number: save.row, ...fields } }];
