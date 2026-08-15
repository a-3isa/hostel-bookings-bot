/**
 * Where the next row goes — nodes/build_booking_row.js and build_expense_row.js.
 *
 *     node booking_bot/test_rows.mjs
 *
 * This exists because of a real loss. On 2026-08-14 the bot wrote an expense
 * over a row somebody had typed by hand: the builders COUNTED the rows returned
 * from a single key column, that row's key column was empty, and so the count
 * did not see it. The row was overwritten and its contents survive only in the
 * spreadsheet's version history.
 *
 * Every case below is a shape a hand-edited sheet really takes.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const bookingFn = new Function('$', '$input',
  readFileSync(join(HERE, 'nodes', 'build_booking_row.js'), 'utf8'));
const expenseFn = new Function('$', '$input',
  readFileSync(join(HERE, 'nodes', 'build_expense_row.js'), 'utf8'));

const BOOKING_SAVE = {
  flow: 'booking',
  fields: { 'اسم المقيم': 'محمد', 'عدد الليالي': '=TODAY()-J{r}', 'اجمالي سعر الحجز': 1200 },
};
const EXPENSE_SAVE = {
  flow: 'expense',
  fields: { 'البند': 'نت', 'المبلغ': 300, 'الشقة': 'انبي 2' },
};

const brain = (save) => () => ({ first: () => ({ json: { save } }) });

function target(fn, save, items) {
  return fn(brain(save), { all: () => items })[0].json.row_number;
}

/** A row as the Sheets node returns it: the sheet's own row_number, plus cells. */
const row = (n, cells) => ({ json: { row_number: n, ...cells } });

/**
 * The Sheets API response, which is what the reads produce now.
 *
 * `values` starts at row 1 and the API trims only the empty tail, so its length
 * is the last occupied row. `lastRow` here is that row number; the helper fills
 * the array so the two agree.
 */
const api = (lastRow, { blanks = [] } = {}) => [{
  json: {
    range: 'tab!A1:J2000',
    majorDimension: 'ROWS',
    values: Array.from({ length: lastRow },
      (_, i) => (blanks.includes(i + 1) ? [] : ['x'])),
  },
}];

let failures = 0;
function check(label, got, want) {
  if (got === want) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label} → got ${got}, want ${want}`); }
}
function section(n) { console.log(`\n${n}`); }

section('the live sheet, as it stood on 2026-08-15');
{
  // Measured against the real spreadsheet: إدخال الحجوزات ends at row 77 and
  // مصروفات عامة at row 26. Both were being written ON, not below.
  check('a booking goes to 78, not onto 77', target(bookingFn, BOOKING_SAVE, api(77)), 78);
  check('an expense goes to 27, not onto 26', target(expenseFn, EXPENSE_SAVE, api(26)), 27);
}

section('the second incident: writing onto the last occupied row');
{
  // n8n numbers rows from its own view of the range, so max(row_number) + 1 was
  // one short and every save landed on the last row. The API's `values` has no
  // such opinion: length IS the last occupied row.
  check('expense: the row after the last one', target(expenseFn, EXPENSE_SAVE, api(19)), 20);
  check('booking: the row after the last one', target(bookingFn, BOOKING_SAVE, api(9)), 10);
}
{
  // The API keeps interior blanks as empty arrays, so a hole in the middle does
  // not shorten the answer.
  check('a hole in the middle changes nothing',
    target(expenseFn, EXPENSE_SAVE, api(19, { blanks: [4, 5] })), 20);
}
{
  // An empty tab: the API omits `values` entirely rather than sending [].
  const empty = [{ json: { range: 'tab!A1:H2000', majorDimension: 'ROWS' } }];
  check('an untouched tab starts at row 1', target(expenseFn, EXPENSE_SAVE, empty), 1);
}
{
  const one = api(1);   // the header alone
  check('a tab with only headers writes row 2', target(expenseFn, EXPENSE_SAVE, one), 2);
}

section('the incident: a hand-typed row the old count could not see');
{
  // Rows 2–18 are complete. Row 19 was typed by hand with only الرقم filled —
  // no البند, which is the column the builder used to count.
  const items = [];
  for (let n = 2; n <= 18; n++) items.push(row(n, { 'البند': 'نت', 'المبلغ': 100 }));
  items.push(row(19, { 'البند': '', 'المبلغ': '', 'الرقم': '٦٦٦' }));
  check('the expense goes BELOW the hand-typed row', target(expenseFn, EXPENSE_SAVE, items), 20);
}
{
  const items = [];
  for (let n = 2; n <= 77; n++) items.push(row(n, { 'اسم المقيم': 'ضيف' }));
  // A booking row typed by hand with no guest name yet — a phone number only.
  items.push(row(78, { 'اسم المقيم': '', 'رقم الهاتف': '01012345678' }));
  check('the booking goes BELOW it too', target(bookingFn, BOOKING_SAVE, items), 79);
}

section('the last row, not the number of rows');
{
  // Someone deleted the contents of rows 4 and 5 but left the rows in place.
  const items = [row(2, { 'البند': 'نت' }), row(3, { 'البند': 'غاز' }),
                 row(6, { 'البند': 'كهرباء' })];
  check('a gap in the middle does not pull the write up', target(expenseFn, EXPENSE_SAVE, items), 7);
}
{
  const items = [row(9, { 'اسم المقيم': 'ضيف' })];
  check('one row far down the sheet', target(bookingFn, BOOKING_SAVE, items), 10);
}

section('an empty tab');
{
  // alwaysOutputData gives one blank item when the range matched nothing.
  check('expense: the first data row', target(expenseFn, EXPENSE_SAVE, [{ json: {} }]), 2);
  check('booking: the first data row', target(bookingFn, BOOKING_SAVE, [{ json: {} }]), 2);
}
{
  // A row that exists but is entirely blank is not occupied.
  check('a blank row is not a row', target(expenseFn, EXPENSE_SAVE,
    [row(2, { 'البند': '', 'المبلغ': '' })]), 2);
}

section('without row_number, it still counts contiguously');
{
  // Older n8n Sheets versions did not return row_number. The fallback is the
  // old behaviour, which is correct as long as the rows are contiguous.
  const items = Array.from({ length: 17 }, () => ({ json: { 'البند': 'نت' } }));
  check('expense falls back to count + 2', target(expenseFn, EXPENSE_SAVE, items), 19);
  const bk = Array.from({ length: 76 }, () => ({ json: { 'اسم المقيم': 'ضيف' } }));
  check('booking falls back to count + 2', target(bookingFn, BOOKING_SAVE, bk), 78);
}

section('the row number reaches the fields that need it');
{
  const items = [row(2, { 'اسم المقيم': 'ضيف' })];
  const out = bookingFn(brain(BOOKING_SAVE), { all: () => items })[0].json;
  check('{r} is replaced with the real row', out['عدد الليالي'], '=TODAY()-J3');
  check('and it is the row being written', out.row_number, 3);
}

section('formula columns are still never written');
{
  const save = { flow: 'booking', fields: { 'اسم المقيم': 'ضيف', 'المتبقي': 500,
                                            'صافي الدخل': 400, 'آخر تعديل': 'x' } };
  const out = bookingFn(brain(save), { all: () => [row(2, { 'اسم المقيم': 'ضيف' })] })[0].json;
  check('P المتبقي absent', 'المتبقي' in out, false);
  check('S صافي الدخل absent', 'صافي الدخل' in out, false);
  check('T آخر تعديل absent', 'آخر تعديل' in out, false);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
