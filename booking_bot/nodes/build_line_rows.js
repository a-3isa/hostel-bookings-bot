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
 *
 * معرف النظام is deliberately NOT among the columns emitted here. "Write Line
 * Id" writes it afterwards with one API call, because putting it through the
 * Sheets node is what made this branch slow: measured 2026-08-15, the node
 * writing this row with U took 31,363 ms and the same node writing A–Q without
 * it takes under a second. The id still reaches the sheet — that node reads it
 * straight off the Brain — it just no longer sits between the user and their ✅.
 */

const save = $('Brain').first().json.save;
const items = [];

/** Column U, written by its own node. See the note above. */
const ID_COL = 'معرف النظام';

const line = { row_number: save.row };
for (const k of Object.keys(save.fields || {})) {
  if (k === ID_COL) continue;
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
