/**
 * Offline harness for nodes/build_reports.js — the two daily reports
 * (availability: occupied rooms, today's departures, empty rooms; and the
 * outstanding balances), and the old ☀️ digest that is switched off behind
 * SEND_DAILY_DIGEST. Fakes the n8n Code-node globals and
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
function build(rows, iso, fn = buildFn, locations = null) {
  const withRowNums = rows.map((j, i) => ({ ...j, row_number: i + 2 }));
  const formulaRead = withRowNums.map(j => ({
    row_number: j.row_number,
    'عدد الليالي': j.__open ? `=TODAY()-J${j.row_number}` : j['عدد الليالي'],
  }));
  const $ = (name) => {
    if (name === 'Read Report Formulas') return { all: () => formulaRead.map(json => ({ json })) };
    if (name === 'Read Report Locations') {
      // No registry passed = the node is not in the graph, which is what a
      // deploy from before 2026-09-21 looks like. n8n throws on a reference to
      // a node that does not exist, so the harness does too.
      if (locations === null) throw new Error('Referenced node is unknown: Read Report Locations');
      return { all: () => locations.map(json => ({ json })) };
    }
    // 'Report Config' — the schedule branch's own Config node.
    return { first: () => ({ json: CONFIG }) };
  };
  const $input = { all: () => withRowNums.map(json => ({ json })) };
  return fn($, $input, frozenDate(iso)).map(i => i.json);
}

/** The same rows, run through the copy with the digest switched back on. */
const buildDigest = (rows, iso) => build(rows, iso, digestFn);

/** The room registry as Read Report Locations hands it over. */
const registry = (...pairs) => pairs.map(([apartment, room]) => ({
  'الشقة': apartment, 'الغرفة': String(room),
}));

/**
 * The report is two messages now, each of which may itself be packed into
 * several. Split the run on the debt title: everything before it is the
 * availability report, everything from it on is the debt report.
 */
function split(msgs) {
  const i = msgs.findIndex(m => m.text.includes('💰 *تقرير المديونيات*'));
  const join = (list) => list.map(m => m.text).join('\n');
  return i === -1
    ? { availability: join(msgs), debts: '', at: msgs.length }
    : { availability: join(msgs.slice(0, i)), debts: join(msgs.slice(i)), at: i };
}

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

section('two reports go out every morning');
let msgs = build([
  row({ 'اسم المقيم': 'واصل', 'تاريخ البداية': '2026-08-12', 'تاريخ المغادرة': '2026-08-15' }),
  row({ 'اسم المقيم': 'مغادر', 'تاريخ البداية': '2026-08-09', 'تاريخ المغادرة': '2026-08-12' }),
  row({ 'اسم المقيم': 'مقيم', 'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20',
        'المتبقي': 300 }),
], WED);
check('two messages on a weekday', msgs.length === 2, msgs.map(m => m.text));
check('both go to the reports group',
  msgs.every(m => m.chat_id === '-5057362381'), msgs.map(m => m.chat_id));
check('availability first, titled as today',
  msgs[0].text.startsWith('🏠 *تقرير الإتاحة* — 2026-08-12'), msgs[0].text);
check('debts second, titled as today',
  msgs[1].text.startsWith('💰 *تقرير المديونيات* — 2026-08-12'), msgs[1].text);
check('availability carries rooms and departures, not money',
  msgs[0].text.includes('🏠') && msgs[0].text.includes('🛫') && !msgs[0].text.includes('💰'),
  msgs[0].text);
check('the debt report carries money, and nothing else',
  msgs[1].text.includes('💰') && !msgs[1].text.includes('🏠') && !msgs[1].text.includes('🛫'),
  msgs[1].text);
check('the old ☀️ digest does not ride along',
  !msgs.some(m => m.text.includes('☀️')), msgs.map(m => m.text));

// The quiet day is the one that matters: a report that only appears when there
// is news cannot be told apart from a branch that has stopped running, which is
// how this one sat silent from 2026-08-28.
msgs = build([], WED);
check('an empty house still reports, twice', msgs.length === 2, msgs.map(m => m.text));
check('and says so in every section',
  msgs[0].text.includes('🏠 *الغرف المشغولة* — لا يوجد') &&
  msgs[0].text.includes('🛫 *مغادرة اليوم* — لا يوجد') &&
  msgs[1].text.includes('💰 *العملاء المدينون* — لا يوجد'), msgs.map(m => m.text));

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
let daily = split(msgs).availability;
check('a guest mid-stay is occupying', daily.includes('مقيم'), daily);
check('so is one who arrived today', daily.includes('واصل اليوم'), daily);
check('an open-ended stay is occupying, not departing',
  daily.includes('مفتوح') && !daily.includes('🛫 *مغادرة اليوم* (2)'), daily);
check('someone leaving today is a departure, not an occupied room',
  daily.indexOf('مغادر اليوم') > daily.indexOf('🛫'), daily);
check('a departure line separates the apartment from the room',
  daily.includes('• مغادر اليوم — انبي 3 · 4'), daily);
check('a future booking is not occupying', !daily.includes('قادم'), daily);
check('a finished stay is not occupying', !daily.includes('راحل'), daily);
check('three rooms, three guests', daily.includes('🏠 *الغرف المشغولة* (3 غرفة / 3 نزيل)'), daily);
check('grouped under the apartment', daily.includes('*ذاكر حسين*') && daily.includes('*انبي 3*'),
  daily);
// Asked for on 2026-09-21: no "منذ", no year — the arrival and the departure,
// day/month, because what the group reads off the line is when the bed frees up.
check('the line is the bare room number, then arrival and departure',
  daily.includes('• 2 — مقيم (10/08 ← 20/08)'), daily);
check('no "منذ" on an availability line', !daily.includes('منذ'), daily);
// "غرفة" is gone from the lines too (user, 2026-09-21): under an apartment
// heading the number on its own is enough. The section HEADINGS still count
// in غرف, so this only forbids the word on a bullet.
check('no "غرفة" on a room line',
  !daily.split('\n').some(l => l.trimStart().startsWith('•') && l.includes('غرفة')), daily);
// The title still carries the full date — it is the report's own datestamp, not
// a stay's. Only the guest lines lost the year.
check('and no year on a room line',
  !daily.split('\n').filter(l => l.trimStart().startsWith('•')).some(l => /\d{4}-\d{2}-\d{2}/.test(l)),
  daily);
check('an open-ended stay says so instead of a date',
  daily.includes('• 1 — مفتوح (20/07 ← مفتوح)'), daily);
check('rooms sort numerically, not as text',
  daily.indexOf('• 2 — مقيم') < daily.indexOf('• 10 — واصل اليوم'), daily);

section('two guests in one room count as one room');
msgs = build([
  row({ 'اسم المقيم': 'أخ', 'اسم الشقة': 'انبي 3', 'رقم الغرفة': '7',
        'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' }),
  row({ 'اسم المقيم': 'أخته', 'اسم الشقة': 'انبي 3', 'رقم الغرفة': '7',
        'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' }),
], WED);
// Without a registry this is the fallback layout, which still counts both.
check('one room, two guests', msgs[0].text.includes('🏠 *الغرف المشغولة* (1 غرفة / 2 نزيل)'),
  msgs[0].text);
// With one, the room gets a line per guest — they can hold different dates.
msgs = build([
  row({ 'اسم المقيم': 'أخ', 'اسم الشقة': 'انبي 3', 'رقم الغرفة': '7',
        'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' }),
  row({ 'اسم المقيم': 'أخته', 'اسم الشقة': 'انبي 3', 'رقم الغرفة': '7',
        'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-18' }),
], WED, buildFn, registry(['انبي 3', '7']));
check('both guests are named on their room',
  msgs[0].text.includes('  • 7 — أخ (10/08 ← 20/08)') &&
  msgs[0].text.includes('  • 7 — أخته (10/08 ← 18/08)'), msgs[0].text);

section('every room, taken or متاحه');
// The registry is the only thing that knows a room exists while nobody is in
// it. Since 2026-09-21 the report walks it room by room: a room either carries
// its guest or reads متاحه, so nobody has to subtract two lists in their head.
const ROOMS = registry(
  ['ذاكر حسين', '1'], ['ذاكر حسين', '2'], ['ذاكر حسين', '10'],
  ['انبي 3', '1'], ['انبي 3', '4'],
);
msgs = build([
  row({ 'اسم المقيم': 'مقيم', 'اسم الشقة': 'ذاكر حسين', 'رقم الغرفة': '2',
        'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' }),
  row({ 'اسم المقيم': 'مغادر اليوم', 'اسم الشقة': 'انبي 3', 'رقم الغرفة': '4',
        'تاريخ البداية': '2026-08-09', 'تاريخ المغادرة': '2026-08-12' }),
], WED, buildFn, ROOMS);
let rooms = split(msgs).availability;
check('every registry room is on the list',
  ['1', '2', '10'].every(n => rooms.includes(`  • ${n} — `)), rooms);
check('an empty room reads متاحه', rooms.includes('  • 1 — متاحه'), rooms);
check('an occupied one carries its guest', rooms.includes('  • 2 — مقيم (10/08 ← 20/08)'), rooms);
check('a room whose guest leaves today is available again today',
  rooms.includes('  • 4 — متاحه'), rooms);
check('registry order is kept — room 10 after room 2, not after room 1',
  rooms.indexOf('• 2 — مقيم') < rooms.indexOf('• 10 —'), rooms);
check('apartments head their own block',
  rooms.includes('*ذاكر حسين*') && rooms.includes('*انبي 3*'), rooms);
check('no occupied/empty split survives',
  !rooms.includes('🔓') && !rooms.includes('🏠 *الغرف المشغولة*'), rooms);
check('the rooms land in the availability report, not the debt one',
  !split(msgs).debts.includes('متاحه'), split(msgs).debts);

// A guest the registry has never heard of must not vanish off the report.
msgs = build([
  row({ 'اسم المقيم': 'غريب', 'اسم الشقة': 'شقة جديدة', 'رقم الغرفة': '9',
        'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' }),
  row({ 'اسم المقيم': 'مقيم', 'اسم الشقة': 'ذاكر حسين', 'رقم الغرفة': '7',
        'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' }),
], WED, buildFn, registry(['ذاكر حسين', '1']));
rooms = split(msgs).availability;
check('a room the registry does not list is appended, not dropped',
  rooms.includes('  • 7 — مقيم (10/08 ← 20/08)'), rooms);
check('and so is a whole unknown apartment',
  rooms.includes('*شقة جديدة*') && rooms.includes('  • 9 — غريب (10/08 ← 20/08)'), rooms);

// The node is wired continueRegularOutput, and a graph deployed before
// 2026-09-21 has no registry node at all. Without it the empty rooms cannot be
// named, so the report falls back to listing the occupied ones only — never to
// calling the building empty.
msgs = build([row({ 'اسم المقيم': 'مقيم', 'اسم الشقة': 'ذاكر حسين', 'رقم الغرفة': '2',
                    'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' })], WED);
check('an unreadable registry falls back to the occupied rooms',
  msgs[0].text.includes('🏠 *الغرف المشغولة* (1 غرفة / 1 نزيل)') &&
  msgs[0].text.includes('  • 2 — مقيم (10/08 ← 20/08)'), msgs[0].text);
check('and never reports a room as متاحه without the registry',
  !msgs[0].text.includes('متاحه'), msgs[0].text);
msgs = build([row({ 'اسم المقيم': 'مقيم', 'اسم الشقة': 'ذاكر حسين', 'رقم الغرفة': '2',
                    'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' })],
             WED, buildFn, []);
check('an empty registry does the same', !msgs[0].text.includes('متاحه'), msgs[0].text);

section('digest (flag on): arrivals and departures for today');
msgs = buildDigest([
  row({ 'اسم المقيم': 'واصل', 'تاريخ البداية': '2026-08-12', 'تاريخ المغادرة': '2026-08-15' }),
  row({ 'اسم المقيم': 'مغادر', 'تاريخ البداية': '2026-08-09', 'تاريخ المغادرة': '2026-08-12' }),
  row({ 'اسم المقيم': 'مقيم', 'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20' }),
], WED);
// Three now: the digest first, then the two reports that are always sent. This
// is the double-announcement the node's header warns about — the digest's own
// مغادرة اليوم section duplicates the availability report's.
check('the digest rides alongside both reports', msgs.length === 3, msgs.map(m => m.text));
check('goes to the reports group', msgs[0].chat_id === '-5057362381', msgs[0].chat_id);
check('arrivals listed', msgs[0].text.includes('🛬 *وصول اليوم* (1)') && msgs[0].text.includes('واصل'),
  msgs[0].text);
check('departures listed', msgs[0].text.includes('🛫 *مغادرة اليوم* (1)') && msgs[0].text.includes('مغادر'),
  msgs[0].text);
check('a guest merely staying is in neither list', !msgs[0].text.includes('مقيم'), msgs[0].text);

section('digest (flag on): stays quiet on a quiet day');
msgs = buildDigest([row({ 'تاريخ البداية': '2026-08-01', 'تاريخ المغادرة': '2026-08-04' })], WED);
check('no arrivals, no departures, no digest',
  msgs.length === 2 && !msgs.some(m => m.text.includes('☀️')), msgs.map(m => m.text));

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

section('debts: a message of their own, every day');
// Saturdays-only until 2026-09-21, then a section of the daily report for a
// few hours, then its own message again — the weekday gate is gone either way:
// the same rows report the same debts midweek as at the weekend.
const withDebt = [
  row({ 'اسم المقيم': 'مدين كبير', 'المتبقي': 1500 }),
  row({ 'اسم المقيم': 'مدين صغير', 'المتبقي': 250.5 }),
  row({ 'اسم المقيم': 'خالص', 'المتبقي': 0 }),
];
const midweek = split(build(withDebt, WED)).debts;
const weekend = split(build(withDebt, SAT)).debts;
check('debts are reported midweek', midweek.includes('💰 *العملاء المدينون* (2)'), midweek);
check('and the weekend says the same thing',
  weekend.includes('💰 *العملاء المدينون* (2)'), weekend);
check('largest debt first', midweek.indexOf('مدين كبير') < midweek.indexOf('مدين صغير'), midweek);
// Apartment heading, then "room. name: amount" under it (user, 2026-09-27).
// No "متبقي", the title says it.
check('a debt line is "room. name: amount"',
  midweek.split('\n').includes('1. مدين كبير: 1500'), midweek);
check('the apartment is a heading, once',
  midweek.split('*ذاكر حسين*').length === 2 &&
  midweek.indexOf('*ذاكر حسين*') < midweek.indexOf('مدين كبير'), midweek);
check('no "متبقي" on a debt line', !midweek.includes('متبقي'), midweek);
check('a settled booking is left out', !midweek.includes('خالص'), midweek);
// The total line came off on 2026-09-21: the list is what gets acted on.
check('no total under the list', !midweek.includes('الإجمالي'), midweek);

// Grouped by apartment, in the registry's order, since 2026-09-24 — the same
// order the availability report walks the building in. Amount only decides
// between two guests in the SAME apartment.
const spread = build([
  row({ 'اسم المقيم': 'ب صغير', 'اسم الشقة': 'انبي 2', 'المتبقي': 100 }),
  row({ 'اسم المقيم': 'ا كبير', 'اسم الشقة': 'انبي 1', 'المتبقي': 900 }),
  row({ 'اسم المقيم': 'ب كبير', 'اسم الشقة': 'انبي 2', 'المتبقي': 800 }),
  row({ 'اسم المقيم': 'ا صغير', 'اسم الشقة': 'انبي 1', 'المتبقي': 200 }),
], WED, undefined, registry(['انبي 1', 1], ['انبي 2', 1]));
const order = split(spread).debts;
const seq = ['ا كبير', 'ا صغير', 'ب كبير', 'ب صغير'].map(n => order.indexOf(n));
check('debts follow the registry apartment order, biggest first inside one',
  seq.every((v, i) => v !== -1 && (i === 0 || seq[i - 1] < v)), order);
check('each apartment heads its own guests',
  order.indexOf('*انبي 1*') < seq[0] && seq[1] < order.indexOf('*انبي 2*') &&
  order.indexOf('*انبي 2*') < seq[2], order);

// Inside an apartment, room order — numeric, so 10 comes after 2 — whatever
// the amounts (user, 2026-09-27).
const debtRooms = split(build([
  row({ 'اسم المقيم': 'غرفة عشرة', 'رقم الغرفة': '10', 'المتبقي': 9000 }),
  row({ 'اسم المقيم': 'غرفة اثنين', 'رقم الغرفة': '2', 'المتبقي': 50 }),
  row({ 'اسم المقيم': 'غرفة واحد', 'رقم الغرفة': '1', 'المتبقي': 10 }),
], WED)).debts;
const roomSeq = ['غرفة واحد', 'غرفة اثنين', 'غرفة عشرة'].map(n => debtRooms.indexOf(n));
check('debts inside an apartment go by room number, numerically',
  roomSeq.every((v, i) => v !== -1 && (i === 0 || roomSeq[i - 1] < v)), debtRooms);

// A guest whose apartment the registry does not carry still gets reported —
// after the apartments it knows, not wedged between them.
const stray = split(build([
  row({ 'اسم المقيم': 'غريب', 'اسم الشقة': 'شقة مجهولة', 'المتبقي': 5000 }),
  row({ 'اسم المقيم': 'معروف', 'اسم الشقة': 'انبي 1', 'المتبقي': 10 }),
], WED, undefined, registry(['انبي 1', 1]))).debts;
check('an unknown apartment sorts last, not first',
  stray.indexOf('معروف') !== -1 && stray.indexOf('معروف') < stray.indexOf('غريب'), stray);

msgs = build([row({ 'المتبقي': 0 })], WED);
check('an all-settled day still reports, positively',
  split(msgs).debts.includes('💰 *العملاء المدينون* — لا يوجد'), msgs.map(m => m.text));

section('a full house is split, not truncated');
// Telegram refuses anything over 4096 characters, so the node packs lines into
// as many messages as it takes. 120 occupied rooms is past the limit; the point
// is that they all still arrive.
msgs = build(Array.from({ length: 120 }, (_, i) => row({
  'اسم المقيم': `نزيل رقم ${i}`, 'اسم الشقة': 'ذاكر حسين', 'رقم الغرفة': String(i + 1),
  'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20',
})), WED);
check('the availability report alone takes several messages', split(msgs).at > 1, msgs.length);
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

section('on demand: the 🏠 تقرير الإتاحة button');
{
  // The button's chain: its own twins of the schedule's nodes, and Report
  // Config never ran — n8n throws on a reference to it.
  const rows = [
    row({ 'اسم المقيم': 'ساكن', 'تاريخ البداية': '2026-08-10', 'تاريخ المغادرة': '2026-08-20',
      'المتبقي': 500 }),
  ].map((j, i) => ({ ...j, row_number: i + 2 }));
  const $ = (name) => {
    if (name === 'Read Availability Formulas') {
      return { all: () => rows.map(j => ({ json: { row_number: j.row_number, 'عدد الليالي': 10 } })) };
    }
    if (name === 'Read Availability Locations') {
      return { all: () => registry(['ذاكر حسين', 1], ['ذاكر حسين', 2]).map(json => ({ json })) };
    }
    if (name === 'Availability Config') return { first: () => ({ json: CONFIG }) };
    throw new Error(`Referenced node is unexecuted: ${name}`);
  };
  const $input = { all: () => rows.map(json => ({ json })) };
  const out = buildFn($, $input, frozenDate(WED)).map(i => i.json);
  const text = out.map(m => m.text).join('\n');
  check('sends the availability report', text.includes('🏠 *تقرير الإتاحة*'), text);
  check('lists the guest and the free room', text.includes('ساكن') && text.includes('متاحه'), text);
  check('and not the debt report', !text.includes('💰'), text);
  check('to the reports group', out.every(m => m.chat_id === '-5057362381'), out);
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
