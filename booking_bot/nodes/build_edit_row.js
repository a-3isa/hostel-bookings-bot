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

return [{ json: { row_number: save.row, ...save.fields } }];
