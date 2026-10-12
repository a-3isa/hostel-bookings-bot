/**
 * Offline tests for the three lookup Code nodes that replaced the Postgres reads.
 *
 *     node booking_bot/test_sheet_lookup.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (name) => readFileSync(join(HERE, 'nodes', name), 'utf8');
const brainSrc = readFileSync(join(HERE, 'brain.js'), 'utf8');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ''}`); }
}
function section(name) { console.log(`\n${name}`); }

// The real header row of إدخال الحجوزات (A..W).
const HEADERS = ['بوكنج ID', 'ID', 'اسم المقيم', 'نوع الحجز', 'الجنسية', 'رقم الهاتف', 'اسم الشقة',
  'رقم الغرفة', 'عدد الليالي', 'تاريخ البداية', 'تاريخ المغادرة', 'اجمالي سعر الحجز',
  'اجمالي ما تم دفعه', 'نسبة البرنامج', 'طريقة الدفع', 'المتبقي', 'ملاحظات', 'تاريخ الإدخال',
  'صافي الدخل', 'آخر تعديل', 'معرف النظام', 'data', 'rows'];

/** A sheet row as the API returns it: cells in header order, trailing blanks trimmed. */
function cells(obj) {
  const row = HEADERS.map(h => (obj[h] === undefined ? '' : obj[h]));
  while (row.length && row[row.length - 1] === '') row.pop();
  return row;
}
/** values.get body for `{ sheetRow: {header: value} }`; interior blank rows are []. */
function sheet(rows) {
  const last = Math.max(1, ...Object.keys(rows).map(Number));
  const values = [HEADERS];
  for (let r = 2; r <= last; r++) values.push(rows[r] ? cells(rows[r]) : []);
  return { range: "'إدخال الحجوزات'!A1:U2000", majorDimension: 'ROWS', values };
}

function runLookup(formulaRows, valueRows = formulaRows) {
  const fn = new Function('$', src('build_bookings_lookup.js'));
  const $ = (name) => {
    const body = name === 'Fetch Bookings Formulas' ? sheet(formulaRows)
      : name === 'Fetch Bookings Values' ? sheet(valueRows) : null;
    if (!body) throw new Error(`unexpected node ${name}`);
    return { first: () => ({ json: body }), all: () => [{ json: body }] };
  };
  return fn($).map(i => i.json);
}

// Serial 46301 = 2026-10-06 (days since 1899-12-30).
const SERIAL = { '2026-10-05': 46300, '2026-10-06': 46301, '2026-10-09': 46304 };

const R36 = { 'ID': 25, 'اسم المقيم': 'تبع عمر البيه', 'نوع الحجز': 'بوكينج', 'رقم الهاتف': '+20 10 11111111',
  'اسم الشقة': 'ذاكر حسين', 'رقم الغرفة': 3, 'عدد الليالي': 30, 'تاريخ البداية': SERIAL['2026-10-05'],
  'اجمالي سعر الحجز': 10000, 'اجمالي ما تم دفعه': 0, 'طريقة الدفع': 'غير مدفوع', 'المتبقي': 10000, 'معرف النظام': '2338' };
// Rows 37-39 as they really are: three different stays that all carry system id 2340.
const R37 = { 'ID': 26, 'اسم المقيم': 'سيف الدين حسام', 'اسم الشقة': 'ذاكر حسين', 'رقم الغرفة': 4, 'عدد الليالي': 1,
  'تاريخ البداية': SERIAL['2026-10-05'], 'اجمالي سعر الحجز': 1050, 'اجمالي ما تم دفعه': 1050, 'طريقة الدفع': 'انستاباي', 'معرف النظام': '2340' };
const R38 = { 'ID': 27, 'اسم المقيم': 'محمد طاهر', 'اسم الشقة': 'عبدالله العربي', 'رقم الغرفة': 3, 'عدد الليالي': 2,
  'تاريخ البداية': SERIAL['2026-10-06'], 'اجمالي سعر الحجز': 1400, 'اجمالي ما تم دفعه': 1400, 'طريقة الدفع': 'انستاباي', 'معرف النظام': '2340' };
const R39 = { 'ID': 27, 'اسم المقيم': 'محمد طاهر', 'اسم الشقة': 'عبدالله العربي', 'رقم الغرفة': 3, 'عدد الليالي': 2,
  'تاريخ البداية': SERIAL['2026-10-09'], 'اجمالي سعر الحجز': 700, 'اجمالي ما تم دفعه': 700, 'طريقة الدفع': 'فودافون كاش', 'معرف النظام': '2340' };

section('lookup: one booking, in the shape the Brain reads');
let rows = runLookup({ 36: R36 });
check('one booking', rows.length === 1, rows.length);
const b = rows[0];
check('its sheet row is the array position + 1', b.row_number === 36 && b.booking_id === 36, [b.row_number, b.booking_id]);
check('the Arabic headers carry the values', b['اسم المقيم'] === 'تبع عمر البيه' && b['اسم الشقة'] === 'ذاكر حسين'
  && b['رقم الغرفة'] === 3 && b['طريقة الدفع'] === 'غير مدفوع', b);
check('ID is text', b['ID'] === '25', b['ID']);
check('money stays a number', b['اجمالي سعر الحجز'] === 10000 && b['اجمالي ما تم دفعه'] === 0, b);
check('the arrival serial is an ISO date', b['تاريخ البداية'] === '2026-10-05', b['تاريخ البداية']);
check('no lines, block ends on its own row', Array.isArray(b.lines) && b.lines.length === 0 && b.block_end === 36, [b.lines, b.block_end]);
check('a plain total is not a formula', b.total_is_formula === false);

section('lookup: rows 37-39 (one system id, three stays) are three bookings, not a booking and two lines');
rows = runLookup({ 37: R37, 38: R38, 39: R39 });
check('three bookings', rows.length === 3, rows.map(r => r.row_number));
check('the same guest on a later arrival is its own booking', rows[2].row_number === 39 && rows[2].lines.length === 0, rows[2]);
check('in row order', rows.map(r => r.row_number).join() === '37,38,39');

section('lookup: a payment line belongs to the booking above it');
const LINE_IDENTITY = ['بوكنج ID', 'ID', 'اسم المقيم', 'نوع الحجز', 'رقم الهاتف', 'اسم الشقة', 'رقم الغرفة', 'تاريخ البداية', 'ملاحظات'];
const brainIdentity = [...brainSrc.match(/const LINE_IDENTITY_COLS = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
check('the identity columns the writer copies are the ones this test copies', brainIdentity.join() === LINE_IDENTITY.join(), brainIdentity);
const lineOf = (booking, extra) => {
  const line = {};
  for (const h of LINE_IDENTITY) if (booking[h] !== undefined && booking[h] !== '') line[h] = booking[h];
  return { ...line, 'عدد الليالي': booking['عدد الليالي'], 'اجمالي سعر الحجز': '', ...extra };
};
rows = runLookup({ 50: R38, 51: lineOf(R38, { 'اجمالي ما تم دفعه': 700, 'طريقة الدفع': 'فودافون كاش' }), 52: R39 });
check('two bookings; the line is not one', rows.length === 2 && rows[0].row_number === 50 && rows[1].row_number === 52, rows.map(r => r.row_number));
check('the line is on the booking: seq 2, its row, method and amount',
  JSON.stringify(rows[0].lines) === JSON.stringify([{ seq: 2, row: 51, method: 'فودافون كاش', amount: 700 }]), rows[0].lines);
check('the block ends on the line, so the next payment line goes under it', rows[0].block_end === 51, rows[0].block_end);
rows = runLookup({ 50: R38, 51: lineOf(R38, { 'اجمالي ما تم دفعه': 700, 'طريقة الدفع': 'كاش' }),
  52: lineOf(R38, { 'اجمالي ما تم دفعه': 100, 'طريقة الدفع': 'دولار' }) });
check('two lines are seq 2 and 3', rows[0].lines.map(l => l.seq).join() === '2,3' && rows[0].block_end === 52, rows[0].lines);

section('lookup: what is NOT a line');
rows = runLookup({ 50: R38, 52: lineOf(R38, { 'اجمالي ما تم دفعه': 700, 'طريقة الدفع': 'كاش' }) });          // Review Focus 2
check('the same identity two rows down (a blank row between) is a second booking', rows.length === 2 && rows[0].lines.length === 0, rows);
rows = runLookup({ 50: R37, 51: lineOf(R38, { 'اجمالي ما تم دفعه': 700, 'طريقة الدفع': 'كاش' }) });
check('a line-shaped row under a different guest is its own booking', rows.length === 2, rows.map(r => r.row_number));
rows = runLookup({ 50: R38, 51: { ...lineOf(R38, { 'اجمالي ما تم دفعه': 700, 'طريقة الدفع': 'كاش' }), 'اجمالي سعر الحجز': 700 } });
check('a row with its own price is a booking even with the same identity', rows.length === 2, rows.length);
rows = runLookup({ 50: R38, 51: lineOf(R38, {}) });
check('a row with neither paid nor method is not a line', rows.length === 2, rows.length);

section('lookup: nights, totals, dates');
const open = { ...R36, 'عدد الليالي': 12 };
const openF = { ...R36, 'عدد الليالي': '=TODAY()-J36', 'اجمالي سعر الحجز': '=500*I36' };
rows = runLookup({ 36: openF }, { 36: open });
check('an open-ended stay is =OPEN (the formula read, not the number it shows today)', rows[0]['عدد الليالي'] === '=OPEN', rows[0]['عدد الليالي']);
check('a nightly-rate total is flagged as a formula, and its VALUE comes from the values read',
  rows[0].total_is_formula === true && rows[0]['اجمالي سعر الحجز'] === 10000, [rows[0].total_is_formula, rows[0]['اجمالي سعر الحجز']]);
rows = runLookup({ 36: { ...R36, 'اجمالي سعر الحجز': '=12900' } }, { 36: { ...R36, 'اجمالي سعر الحجز': 12900 } });
check('a hand-typed constant total (=12900) is not a rate formula', rows[0].total_is_formula === false);
rows = runLookup({ 36: { ...R36, 'اجمالي سعر الحجز': '=1400+700' } }, { 36: { ...R36, 'اجمالي سعر الحجز': 2100 } });
check('neither is =1400+700', rows[0].total_is_formula === false);
rows = runLookup({ 36: { ...R36, 'اجمالي سعر الحجز': '=(650*I36)-2200' } }, { 36: { ...R36, 'اجمالي سعر الحجز': 900 } });
check('a rate with a discount is', rows[0].total_is_formula === true);
rows = runLookup({ 36: { ...R36, 'عدد الليالي': '=J36+1' } }, { 36: { ...R36, 'عدد الليالي': 4 } });
check('a formula that is not TODAY()-based shows its value', rows[0]['عدد الليالي'] === 4, rows[0]['عدد الليالي']);
rows = runLookup({ 36: { ...R36, 'تاريخ البداية': '2026-10-06' } });                                    // Review Focus 3
check('an ISO text date is kept', rows[0]['تاريخ البداية'] === '2026-10-06', rows[0]['تاريخ البداية']);
rows = runLookup({ 36: { ...R36, 'تاريخ البداية': '6/10/2026' } });
check('d/m/yyyy text becomes ISO', rows[0]['تاريخ البداية'] === '2026-10-06', rows[0]['تاريخ البداية']);
rows = runLookup({ 36: { ...R36, 'تاريخ المغادرة': 46302 } });
check('the departure serial becomes ISO too', rows[0]['تاريخ المغادرة'] === '2026-10-07', rows[0]['تاريخ المغادرة']);

section('lookup: the rows that are not bookings, and the odd ones that are');
rows = runLookup({ 2: { 'اسم المقيم': 'احمد حسن', 'تاريخ البداية': 46295, 'عدد الليالي': 12 },
  3: { 'ID': '19**', 'اسم المقيم': 'ناصر نزهه', 'اسم الشقة': 'انبي 2', 'رقم الغرفة': 1 }, 6: R36 });
check('a row with no ID is a booking with ID ""', rows[0]['ID'] === '' && rows[0]['اسم المقيم'] === 'احمد حسن', rows[0]);
check('a carried-over "19**" stays text', rows[1]['ID'] === '19**', rows[1]['ID']);
check('interior blank rows are skipped', rows.map(r => r.row_number).join() === '2,3,6', rows.map(r => r.row_number));
rows = runLookup({ 4: { 'ID': 9 } });
check('a row with an ID but no guest is not a booking', rows.length === 0, rows);
rows = runLookup({ 36: { ...R36, 'ملاحظات': 'ملغي' } });
check('a cancelled note passes through for the Brain to read', rows[0]['ملاحظات'] === 'ملغي');

section('lookup: nothing to read');                                                                    // Review Focus 1
const emptyRun = (a, b) => {
  const fn = new Function('$', src('build_bookings_lookup.js'));
  const $ = (name) => ({ first: () => ({ json: name === 'Fetch Bookings Formulas' ? a : b }) });
  return fn($);
};
check('an empty tab gives no rows (the node is alwaysOutputData, so the Brain still runs)', emptyRun({ values: [HEADERS] }, { values: [HEADERS] }).length === 0);
check('a failed fetch (an error item, no values) gives no rows and does not throw',
  emptyRun({ error: 'boom' }, { error: 'boom' }).length === 0);
check('so does a missing second fetch', (() => { const fn = new Function('$', src('build_bookings_lookup.js'));
  return fn((n) => { if (n === 'Fetch Bookings Values') throw new Error('Referenced node is unexecuted');
    return { first: () => ({ json: sheet({ 36: R36 }) }) }; }).length === 0; })());
rows = runLookup({ 36: R36 }, {});
check('formulas present but no values: the formula read stands in', rows.length === 1 && rows[0]['اسم المقيم'] === 'تبع عمر البيه', rows);

function runInput(file, body) {
  const fn = new Function('$input', '$', src(file));
  return fn({ first: () => ({ json: body }) }, () => { throw new Error('no named reads'); }).map(i => i.json);
}

section('registry: the الإتاحة tab, A2:B');
const REG = { values: [
  ['الشقة', 'الغرفة'], ['التاريخ'],
  ['ذاكر حسين', 1], ['ذاكر حسين', 2], ['انبي 2', 1], ['ابو حديد 11', 10], ['ابو حديد 11', 2], [], ['', 3], ['عبدالله العربي'],
] };
let reg = runInput('build_locations.js', REG);
check('the header row and the date row are not rooms', !reg.some(r => r['الشقة'] === 'الشقة' || r['الشقة'] === 'التاريخ'), reg);
check('rooms are strings, in the tab\'s order',
  JSON.stringify(reg.map(r => [r['الشقة'], r['الغرفة']])) ===
  JSON.stringify([['ذاكر حسين', '1'], ['ذاكر حسين', '2'], ['انبي 2', '1'], ['ابو حديد 11', '10'], ['ابو حديد 11', '2']]), reg);
check('a row with no apartment or no room is dropped', reg.length === 5, reg.length);
check('no values at all gives no rows', runInput('build_locations.js', { error: 'boom' }).length === 0);                // Review Focus 1
check('a header-only tab gives no rows', runInput('build_locations.js', { values: [['الشقة', 'الغرفة']] }).length === 0);

section('next booking id: the highest plain counter this month, plus one');
const ids = (...v) => ({ values: [['ID'], ...v.map(x => [x])] });
check('the highest plain number + 1', runInput('compute_next_booking_id.js', ids(1, 2, 44, 43))[0].next_booking_id === 45);
check('text and number cells both count', runInput('compute_next_booking_id.js', ids('7', 8))[0].next_booking_id === 9);
check('Arabic-Indic digits are folded', runInput('compute_next_booking_id.js', ids('٢٥', '٩'))[0].next_booking_id === 26);
check('a carried-over "104**" never counts', runInput('compute_next_booking_id.js', ids(3, '104**', '19**'))[0].next_booking_id === 4);
check('a passport-length number (> 6 digits) never counts', runInput('compute_next_booking_id.js', ids(3, '29876543210'))[0].next_booking_id === 4);
check('a blank row and the header never count', runInput('compute_next_booking_id.js', ids('', 5, ' '))[0].next_booking_id === 6);
check('an empty tab starts at 1', runInput('compute_next_booking_id.js', { values: [['ID']] })[0].next_booking_id === 1);
check('a failed read starts at 1 rather than throwing', runInput('compute_next_booking_id.js', { error: 'x' })[0].next_booking_id === 1);
check('cancelled bookings still spend their number (the ID cell is all that is read)', runInput('compute_next_booking_id.js', ids(1, 2, 3))[0].next_booking_id === 4);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
