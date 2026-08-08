/**
 * Turns the Brain's named save.fields into one flat row for the Google Sheets
 * `update` node, and works out which row to write.
 *
 * The key column carries no fill-down formula, so its length is the true last
 * data row (same trick as sheets.append_booking_input in the Python bot).
 * Row 1 is the header, hence + 2.
 */

const save = $('Brain').first().json.save;

// alwaysOutputData is on for the read, so an empty sheet arrives as a single
// blank item — drop it before counting or every row would be off by one.
const rows = $input.all().filter(i => i.json && Object.keys(i.json).length > 0);
const r = rows.length + 2;

const out = { row_number: r };
for (const k of Object.keys(save.fields)) {
  const v = save.fields[k];
  // e.g. the open-ended nights cell '=TODAY()-J{r}'
  out[k] = typeof v === 'string' ? v.replace(/\{r\}/g, String(r)) : v;
}

return [{ json: out }];
