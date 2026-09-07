/**
 * Offline harness for nodes/build_reports.js — the scheduled debt report, and
 * the daily digest that is switched off behind SEND_DAILY_DIGEST. Fakes the n8n
 * Code-node globals and pins "today" so the assertions do not drift with the
 * calendar.
 *
 *     node booking_bot/test_reports.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'nodes', 'build_reports.js'), 'utf8');
const buildFn = new Function('$', '$input', 'Date', src);

// The daily digest was switched off on 2026-08-28, so the shipped source says
// nothing six mornings a week. Its logic is still exercised, against a copy of
// the source with the flag flipped: the digest is one word from being live
// again, and untested code that is one word from live is the worst of both.
// Flipping it here rather than editing the node keeps the two facts separate —
// what the bot sends today, and what it would send if it were turned back on.
const FLAG = 'const SEND_DAILY_DIGEST = false;';
if (!src.includes(FLAG)) {
  throw new Error(`build_reports.js no longer contains ${JSON.stringify(FLAG)};`
    + ' the digest tests below would silently stop testing anything.');
}
const digestFn = new Function('$', '$input', 'Date',
  src.replace(FLAG, 'const SEND_DAILY_DIGEST = true;'));

const CONFIG = { TIMEZONE: 'Africa/Cairo', REPORT_GROUP_CHAT_ID: '-5057362381' };

/**
 * Freeze the clock. The node asks the real Intl for "today in Cairo", so the
 * fake Date has to be a genuine Date subclass rather than a stub.
 */
function frozenDate(iso) {
  return class extends Date {
    constructor(...args) {
      if (args.length === 0) super(iso);
      else super(...args);
    }
    static now() { return new Date(iso).getTime(); }
  };
}

/**
 * `rows` are the evaluated read. A row is open-ended when it says so via
 * `__open`, which the harness turns into the second (FORMULA) read exactly as
 * the sheet would: a live =TODAY()-J formula in عدد الليالي.
 */
function build(rows, iso, fn = buildFn) {
  const withRowNums = rows.map((j, i) => ({ ...j, row_number: i + 2 }));
  const formulaRead = withRowNums.map(j => ({
    row_number: j.row_number,
    'عدد الليالي': j.__open ? `=TODAY()-J${j.row_number}` : j['عدد الليالي'],
  }));
  const $ = (name) => {
    if (name === 'Read Report Formulas') return { all: () => formulaRead.map(json => ({ json })) };
    // 'Report Config' — the schedule branch's own Config node.
    return { first: () => ({ json: CONFIG }) };
  };
  const $input = { all: () => withRowNums.map(json => ({ json })) };
  return fn($, $input, frozenDate(iso)).map(i => i.json);
}

/** The same rows, run through the copy with the digest switched back on. */
const buildDigest = (rows, iso) => build(rows, iso, digestFn);

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` → ${JSON.stringify(detail)}` : ''}`); }
}
function section(n) { console.log(`\n${n}`); }

const row = (o) => ({
  'اسم المقيم': 'ضيف', 'اسم الشقة': 'ذاكر حسين', 'رقم الغرفة': '1',
  'تاريخ البداية': '2026-08-01', 'عدد الليالي': 3, 'تاريخ المغادرة': '2026-08-04',
  'المتبقي': '', 'ملاحظات': '', ...o,
});

// 2026-08-12 is a Wednesday, 2026-08-15 a Saturday.
const WED = '2026-08-12T06:00:00Z';
const SAT = '2026-08-15T06:00:00Z';

section('the daily digest is OFF');
// What the bot actually does now. A weekday with arrivals, departures and a long
// open stay — every reason the digest ever had to speak — and it says nothing.
let msgs = build([
  row({ 'اسم المقيم': 'واصل', 'تاريخ البداية': '2026-08-12', 'تاريخ المغادرة': '2026-08-15' }),
  row({ 'اسم المقيم': 'مغادر', 'تاريخ البداية': '2026-08-09', 'تاريخ المغادرة': '2026-08-12' }),
  row({ 'اسم المقيم': 'طويل', 'تاريخ البداية': '2026-06-01', 'تاريخ المغادرة': '2026-08-12',
        'عدد الليالي': 72, __open: true }),
], WED);
check('no message on a weekday, however busy', msgs.length === 0, msgs.map(m => m.text));

// And it is the DIGEST that is off, not the whole node: Saturday's debt report
// still goes out. Switching one off by breaking the other is the failure this
// pins.
msgs = build([row({ 'اسم المقيم': 'مدين', 'تاريخ البداية': '2026-08-15', 'المتبقي': 400 })], SAT);
check('Saturday still carries the debt report',
  msgs.length === 1 && msgs[0].text.includes('💰 *المبالغ المتبقية*'), msgs.map(m => m.text));
check('and no digest rides along with it',
  !msgs.some(m => m.text.includes('☀️')), msgs.map(m => m.text));

section('digest (flag on): arrivals and departures for today');
msgs = buildDigest([
  row({ 'اسم المقيم': 'واصل', 'تاريخ البداية': '2026-08-12', 'تاريخ المغادرة': '2026-08-15' }),
  row({ 'اسم المقيم': 'مغادر', 'تاريخ البداية': '2026-08-09', 'تاريخ المغادرة': '2026-08-12' }),
  row({ 'اسم المقيم': 'مقيم', 'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' }),
], WED);
check('one message on a weekday', msgs.length === 1, msgs.map(m => m.text));
check('goes to the reports group', msgs[0].chat_id === '-5057362381', msgs[0].chat_id);
check('arrivals listed', msgs[0].text.includes('🛬 *وصول اليوم* (1)') && msgs[0].text.includes('واصل'),
  msgs[0].text);
check('departures listed', msgs[0].text.includes('🛫 *مغادرة اليوم* (1)') && msgs[0].text.includes('مغادر'),
  msgs[0].text);
check('a guest merely staying is in neither list', !msgs[0].text.includes('مقيم'), msgs[0].text);

section('digest (flag on): stays nothing on a quiet day');
msgs = buildDigest([row({ 'تاريخ البداية': '2026-08-01', 'تاريخ المغادرة': '2026-08-04' })], WED);
check('no arrivals, no departures, no message', msgs.length === 0, msgs);

section('digest (flag on): long open-ended stays');
msgs = buildDigest([
  row({ 'اسم المقيم': 'طويل', 'تاريخ البداية': '2026-06-01', 'تاريخ المغادرة': '2026-08-12',
        'عدد الليالي': 72, __open: true }),
  row({ 'اسم المقيم': 'قصير', 'تاريخ البداية': '2026-08-05', 'تاريخ المغادرة': '2026-08-12',
        'عدد الليالي': 7, __open: true }),
], WED);
check('a stay over 30 days is surfaced',
  msgs[0].text.includes('طويل') && msgs[0].text.includes('72 يوم'), msgs[0].text);
check('a recent one is not', !msgs[0].text.includes('قصير'), msgs[0].text);

section('digest (flag on): an open-ended stay is not a departure, every single day');
// The sheet derives تاريخ المغادرة as J + I, and I is a live =TODAY()-J, so an
// open stay evaluates to "leaving today" on every date it is ever read. Without
// the second FORMULA read there is no way to tell it from a real checkout, and
// the digest would name the same guest as departing for months.
msgs = buildDigest([
  row({ 'اسم المقيم': 'مفتوح', 'تاريخ البداية': '2026-08-01', 'تاريخ المغادرة': '2026-08-12',
        'عدد الليالي': 11, __open: true }),
  row({ 'اسم المقيم': 'حقيقي', 'تاريخ البداية': '2026-08-09', 'تاريخ المغادرة': '2026-08-12',
        'عدد الليالي': 3 }),
], WED);
check('the real checkout is listed', msgs[0].text.includes('حقيقي'), msgs[0].text);
check('the open-ended stay is not', !msgs[0].text.includes('مفتوح'), msgs[0].text);
check('exactly one departure', msgs[0].text.includes('🛫 *مغادرة اليوم* (1)'), msgs[0].text);

section('cancelled rows are ignored everywhere');
// Run with the digest on, so one Saturday covers both reports at once.
msgs = buildDigest([
  row({ 'اسم المقيم': 'ملغى', 'تاريخ البداية': '2026-08-12', 'ملاحظات': 'ملغي', 'المتبقي': 500 }),
], SAT);
check('not an arrival, and not a debt',
  msgs.every(m => !m.text.includes('ملغى')), msgs.map(m => m.text));

section('debt report: Saturdays only');
const withDebt = [
  row({ 'اسم المقيم': 'مدين كبير', 'المتبقي': 1500 }),
  row({ 'اسم المقيم': 'مدين صغير', 'المتبقي': 250.5 }),
  row({ 'اسم المقيم': 'خالص', 'المتبقي': 0 }),
];
msgs = build(withDebt, WED);
check('no debt report midweek', msgs.length === 0, msgs.map(m => m.text));

msgs = build(withDebt, SAT);
check('one message on Saturday', msgs.length === 1, msgs.map(m => m.text));
const debt = msgs[0].text;
check('titled as the debt report', debt.includes('💰 *المبالغ المتبقية*'), debt);
check('largest debt first', debt.indexOf('مدين كبير') < debt.indexOf('مدين صغير'), debt);
check('a settled booking is left out', !debt.includes('خالص'), debt);
check('total is summed', debt.includes('*الإجمالي المتبقي: 1750.5*'), debt);

msgs = build([row({ 'المتبقي': 0 })], SAT);
check('an all-settled Saturday still reports, positively',
  msgs.length === 1 && msgs[0].text.includes('✅ لا توجد مبالغ متبقية'), msgs.map(m => m.text));

section('markdown safety');
msgs = buildDigest([row({ 'اسم المقيم': 'ضيف_مهم *جدا*', 'تاريخ البداية': '2026-08-12' })], WED);
const balanced = (s) =>
  (s.match(/(?<!\\)\*/g) || []).length % 2 === 0 && (s.match(/(?<!\\)_/g) || []).length % 2 === 0;
check('a guest name cannot break the message', balanced(msgs[0].text), msgs[0].text);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
