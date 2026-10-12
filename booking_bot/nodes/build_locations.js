/**
 * The apartment / room registry, from the الإتاحة tab (A2:B).
 *
 * One body for the three nodes that need it — "Read Locations" (the Telegram
 * branch), "Read Report Locations" and "Read Availability Locations" — because it
 * reads only its direct input: the values.get response of the HTTP node in front.
 *
 * Row 2 of the tab is the header (الشقة / الغرفة) and row 3 holds a date label with
 * no room; neither is a room. Rooms keep the tab's order, which is already grouped
 * by apartment and ascending. brain.js's locationRegistry() and build_reports.js
 * read الشقة / الغرفة as text, exactly as they read the SQL this replaced.
 */
const resp = $input.first().json;
const values = resp && Array.isArray(resp.values) ? resp.values : [];
const cell = (v) => (v === undefined || v === null ? '' : String(v).trim());
const out = [];
for (const r of values) {
  const apartment = cell(r[0]);
  const room = cell(r[1]);
  if (!apartment || !room || apartment === 'الشقة') continue;
  out.push({ json: { 'الشقة': apartment, 'الغرفة': room } });
}
return out;
