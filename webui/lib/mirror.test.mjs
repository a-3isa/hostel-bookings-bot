// The JS mirror against the same worked examples that pin the Python one.
//
// `supabase/test_lines.py` is the original; every case here has a twin there,
// and the two files are the only thing keeping the dashboard's fast path and
// `supabase/mirror.py` from drifting into two different sheets.
//
//     node --test webui/lib/mirror.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blockEnd, expensePayload, lineKey, linePayload, planAllocation, primaryPayload,
  priceCell, stamp,
} from './mirror.js';

const CASH = 'كاش';
const INSTA = 'انستاباي';
const VODA = 'فودافون كاش';

const booking = (over = {}) => ({
  id: 413, sheet_row: 10, guest_name: 'ضيف',
  payment_method: CASH, primary_currency: 'EGP',
  lines: [], unallocated: [],
  ...over,
});

const payment = (id, amount, method, currency = 'EGP') =>
  ({ id, amount, method, currency });

const line = (seq, method, sheet_row, amount = 0, currency = 'EGP') =>
  ({ id: 900 + seq, seq, method, currency, sheet_row, amount });

const moneyRow = (over = {}) => ({
  id: 413, sheet_row: 10, booking_ref: '', guest_ref: '', guest_name: 'ضيف',
  booking_type: '', phone: '', apartment_name: '', room_number: '',
  arrival: null, nights: 2, open_ended: false, total: 2200, paid: 2200,
  payment_method: CASH, notes: '',
  ...over,
});

// ── the same method joins the line it is already on ─────────────────────────

test('same method as the booking joins line one', () => {
  const { merges, opens } = planAllocation(
    booking({ unallocated: [payment(1, 500, CASH)] }));
  assert.deepEqual(merges, [{ payment_id: 1, seq: 1 }]);
  assert.deepEqual(opens, []);
});

test('same method as a second line joins that line', () => {
  const { merges, opens } = planAllocation(booking({
    lines: [line(2, INSTA, 11, 1600)],
    unallocated: [payment(1, 400, INSTA)],
  }));
  assert.deepEqual(merges, [{ payment_id: 1, seq: 2 }]);
  assert.deepEqual(opens, []);
});

test('a third payment checks every line', () => {
  const { merges, opens } = planAllocation(booking({
    lines: [line(2, INSTA, 11), line(3, VODA, 12)],
    unallocated: [payment(1, 100, VODA)],
  }));
  assert.deepEqual(merges, [{ payment_id: 1, seq: 3 }]);
  assert.deepEqual(opens, []);
});

test('two payments of the same new method share one new line', () => {
  const { merges, opens } = planAllocation(booking({
    unallocated: [payment(1, 300, INSTA), payment(2, 200, INSTA)],
  }));
  assert.deepEqual(merges, []);
  assert.equal(opens.length, 1);
  assert.equal(opens[0].seq, 2);
  assert.equal(opens[0].amount, 500);          // one row, holding their sum
  assert.deepEqual(opens[0].payment_ids, [1, 2]);
});

// ── a method not seen before opens a row ────────────────────────────────────

test('a new method opens the next line', () => {
  const { merges, opens } = planAllocation(
    booking({ unallocated: [payment(1, 1600, INSTA)] }));
  assert.deepEqual(merges, []);
  assert.deepEqual(opens, [{
    seq: 2, method: INSTA, currency: 'EGP', amount: 1600, payment_ids: [1],
  }]);
});

test('new lines number after the ones that exist', () => {
  const { opens } = planAllocation(booking({
    lines: [line(2, INSTA, 11)],
    unallocated: [payment(1, 90, VODA)],
  }));
  assert.equal(opens[0].seq, 3);
});

test('two different new methods open two lines', () => {
  const { opens } = planAllocation(booking({
    unallocated: [payment(1, 300, INSTA), payment(2, 200, VODA)],
  }));
  assert.deepEqual(opens.map((o) => o.seq), [2, 3]);
  assert.deepEqual(opens.map((o) => o.method), [INSTA, VODA]);
});

// ── currency is part of what makes a line ───────────────────────────────────

test('the same method in another currency is another line', () => {
  const { merges, opens } = planAllocation(booking({
    primary_currency: 'EGP',
    unallocated: [payment(1, 50, CASH, 'EUR')],
  }));
  assert.deepEqual(merges, []);
  assert.equal(opens[0].currency, 'EUR');
});

test('a payment with no currency is the default', () => {
  assert.equal(lineKey(CASH, null), lineKey(CASH, 'EGP'));
  assert.equal(lineKey(CASH, '  '), lineKey(CASH, 'EGP'));
});

test('a method is compared without its padding', () => {
  const { merges, opens } = planAllocation(
    booking({ unallocated: [payment(1, 500, ` ${CASH} `)] }));
  assert.deepEqual(merges, [{ payment_id: 1, seq: 1 }]);
  assert.deepEqual(opens, []);
});

// ── a booking with no method at all ─────────────────────────────────────────

test('the first payment fills an empty method cell', () => {
  const { merges, opens, adopted } = planAllocation(
    booking({ payment_method: '', unallocated: [payment(1, 700, INSTA)] }));
  assert.deepEqual(merges, [{ payment_id: 1, seq: 1 }]);
  assert.deepEqual(opens, []);
  assert.deepEqual(adopted, { method: INSTA, currency: 'EGP' });
});

test('a later different method still opens a line', () => {
  const { merges, opens, adopted } = planAllocation(booking({
    payment_method: '',
    unallocated: [payment(1, 700, INSTA), payment(2, 300, CASH)],
  }));
  assert.deepEqual(merges, [{ payment_id: 1, seq: 1 }]);
  assert.deepEqual(adopted, { method: INSTA, currency: 'EGP' });
  assert.deepEqual(opens.map((o) => o.method), [CASH]);
});

test('a booking with no loose payments is left alone', () => {
  const plan = planAllocation(booking({ lines: [line(2, INSTA, 11)] }));
  assert.deepEqual(plan, { merges: [], opens: [], adopted: null });
});

// ── where the new row goes ──────────────────────────────────────────────────

test('the row goes under the booking when it is alone', () => {
  assert.equal(blockEnd(booking()), 10);
});

test('the row goes under the last line the booking owns', () => {
  assert.equal(blockEnd(booking({ lines: [line(2, INSTA, 11), line(3, VODA, 12)] })), 12);
});

test('a line that owns no row yet does not move the block', () => {
  assert.equal(blockEnd(booking({ lines: [line(2, INSTA, null)] })), 10);
});

// ── what the rows then say ──────────────────────────────────────────────────

test('a line shows what was paid in its own method', () => {
  const want = linePayload(moneyRow(), line(2, INSTA, 11, 1600), 11);
  // The price stays blank on a line: it was agreed once and lives on the
  // booking's own row. A line is a second METHOD, not a second price.
  assert.equal(want.total, '');
  assert.equal(want.paid, '1600');
  assert.equal(want.payment_method, INSTA);
  assert.equal(want.booking_id, '413-2');
});

test('a merged payment grows the cell it landed in', () => {
  const want = linePayload(moneyRow(), line(2, INSTA, 11, 800 + 800), 11);
  assert.equal(want.paid, '1600');
  assert.equal(want.total, '');
});

test('the booking row keeps the whole price', () => {
  const want = primaryPayload(moneyRow(), [line(2, INSTA, 11, 1600)], 10);
  assert.equal(want.total, '2200');
  assert.equal(want.paid, '600');
});

test('the price column sums to the booking once', () => {
  // The whole point of leaving a line's price blank: a 2200 stay paid in two
  // methods must not read as 3800 to anything that totals the column.
  const row = moneyRow();
  const ln = line(2, INSTA, 11, 1600);
  const bookingRow = primaryPayload(row, [ln], 10);
  const lineRow = linePayload(row, ln, 11);
  assert.equal(Number(bookingRow.total) + Number(lineRow.total || 0), row.total);
});

test('three lines still sum back to the booking', () => {
  const want = primaryPayload(
    moneyRow({ total: 3000, paid: 3000 }),
    [line(2, INSTA, 11, 1000), line(3, VODA, 12, 500)],
    10);
  assert.equal(want.paid, '1500');
});

test('a booking on one line is untouched by the split', () => {
  for (const lines of [[], null]) {
    assert.equal(primaryPayload(moneyRow(), lines, 10).paid, '2200');
  }
});

test('an open-ended stay keeps its live nights formula', () => {
  const want = primaryPayload(moneyRow({ open_ended: true, nights: null }), [], 10);
  assert.equal(want.nights_cell, '=TODAY()-J10');
});

// -- expenses ---------------------------------------------------------------

test('a date is written in UTC, not the server timezone', () => {
  // Read off the live tab: row 19 shows `2026-08-15 12:23` for a spent_at of
  // 12:23Z. A lambda runs in UTC and would agree by accident; a machine on
  // Cairo time would put the same expense two hours out.
  assert.equal(stamp('2026-08-15T12:23:00Z'), '2026-08-15 12:23');
  assert.equal(stamp(new Date(Date.UTC(2026, 7, 5, 9, 7))), '2026-08-05 09:07');
});

test('no date at all is an empty cell, not the epoch', () => {
  assert.equal(stamp(null), '');
  assert.equal(stamp(''), '');
});

test('a date the database never parsed is passed through untouched', () => {
  assert.equal(stamp('not a date'), 'not a date');
});

test('an expense fills the seven columns the bot owns', () => {
  const want = expensePayload({
    spent_at: '2026-08-15T09:27:00Z',
    item: 'كهربا',
    amount: '660.00',
    apartment_name: 'انبي 2',
    notes: null,
    payment_method: 'كاش',
    responsible: null,
  });
  assert.deepEqual(want, {
    spent_at: '2026-08-15 09:27',
    item: 'كهربا',
    // 660, not 660.00 — the shape the tab already holds.
    amount: '660',
    apartment_name: 'انبي 2',
    notes: '',
    payment_method: 'كاش',
    responsible: '',
  });
  // H (الرقم) is not among them, deliberately: it is a human reference and a
  // stale one has already been found sitting on somebody else's expense.
  assert.equal('expense_ref' in want, false);
});

// -- the price cell ---------------------------------------------------------
//
// 16 bookings hold a live formula in اجمالي سعر الحجز and 10 of those are
// open-ended, so the formula is what keeps the bill growing with the stay.

test('a booking priced by a nightly rate keeps its formula', () => {
  const b = moneyRow({ nightly_rate: 500, total: 8500, effective_total: 8500 });
  assert.equal(priceCell(b, 10), '=500*I10');
});

test('the formula is anchored to the row it is on now, not the one it was on', () => {
  // Rows move. Copying the stored `=500*I10` onto row 14 would price the guest
  // off somebody else's night count.
  const b = moneyRow({ nightly_rate: 500, total: 8500, effective_total: 8500 });
  assert.equal(priceCell(b, 14), '=500*I14');
});

test('a lump sum written off the rate survives', () => {
  const b = moneyRow({ nightly_rate: 650, total_adjustment: -2200,
                       total: 10800, effective_total: 10800 });
  assert.equal(priceCell(b, 19), '=(650*I19)-2200');
});

test('a lump sum added to the rate survives', () => {
  const b = moneyRow({ nightly_rate: 500, total_adjustment: 3500,
                       total: 10000, effective_total: 10000 });
  assert.equal(priceCell(b, 17), '=(500*I17)+3500');
});

test('a price typed by hand beats the formula', () => {
  // The whole point of comparing against effective_total: once somebody sets a
  // different number, that is a deliberate override and the rate stops driving
  // the cell.
  const b = moneyRow({ nightly_rate: 500, total: 9000, effective_total: 8500 });
  assert.equal(priceCell(b, 10), '9000');
});

test('a booking with no rate is just its number', () => {
  assert.equal(priceCell(moneyRow({ total: 2200 }), 10), '2200');
});

test('a rate with no effective total falls back to the number', () => {
  const b = moneyRow({ nightly_rate: 500, total: 8500, effective_total: null });
  assert.equal(priceCell(b, 10), '8500');
});

test('a line row has no price at all, rate or no rate', () => {
  const b = moneyRow({ nightly_rate: 500, total: 8500, effective_total: 8500 });
  assert.equal(linePayload(b, line(2, INSTA, 11, 1600), 11).total, '');
});
