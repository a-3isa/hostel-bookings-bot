/**
 * "Read Bookings For Edit" — the bookings tab as the Brain's lookup rows.
 *
 * This used to be a Postgres query (read_bookings_for_edit.sql) over a mirror that
 * only ever heard about the bot's own writes. The sheet is hand-edited and the
 * mirror was not, so the row number the query handed over drifted, and the bot
 * wrote the next payment onto the guest above or below. Reading the sheet in the
 * same turn removes that class of bug: the row number and the amounts are the
 * ones the bot is about to write against.
 *
 * Inputs are two Sheets-API `values.get` responses of A1:U2000, one rendered as
 * FORMULA and one as UNFORMATTED_VALUE (the HTTP nodes "Fetch Bookings Formulas"
 * and "Fetch Bookings Values"). The API, not the Sheets node: it returns rows from
 * row 1 with trailing empties trimmed and interior blanks kept, so a row's number
 * is its index + 1 — the Sheets node numbers rows from its own view of the range.
 *
 * A row is a BOOKING when it names a guest and is not a LINE. A LINE is a second
 * payment METHOD on the same booking: commitPaymentLine copies the identity columns
 * onto a row directly under the booking's block, leaves the price blank and fills
 * paid and method. Anything else — including the same guest on a later arrival, or
 * the same identity after a gap — is its own booking.
 *
 * The output keeps the sheet's own Arabic headers, so brain.js reads it as it read
 * the SQL: row_number, booking_id (the row: nothing outside this turn needs a
 * database id any more), lines, block_end and total_is_formula.
 */

const H = {
  ref: 'بوكنج ID', id: 'ID', name: 'اسم المقيم', type: 'نوع الحجز', phone: 'رقم الهاتف',
  apt: 'اسم الشقة', room: 'رقم الغرفة', nights: 'عدد الليالي', arrival: 'تاريخ البداية',
  departure: 'تاريخ المغادرة', total: 'اجمالي سعر الحجز', paid: 'اجمالي ما تم دفعه',
  method: 'طريقة الدفع', remaining: 'المتبقي', notes: 'ملاحظات',
};

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const txt = (v) => (v === undefined || v === null ? '' : String(v));

/** Rows of a values.get response as { row, cells: {header: value} }; row = index + 1. */
function sheetRows(resp) {
  const values = resp && Array.isArray(resp.values) ? resp.values : [];
  if (!values.length) return [];
  const head = values[0].map(h => txt(h).trim());
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const cells = {};
    head.forEach((h, c) => { if (h) cells[h] = row[c] === undefined ? '' : row[c]; });
    out.push({ row: i + 1, cells });
  }
  return out;
}

/** A date cell as YYYY-MM-DD: a Sheets serial, or text in the sheet's own forms. */
function isoDate(v) {
  if (blank(v)) return '';
  if (typeof v === 'number') {
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d+(\.\d+)?$/.test(s)) return isoDate(Number(s));
  return s;
}

/** Who the row is about; a line repeats its booking's. */
const keyOf = (v) => [v[H.id], v[H.name], v[H.apt], v[H.room], isoDate(v[H.arrival])]
  .map(x => txt(x).trim()).join('\u0001');

function bookingItem(row, f, v) {
  const nightsF = f[H.nights];
  const open = typeof nightsF === 'string' && /^=\s*TODAY\s*\(\s*\)/i.test(nightsF.trim());
  const totalF = f[H.total];
  return {
    row_number: row,
    [H.ref]: txt(v[H.ref]),
    [H.id]: txt(v[H.id]),
    [H.name]: txt(v[H.name]),
    [H.type]: txt(v[H.type]),
    [H.phone]: txt(v[H.phone]),
    [H.apt]: txt(v[H.apt]),
    [H.room]: v[H.room] === undefined ? '' : v[H.room],
    [H.nights]: open ? '=OPEN' : (blank(v[H.nights]) ? '' : v[H.nights]),
    [H.arrival]: isoDate(v[H.arrival]),
    [H.departure]: isoDate(v[H.departure]),
    [H.total]: v[H.total] === undefined ? '' : v[H.total],
    [H.paid]: v[H.paid] === undefined ? '' : v[H.paid],
    [H.method]: txt(v[H.method]),
    [H.remaining]: v[H.remaining] === undefined ? '' : v[H.remaining],
    [H.notes]: txt(v[H.notes]),
    booking_id: row,
    lines: [],
    block_end: row,
    // A nightly rate (=500*I10, =(650*I19)-2200) grows with the stay and must not be
    // overwritten by a typed number. A typed constant (=12900, =1400+700) may be.
    total_is_formula: typeof totalF === 'string' && totalF.trim().startsWith('=') && /\bI\d+\b/i.test(totalF),
  };
}

let formulas = [];
let values = [];
try {
  formulas = sheetRows($('Fetch Bookings Formulas').first().json);
  values = sheetRows($('Fetch Bookings Values').first().json);
} catch (e) {
  return [];                           // a node that did not run, or an error item
}

const valueCells = new Map(values.map(x => [x.row, x.cells]));
const out = [];
let cur = null;
let curKey = '';
for (const { row, cells } of formulas) {
  const v = valueCells.get(row) || cells;
  if (blank(v[H.name])) continue;      // an empty row, or one with no guest
  const isLine = cur && row === cur.block_end + 1 && keyOf(v) === curKey
    && blank(v[H.total]) && !(blank(v[H.paid]) && blank(v[H.method]));
  if (isLine) {
    cur.lines.push({
      seq: cur.lines.length + 2, row, method: txt(v[H.method]).trim(), amount: Number(v[H.paid]) || 0,
    });
    cur.block_end = row;
    continue;
  }
  cur = bookingItem(row, cells, v);
  curKey = keyOf(v);
  out.push(cur);
}
return out.map(json => ({ json }));
