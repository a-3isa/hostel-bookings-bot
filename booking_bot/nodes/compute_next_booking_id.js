/**
 * "Read Next Booking ID" — the ID offered for the next booking: one past the
 * highest this month's tab holds, so nobody has to remember it.
 *
 * The numbering restarts every month, and the tab is one month, so "this month"
 * holds by construction. Guests carried over from last month keep their old ID
 * marked with stars ("104**"), which is not a plain counter and never counts; ID is
 * hand-typed text, so only 1-6 digit counters do (a passport or national number
 * would push every suggestion into the millions). Arabic-Indic digits are folded to
 * ASCII first, the way brain.js reads them. Cancelled bookings keep their number.
 *
 * A suggestion, not an allocation: the receptionist can type another number.
 * Input: the values.get response of B1:B2000 (row 1 is the "ID" header).
 */
const resp = $input.first().json;
const values = resp && Array.isArray(resp.values) ? resp.values : [];
const fold = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/[٠-٩]/g, ch => String(ch.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, ch => String(ch.charCodeAt(0) - 0x06F0))
  .trim();
let max = 0;
for (let i = 1; i < values.length; i++) {         // row 1 is the header
  const s = fold((values[i] || [])[0]);
  if (/^[0-9]{1,6}$/.test(s)) max = Math.max(max, Number(s));
}
return [{ json: { next_booking_id: max + 1 } }];
