/**
 * Same as Build Booking Row, for the expense tab.
 *
 * The read is A2:H2000 — every hand-typed column, not just B البند. On
 * 2026-08-14 the bot wrote an expense straight over a row somebody had typed by
 * hand, because that row had no البند: the count said seventeen rows, the row
 * was the eighteenth, and the write landed on it. The expense tab has no
 * formula columns, so every column here is evidence that a row is occupied.
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

// The LAST occupied row, not how many there are. Counting assumes the rows are
// contiguous and that every one of them is visible in the range being read;
// neither is true of a sheet people edit by hand.
const numbered = rows
  .map((i) => Number(i.json.row_number))
  .filter((n) => Number.isFinite(n));
const r = numbered.length ? Math.max(...numbered) + 1 : rows.length + 2;

const out = { row_number: r };
for (const k of Object.keys(save.fields)) {
  const v = save.fields[k];
  out[k] = typeof v === 'string' ? v.replace(/\{r\}/g, String(r)) : v;
}

return [{ json: out }];
