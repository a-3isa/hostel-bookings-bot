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

/** One row's changed columns, with the sheet's own kept out of reach. */
function rowItem(rowNumber, raw) {
  const fields = {};
  for (const k of Object.keys(raw || {})) {
    if (FORMULA_COLS.indexOf(k) !== -1) continue;
    fields[k] = raw[k];
  }
  return { json: { row_number: rowNumber, ...fields } };
}

const items = [rowItem(save.row, save.fields)];

// A cancellation covers every row the booking occupies, not just its own — see
// `lineRows` in brain.js. Nothing else emits them, so an ordinary edit is one
// item exactly as before.
for (const line of save.lineRows || []) {
  if (Number(line.row) > 0) items.push(rowItem(Number(line.row), line.fields));
}

return items;
