/**
 * Offline harness for nodes/build_reports.js — the daily report (occupied
 * rooms, today's departures, outstanding balances), and the old ☀️ digest that
 * is switched off behind SEND_DAILY_DIGEST. Fakes the n8n Code-node globals and
 * pins "today" so the assertions do not drift with the calendar.
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

section('the daily report goes out every morning');
let msgs = build([
  row({ 'اسم المقيم': 'واصل', 'تاريخ البداية': '2026-08-12', 'تاريخ المغادرة': '2026-08-15' }),
  row({ 'اسم المقيم': 'مغادر', 'تاريخ البداية': '2026-08-09', 'تاريخ المغادرة': '2026-08-12' }),
  row({ 'اسم المقيم': 'مقيم', 'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' }),
], WED);
check('one message on a weekday', msgs.length === 1, msgs.map(m => m.text));
check('goes to the reports group', msgs[0].chat_id === '-5057362381', msgs[0].chat_id);
check('titled as today', msgs[0].text.startsWith('📋 *تقرير اليوم* — 2026-08-12'), msgs[0].text);
check('carries all three sections',
  ['🏠', '🛫', '💰'].every(icon => msgs[0].text.includes(icon)), msgs[0].text);
check('the old ☀️ digest does not ride along',
  !msgs.some(m => m.text.includes('☀️')), msgs.map(m => m.text));

// The quiet day is the one that matters: a report that only appears when there
// is news cannot be told apart from a branch that has stopped running, which is
// how this one sat silent from 2026-08-28.
msgs = build([], WED);
check('an empty house still reports', msgs.length === 1, msgs.map(m => m.text));
check('and says so in every section',
  msgs[0].text.includes('🏠 *الغرف المشغولة* — لا يوجد') &&
  msgs[0].text.includes('🛫 *مغادرة اليوم* — لا يوجد') &&
  msgs[0].text.includes('💰 *العملاء المدينون* — لا يوجد'), msgs[0].text);

section('occupied rooms');
msgs = build([
  row({ 'اسم المقيم': 'مقيم', 'اسم الشقة': 'ذاكر حسين', 'رقم الغرفة': '2',
        'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' }),
  row({ 'اسم المقيم': 'واصل اليوم', 'اسم الشقة': 'ذاكر حسين', 'رقم الغرفة': '10',
        'تاريخ البداية': '2026-08-12', 'تاريخ المغادرة': '2026-08-15' }),
  row({ 'اسم المقيم': 'مفتوح', 'اسم الشقة': 'انبي 3', 'رقم الغرفة': '1',
        'تاريخ البداية': '2026-07-20', 'تاريخ المغادرة': '2026-08-12',
        'عدد الليالي': 23, __open: true }),
  row({ 'اسم المقيم': 'مغادر اليوم', 'اسم الشقة': 'انبي 3', 'رقم الغرفة': '4',
        'تاريخ البداية': '2026-08-09', 'تاريخ المغادرة': '2026-08-12' }),
  row({ 'اسم المقيم': 'قادم', 'اسم الشقة': 'انبي 3', 'رقم الغرفة': '5',
        'تاريخ البداية': '2026-08-20', 'تاريخ المغادرة': '2026-08-25' }),
  row({ 'اسم المقيم': 'راحل', 'اسم الشقة': 'انبي 3', 'رقم الغرفة': '6',
        'تاريخ البداية': '2026-08-01', 'تاريخ المغادرة': '2026-08-04' }),
], WED);
let daily = msgs[0].text;
check('a guest mid-stay is occupying', daily.includes('مقيم'), daily);
check('so is one who arrived today', daily.includes('واصل اليوم'), daily);
check('an open-ended stay is occupying, not departing',
  daily.includes('مفتوح') && !daily.includes('🛫 *مغادرة اليوم* (2)'), daily);
check('someone leaving today is a departure, not an occupied room',
  daily.indexOf('مغادر اليوم') > daily.indexOf('🛫'), daily);
check('a future booking is not occupying', !daily.includes('قادم'), daily);
check('a finished stay is not occupying', !daily.includes('راحل'), daily);
check('three rooms, three guests', daily.includes('🏠 *الغرف المشغولة* (3 غرفة / 3 نزيل)'), daily);
check('grouped under the apartment', daily.includes('*ذاكر حسين*') && daily.includes('*انبي 3*'),
  daily);
check('and the room number is on the line', daily.includes('• غرفة 2 — مقيم (منذ 2026-08-10)'),
  daily);
check('rooms sort numerically, not as text',
  daily.indexOf('غرفة 2 — مقيم') < daily.indexOf('غرفة 10 — واصل اليوم'), daily);

section('two guests in one room count as one room');
msgs = build([
  row({ 'اسم المقيم': 'أخ', 'اسم الشقة': 'انبي 3', 'رقم الغرفة': '7',
        'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' }),
  row({ 'اسم المقيم': 'أخته', 'اسم الشقة': 'انبي 3', 'رقم الغرفة': '7',
        'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' }),
], WED);
check('one room, two guests', msgs[0].text.includes('🏠 *الغرف المشغولة* (1 غرفة / 2 نزيل)'),
  msgs[0].text);

section('digest (flag on): arrivals and departures for today');
msgs = buildDigest([
  row({ 'اسم المقيم': 'واصل', 'تاريخ البداية': '2026-08-12', 'تاريخ المغادرة': '2026-08-15' }),
  row({ 'اسم المقيم': 'مغادر', 'تاريخ البداية': '2026-08-09', 'تاريخ المغادرة': '2026-08-12' }),
  row({ 'اسم المقيم': 'مقيم', 'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' }),
], WED);
// Two now: the digest first, then the daily report that is always sent. This is
// the double-announcement the node's header warns about — the digest's own
// مغادرة اليوم section duplicates the daily report's.
check('the digest rides alongside the daily report', msgs.length === 2, msgs.map(m => m.text));
check('goes to the reports group', msgs[0].chat_id === '-5057362381', msgs[0].chat_id);
check('arrivals listed', msgs[0].text.includes('🛬 *وصول اليوم* (1)') && msgs[0].text.includes('واصل'),
  msgs[0].text);
check('departures listed', msgs[0].text.includes('🛫 *مغادرة اليوم* (1)') && msgs[0].text.includes('مغادر'),
  msgs[0].text);
check('a guest merely staying is in neither list', !msgs[0].text.includes('مقيم'), msgs[0].text);

section('digest (flag on): stays quiet on a quiet day');
msgs = buildDigest([row({ 'تاريخ البداية': '2026-08-01', 'تاريخ المغادرة': '2026-08-04' })], WED);
check('no arrivals, no departures, no digest',
  msgs.length === 1 && !msgs[0].text.includes('☀️'), msgs.map(m => m.text));

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

section('debts: a section of the daily report, every day');
// This used to be a message of its own, on Saturdays. Asked for daily on
// 2026-09-21, so the weekday gate is gone: the same rows report the same debts
// midweek as at the weekend.
const withDebt = [
  row({ 'اسم المقيم': 'مدين كبير', 'المتبقي': 1500 }),
  row({ 'اسم المقيم': 'مدين صغير', 'المتبقي': 250.5 }),
  row({ 'اسم المقيم': 'خالص', 'المتبقي': 0 }),
];
const midweek = build(withDebt, WED)[0].text;
const weekend = build(withDebt, SAT)[0].text;
check('debts are reported midweek', midweek.includes('💰 *العملاء المدينون* (2)'), midweek);
check('and the weekend says the same thing',
  weekend.includes('💰 *العملاء المدينون* (2)'), weekend);
check('largest debt first', midweek.indexOf('مدين كبير') < midweek.indexOf('مدين صغير'), midweek);
check('a settled booking is left out', !midweek.includes('خالص'), midweek);
check('total is summed', midweek.includes('*الإجمالي المتبقي: 1750.5*'), midweek);

msgs = build([row({ 'المتبقي': 0 })], WED);
check('an all-settled day still reports, positively',
  msgs[0].text.includes('💰 *العملاء المدينون* — لا يوجد'), msgs.map(m => m.text));

section('a full house is split, not truncated');
// Telegram refuses anything over 4096 characters, so the node packs lines into
// as many messages as it takes. 120 occupied rooms is past the limit; the point
// is that they all still arrive.
msgs = build(Array.from({ length: 120 }, (_, i) => row({
  'اسم المقيم': `نزيل رقم ${i}`, 'اسم الشقة': 'ذاكر حسين', 'رقم الغرفة': String(i + 1),
  'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20',
})), WED);
check('more than one message', msgs.length > 1, msgs.length);
check('every one is under the Telegram limit', msgs.every(m => m.text.length <= 4096),
  msgs.map(m => m.text.length));
check('every one goes to the reports group',
  msgs.every(m => m.chat_id === '-5057362381'), msgs.map(m => m.chat_id));
const whole = msgs.map(m => m.text).join(' ');
check('no guest is lost in the split',
  Array.from({ length: 120 }, (_, i) => `نزيل رقم ${i}`).every(n => whole.includes(n)),
  msgs.map(m => m.text.length));

section('markdown safety');
msgs = buildDigest([row({ 'اسم المقيم': 'ضيف_مهم *جدا*', 'تاريخ البداية': '2026-08-12' })], WED);
const balanced = (s) =>
  (s.match(/(?<!\\)\*/g) || []).length % 2 === 0 && (s.match(/(?<!\\)_/g) || []).length % 2 === 0;
check('a guest name cannot break the message', balanced(msgs[0].text), msgs[0].text);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
