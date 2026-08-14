/**
 * The `payment_line` flow: a payment in a method the booking's own row does not
 * carry. Emits the row(s) for one Google Sheets `update` call.
 *
 * Two items at most, and both are updates — nothing here appends:
 *
 *   1. the LINE. Either a row this branch has just inserted under the booking's
 *      block, or one that already carries this method and whose total simply
 *      grows.
 *   2. the BOOKING's own row, when something on it changed — the total reduced
 *      by what the line takes, plus anything else the admin edited in the same
 *      session. Absent when neither applies.
 *
 * The order matters. The line is written first because it is the row that may
 * have just been created empty; if the booking row update failed on its own,
 * the money would still be on the sheet.
 */

const save = $('Brain').first().json.save;
const items = [];

const line = { row_number: save.row };
for (const k of Object.keys(save.fields || {})) {
  const v = save.fields[k];
  // '=TODAY()-J{r}' on an open-ended stay: the line counts its own nights from
  // its own row, so {r} is this row and not the booking's.
  line[k] = typeof v === 'string' ? v.replace(/\{r\}/g, String(save.row)) : v;
}
items.push({ json: line });

if (save.bookingFields && Object.keys(save.bookingFields).length) {
  const booking = { row_number: save.bookingRow };
  for (const k of Object.keys(save.bookingFields)) {
    const v = save.bookingFields[k];
    booking[k] = typeof v === 'string'
      ? v.replace(/\{r\}/g, String(save.bookingRow)) : v;
  }
  items.push({ json: booking });
}

return items;
