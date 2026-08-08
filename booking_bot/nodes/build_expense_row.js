/**
 * Same as Build Booking Row, for the expense tab. The key column is B (البند),
 * which is typed in by hand and carries no formula.
 */

const save = $('Brain').first().json.save;

const rows = $input.all().filter(i => i.json && Object.keys(i.json).length > 0);
const r = rows.length + 2;

const out = { row_number: r };
for (const k of Object.keys(save.fields)) {
  const v = save.fields[k];
  out[k] = typeof v === 'string' ? v.replace(/\{r\}/g, String(r)) : v;
}

return [{ json: out }];
