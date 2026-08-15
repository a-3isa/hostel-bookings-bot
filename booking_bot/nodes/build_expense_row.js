/**
 * Same as Build Booking Row, for the expense tab: A1:H2000, every column of it
 * hand-typed, so any cell in a row makes that row occupied.
 *
 * The row is `values.length + 1` — the Sheets API counts from row 1 and trims
 * only the empty tail, so its length is the last occupied row whatever state
 * the tab is in. See build_booking_row.js for the two ways this was got wrong
 * before, both of which wrote on top of somebody's data.
 */

const save = $('Brain').first().json.save;

function nextRow() {
  const items = $input.all();
  const head = items.length ? items[0].json : null;

  if (head && Object.prototype.hasOwnProperty.call(head, 'range')) {
    return (Array.isArray(head.values) ? head.values.length : 0) + 1;
  }

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

const out = { row_number: r };
for (const k of Object.keys(save.fields)) {
  const v = save.fields[k];
  out[k] = typeof v === 'string' ? v.replace(/\{r\}/g, String(r)) : v;
}

return [{ json: out }];
