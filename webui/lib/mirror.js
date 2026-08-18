// What a booking's sheet rows should say, and which row a new payment lands on.
//
// This is a port of `supabase/mirror.py` — the same columns, the same money and
// the same allocation rule — narrowed to the one booking the dashboard just
// changed. The Python mirror is still the reconciler: it sweeps every booking,
// protects hand edits through `mirror_payload`, and repairs anything this fast
// path skipped. Nothing here decides a rule of its own.
//
// Keep the two in step. `supabase/test_lines.py` pins the Python side and
// `lib/mirror.test.mjs` pins this one against the same worked examples.

export const DEFAULT_CURRENCY = 'EGP';

const s = (v) => (v === null || v === undefined ? '' : String(v));

// Numbers the way the sheet holds them: 2640, not 2640.00.
export function money(v) {
  if (v === null || v === undefined || v === '') return '';
  const f = Number(v);
  if (Number.isNaN(f)) return '';
  return String(f);
}

// What makes two payments the same LINE: the payment TYPE. A second payment in
// a method the booking already has joins that line and its cell grows; a method
// not seen before opens a row of its own. Currency is part of the identity
// because there are no exchange rates in this system — 1000 in cash pounds and
// 50 in cash euros are not 1050 of anything.
export function lineKey(method, currency) {
  return JSON.stringify([s(method).trim(), s(currency).trim() || DEFAULT_CURRENCY]);
}

const keyParts = (key) => JSON.parse(key);

// The price cell, which is not always a number.
//
// 16 bookings are priced by a nightly rate and hold a live formula in the
// sheet — `=500*I10`, or `=(650*I19)-2200` where a lump sum was written off.
// Ten of them are open-ended, so that formula is what keeps the price growing
// as the stay does; replacing it with today's number freezes the guest's bill
// on the day somebody happened to open the dashboard.
//
// The formula is rebuilt rather than copied, because it is anchored to a ROW
// and rows move. It is emitted only while the stored total still agrees with
// what the formula produces (`effective_total`) — the moment someone types a
// different price, that number is a deliberate override and it wins.
export function priceCell(b, sheetRow) {
  const rate = Number(b.nightly_rate || 0);
  if (!rate) return money(b.total);

  const effective = b.effective_total;
  if (effective === null || effective === undefined) return money(b.total);
  // To the piastre. A rounding difference here is a real one.
  if (Math.abs(Number(b.total || 0) - Number(effective)) > 0.005) return money(b.total);

  const adj = Number(b.total_adjustment || 0);
  const rateText = money(rate);
  if (!adj) return `=${rateText}*I${sheetRow}`;
  return `=(${rateText}*I${sheetRow})${adj < 0 ? '-' : '+'}${money(Math.abs(adj))}`;
}

// The cell values this booking should produce.
export function desired(b, sheetRow) {
  // An open-ended stay is a live formula in the sheet, exactly as the bot
  // writes it — the nights column has to keep counting up on its own.
  const nightsCell = b.open_ended
    ? `=TODAY()-J${sheetRow}`
    : (b.nights === null || b.nights === undefined ? '' : String(b.nights));

  const arrival = b.arrival
    ? (b.arrival instanceof Date
        ? b.arrival.toISOString().slice(0, 10)
        : String(b.arrival).slice(0, 10))
    : '';

  return {
    booking_ref: s(b.booking_ref),
    guest_ref: s(b.guest_ref),
    guest_name: s(b.guest_name),
    booking_type: s(b.booking_type),
    phone: s(b.phone),
    apartment_name: s(b.apartment_name),
    room_number: s(b.room_number),
    nights_cell: nightsCell,
    arrival,
    total: priceCell(b, sheetRow),
    paid: money(b.paid),
    // This line's own method, always — never the booking's combined methods.
    // The Dashboard tab and the per-property tabs read the payment column per
    // row and count on one payment type per line; a combined string is not a
    // tidier version of that fact, it is a value those formulas cannot read.
    payment_method: s(b.payment_method),
    notes: s(b.notes),
    booking_id: String(b.id),
  };
}

// The booking's own row.
//
// The agreed price is NOT reduced by its lines (ruled 2026-08-18): it is a fact
// about the booking and stays whole here, while a line row leaves its own price
// cell blank. Between them the column still sums to the booking.
//
// The paid cell IS reduced, and has to be — the sheet has one paid cell per row
// and each line carries its own. Leaving the full amount here while the row
// below shows part of it counts that payment twice.
export function primaryPayload(b, lines, sheetRow) {
  const want = desired(b, sheetRow);
  const own = lines ?? [];
  if (own.length === 0) return want;
  const spread = own.reduce((sum, ln) => sum + Number(ln.amount || 0), 0);
  want.paid = money(Number(b.paid || 0) - spread);
  return want;
}

// A continuation line's row. Everything identifying the guest is repeated,
// because that is what the sheet has always held on these rows and what its own
// formulas read. Only the money, the method and column U are the line's own.
//
// The price cell stays blank: a line is a second METHOD of paying the price,
// not a second price.
export function linePayload(b, line, sheetRow) {
  const want = desired(b, sheetRow);
  want.total = '';
  want.paid = money(line.amount);
  want.payment_method = s(line.method);
  want.booking_id = `${b.id}-${line.seq}`;
  return want;
}

// The last sheet row this booking occupies — its own, or its lowest line.
export function blockEnd(b) {
  const rows = [b.sheet_row, ...(b.lines ?? []).map((ln) => ln.sheet_row)];
  return Math.max(...rows.filter((r) => r !== null && r !== undefined));
}

// Which line each of this booking's unassigned payments joins.
//
//   merges    [{payment_id, seq}] — the type is already on the sheet, so the
//             payment joins that row. Nothing is inserted.
//   opens     [{seq, method, currency, amount, payment_ids}] — a type this
//             booking has not been paid in before. Each needs a row.
//   adopted   {method, currency} the booking's own line takes on when it had no
//             method at all. An empty payment cell with a populated line
//             beneath it is not what anyone means by two payment methods.
//
// Two payments of the same new type in one run share ONE new line.
export function planAllocation(b) {
  const lines = b.lines ?? [];
  const primary = lineKey(b.payment_method, b.primary_currency);
  const primaryMethod = keyParts(primary)[0];
  let adopted = null;

  const seqOf = new Map();
  if (primaryMethod) seqOf.set(primary, 1);
  for (const ln of lines) {
    const k = lineKey(ln.method, ln.currency);
    if (!seqOf.has(k)) seqOf.set(k, ln.seq);
  }

  let nextSeq = Math.max(1, ...lines.map((ln) => ln.seq)) + 1;
  const merges = [];
  const opened = new Map();

  for (const p of b.unallocated ?? []) {
    const key = lineKey(p.method, p.currency);
    if (!primaryMethod && adopted === null) {
      adopted = { method: keyParts(key)[0], currency: keyParts(key)[1] };
      if (!seqOf.has(key)) seqOf.set(key, 1);
    }
    if (seqOf.has(key)) {
      merges.push({ payment_id: p.id, seq: seqOf.get(key) });
    } else if (opened.has(key)) {
      const o = opened.get(key);
      o.payment_ids.push(p.id);
      o.amount += Number(p.amount || 0);
    } else {
      opened.set(key, {
        seq: nextSeq,
        method: keyParts(key)[0],
        currency: keyParts(key)[1],
        amount: Number(p.amount || 0),
        payment_ids: [p.id],
      });
      nextSeq += 1;
    }
  }

  return { merges, opens: [...opened.values()], adopted };
}

// The expenses tab. A row there carries no id of its own, so what it SAYS is
// its identity — see checkExpenseRow in lib/sheets.js.

// The sheet writes التاريخ as `2026-08-15 12:23`, and USER_ENTERED parses that
// back into the same datetime the column is formatted for. An ISO string with a
// T and a zone lands as text and sorts wrong.
//
// UTC, and not the server's idea of local time. Checked against the live tab on
// 2026-08-18: every existing row's digits are `spent_at` read in UTC — row 19
// holds `2026-08-15 12:23` for a `spent_at` of 12:23Z. A lambda happens to run
// in UTC and would agree by accident; a developer's machine would not, and the
// same expense would land two hours out depending on who saved it.
export function stamp(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
       + ` ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function expensePayload(e) {
  return {
    spent_at: stamp(e.spent_at),
    item: e.item ?? '',
    amount: e.amount === null || e.amount === undefined ? '' : String(Number(e.amount)),
    apartment_name: e.apartment_name ?? '',
    notes: e.notes ?? '',
    payment_method: e.payment_method ?? '',
    responsible: e.responsible ?? '',
  };
}
