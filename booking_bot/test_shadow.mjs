/**
 * Offline harness for nodes/build_shadow_write.js — the dual-write mirror.
 *
 *     node booking_bot/test_shadow.mjs
 *
 * Drives the real Brain to produce real save payloads, then feeds them to the
 * shadow builder, so the two cannot drift apart the way a hand-written fixture
 * would.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const brainSrc = readFileSync(join(HERE, 'brain.js'), 'utf8');
const shadowSrc = readFileSync(join(HERE, 'nodes', 'build_shadow_write.js'), 'utf8');
const buildBookingSrc = readFileSync(join(HERE, 'nodes', 'build_booking_row.js'), 'utf8');
const buildExpenseSrc = readFileSync(join(HERE, 'nodes', 'build_expense_row.js'), 'utf8');
const buildLineSrc = readFileSync(join(HERE, 'nodes', 'build_line_rows.js'), 'utf8');

const brainFn = new Function('$', brainSrc);
const shadowFn = new Function('$', shadowSrc);
const buildBookingFn = new Function('$', '$input', buildBookingSrc);
const buildExpenseFn = new Function('$', '$input', buildExpenseSrc);
const buildLineFn = new Function('$', buildLineSrc);

const CONFIG = {
  BOT_TOKEN: 'x', BOOKINGS_SHEET_ID: 's', BOOKINGS_TAB: 'إدخال الحجوزات',
  EXPENSE_TAB: 'مصروفات عامة', GROUP_CHAT_ID: '-1', EXPENSE_GROUP_CHAT_ID: '-2',
  ADMIN_USERS: '7941350507', CASHIER_USERS: '@Seifgamal24', TIMEZONE: 'Africa/Cairo',
};

const USER = { id: 7941350507, first_name: 'Ahmed', last_name: 'Isa', username: 'ahmed' };
const CHAT = { id: 999 };
const msg = (text, from = USER) => ({ message: { chat: CHAT, from, text } });
const cb = (data, from = USER) => ({
  callback_query: { id: 'c', data, from, message: { chat: CHAT } },
});
// A transfer receipt: Telegram sends sizes, and the bot keeps the largest file_id.
const photo = (fileId, from = USER) => ({
  message: { chat: CHAT, from, photo: [{ file_id: `${fileId}_small` }, { file_id: fileId }] },
});

let sessionRow = {}, lastBrain = null, sheetRows = null;
const ROOMS = { 'ذاكر حسين': 5, 'احمد فهيم': 5, 'انبي 3': 4, 'انبي 2': 4, 'ابو حديد 11': 4, 'عبدالله العربي': 4 };
const locationRows = Object.entries(ROOMS).flatMap(([a, n]) =>
  Array.from({ length: n }, (_, i) => ({ 'الشقة': a, 'الغرفة': String(i + 1) })));

function run(update) {
  const $ = (name) => {
    const map = { Config: CONFIG, 'Telegram Trigger': update, 'Load Session': sessionRow };
    if (name === 'Read Locations') return { all: () => locationRows.map(json => ({ json })) };
    if (name === 'Read Bookings For Edit') {
      if (sheetRows === null) throw new Error('unexecuted');
      return { all: () => sheetRows.map((j, i) => ({ json: { ...j, row_number: i + 2 } })) };
    }
    return { first: () => ({ json: map[name] }) };
  };
  const items = brainFn($);
  lastBrain = items.length ? items[0].json : null;
  if (lastBrain) {
    sessionRow = { chat_id: lastBrain.chatId, state: lastBrain.sessionState,
                   data: lastBrain.sessionData, updated_at: Date.now() };
  }
  return lastBrain;
}
function reset() { sessionRow = {}; }

/** Run the shadow builder as the graph would, after a given Build * Row node. */
function shadow({ builder = null, filledRows = 6 } = {}) {
  let built = null;
  const $b = () => ({ json: lastBrain, first: () => ({ json: lastBrain }) });
  const items = Array.from({ length: filledRows }, (_, i) => ({ json: { k: i } }));
  if (builder === 'booking') built = buildBookingFn($b, { all: () => items })[0].json;
  if (builder === 'expense') built = buildExpenseFn($b, { all: () => items })[0].json;
  // The payment_line branch: its builder emits the line first and the booking's
  // own row second, and the shadow write reads the LINE's row number off it.
  if (builder === 'line') built = buildLineFn($b)[0].json;
  const builtNode = { expense: 'Build Expense Row', line: 'Build Line Rows' }[builder]
    || 'Build Booking Row';
  const $ = (name) => {
    if (name === 'Brain') return { first: () => ({ json: lastBrain }) };
    if (name === builtNode) {
      if (!built) throw new Error('unexecuted');
      return { first: () => ({ json: built }) };
    }
    throw new Error('unexecuted');
  };
  const out = shadowFn($);
  return out.length ? out[0].json : null;
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` → ${JSON.stringify(detail)}` : ''}`); }
}
function section(n) { console.log(`\n${n}`); }

const SHEET = [
  { 'ID': '77777', 'اسم المقيم': 'Sara Omar', 'اسم الشقة': 'انبي 2', 'رقم الغرفة': 3,
    'تاريخ البداية': '2026-08-04', 'اجمالي سعر الحجز': 1200, 'اجمالي ما تم دفعه': 1200,
    'طريقة الدفع': 'كاش', 'ملاحظات': '',
    booking_id: 12, lines: [], block_end: 2, total_is_formula: false },
];

function newBooking({ nights = 'nights_3', pay = 'pay_cash' } = {}) {
  reset();
  run(msg('/start')); run(cb('choice_booking')); run(cb('bid_skip'));
  run(msg('A-1')); run(msg('محمد علي')); run(cb('bt_external')); run(msg('01012345678'));
  run(cb('ar_0_2')); run(cb(nights)); run(cb('cal_day_2026_09_10'));
  run(msg('5000')); run(cb(pay));
  if (pay !== 'pay_unpaid') run(msg('2000'));
  run(cb('notes_skip'));
  return run(cb('save'));
}

section('booking: mirrors the row the sheet write landed on');
newBooking();
let s = shadow({ builder: 'booking', filledRows: 6 });
check('row matches Build Booking Row (6 filled + 2)', s.sheet_row === 8, s.sheet_row);
check('flow tagged', s.flow === 'booking');
check('upserts on sheet_row', s.sql.includes('on conflict (sheet_row) do update'), s.sql);
check('guest name carried', s.sql.includes("'محمد علي'"), s.sql);
check('apartment and room carried',
  s.sql.includes("'ذاكر حسين'") && s.sql.includes('room_number') && s.sql.includes("'2'"),
  s.sql);
check('arrival cast to date', s.sql.includes("'2026-09-10'::date"), s.sql);
check('nights is a number, open_ended false',
  /values \([^)]*, 3, false,/.test(s.sql), s.sql);
check("the sheet's text-forcing apostrophe is stripped",
  s.sql.includes("'A-1'") && !s.sql.includes("''A-1"), s.sql);
check('phone kept as text, leading zero intact', s.sql.includes("'01012345678'"), s.sql);
check('source tagged bot', s.sql.includes("'bot'"), s.sql);

section('booking: an open-ended stay is recorded as open, not as a formula');
newBooking({ nights: 'nights_inf' });
s = shadow({ builder: 'booking', filledRows: 6 });
check('open_ended true and nights NULL, not the =TODAY() text',
  /values \([^)]*, NULL, true,/.test(s.sql) && !s.sql.includes('TODAY'), s.sql);

section('booking: غير مدفوع');
newBooking({ pay: 'pay_unpaid' });
s = shadow({ builder: 'booking', filledRows: 10 });
check('row = 12', s.sheet_row === 12, s.sheet_row);
check('paid coalesced to 0', s.sql.includes('coalesce(0, 0)'), s.sql);
check('payment method carried', s.sql.includes("'غير مدفوع'"), s.sql);

section('edit: mirrors only the columns that changed, on the looked-up row');
reset();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));
sheetRows = null;
run(cb('ef_paid')); run(msg('300')); run(cb('xpay_cash')); run(cb('xleft_no'));
run(cb('xedone'));
s = shadow();
check('row comes from the lookup', s.sheet_row === 2, s.sheet_row);
check('paid updated', s.sql.includes('coalesce(1500, 0)') &&
  s.sql.includes('paid = excluded.paid'), s.sql);
check('payment method updated',
  s.sql.includes("'كاش'") && s.sql.includes('payment_method = excluded.payment_method'), s.sql);
check('untouched columns are not written',
  !s.sql.includes('guest_name') && !s.sql.includes('arrival'), s.sql);

section('payments: a payment is an event, not a cell');
newBooking();
s = shadow({ builder: 'booking', filledRows: 6 });
check('a payment is written alongside the booking',
  s.sql.includes('insert into payments'), s.sql);
check('recorded as its own row, so a second method cannot replace the first',
  s.sql.includes('on conflict (client_ref) do nothing'), s.sql);
check('the amount and method are the ones just paid',
  /insert into payments[\s\S]*2000, 'كاش'/.test(s.sql), s.sql);
check('a continuation line pays its parent booking',
  s.sql.includes('coalesce(b.merged_into, b.id)'), s.sql);
check('كاش is recorded in pounds',
  s.sql.includes("else 'EGP' end"), s.sql);
check('the currency is derived from the method, not assumed',
  s.sql.includes("like '%دولار%' then 'USD'") &&
  s.sql.includes("like '%يورو%' then 'EUR'"), s.sql);

section('payments: nothing paid, nothing recorded');
newBooking({ pay: 'pay_unpaid' });
s = shadow({ builder: 'booking', filledRows: 10 });
check('no payment row for غير مدفوع',
  !s.sql.includes('insert into payments'), s.sql);
check('and any earlier one for that line is removed',
  s.sql.includes('delete from payments where sheet_row = 12'), s.sql);

section('payments: adding to a booking records what was added, not the total');
reset();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));
sheetRows = null;
run(cb('ef_paid')); run(msg('300')); run(cb('xpay_cash')); run(cb('xleft_no'));
run(cb('xedone'));
s = shadow();
// Sara Omar had 1200 paid; adding 300 makes the SHEET say 1500. The payment
// itself is 300 — recording 1500 would count her first payment twice.
check('the sheet column still gets the running total',
  s.sql.includes('coalesce(1500, 0)'), s.sql);
check('the payment row is the 300 just handed over',
  /insert into payments[\s\S]*300, 'كاش'/.test(s.sql), s.sql);
check('and it does not re-record the total',
  !/insert into payments[\s\S]*1500,/.test(s.sql), s.sql);
check('idempotent on the save lock, so a double tap pays once',
  /client_ref[\s\S]*'2:\d+'/.test(s.sql), s.sql);

section('payment lines: a method the booking does not carry gets its own row');
reset();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));   // كاش, row 2
sheetRows = null;
run(cb('ef_paid')); run(msg('900')); run(cb('xpay_instapay'));
run(photo('RCPT')); run(cb('xleft_no'));
run(cb('xedone'));
s = shadow({ builder: 'line' });
check('the line is recorded as a line, not as a booking',
  s.sql.includes('insert into booking_lines'), s.sql);
check('numbered, so column U and the database agree',
  /insert into booking_lines[\s\S]*, 2, 'انستاباي'/.test(s.sql), s.sql);
check('and it knows which row it took', s.sql.includes(', 3 from bookings b'), s.sql);
check('a second payment in that method finds the line already there',
  s.sql.includes('on conflict (booking_id, line_seq) do update'), s.sql);
check('the payment is tagged with its line',
  /insert into payments[\s\S]*line_seq[\s\S]*900, 'انستاباي'/.test(s.sql), s.sql);
check('the payment is still its own row, keyed on the save lock',
  s.sql.includes('on conflict (client_ref) do nothing'), s.sql);
check('انستاباي is pounds', s.sql.includes("else 'EGP' end"), s.sql);
// Inserting a row renumbers every row beneath it. Telling the database in the
// same statement is what stops the next payment landing on whoever moved into
// that number — the failure that put money on the wrong guest once already.
check('every table that remembers a row number is shifted',
  s.sql.includes('update bookings set sheet_row = -(sheet_row + 1) where sheet_row >= 3') &&
  s.sql.includes('update payments set sheet_row = -(sheet_row + 1) where sheet_row >= 3') &&
  s.sql.includes('update booking_lines set sheet_row = -(sheet_row + 1) where sheet_row >= 3'),
  s.sql);
check('through negatives, because sheet_row is unique',
  s.sql.includes('set sheet_row = -sheet_row where sheet_row < 0'), s.sql);
check('the booking keeps the total the sheet now shows',
  s.sql.includes('update bookings set total = 300'), s.sql);

section('payment lines: joining a line that already exists moves no rows');
reset();
sheetRows = [Object.assign({}, SHEET[0], {
  lines: [{ seq: 2, row: 3, method: 'انستاباي', amount: 1600 }], block_end: 3,
})];
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));
sheetRows = null;
run(cb('ef_paid')); run(msg('500')); run(cb('xpay_instapay'));
run(photo('RCPT2')); run(cb('xleft_no'));
run(cb('xedone'));
s = shadow({ builder: 'line' });
check('nothing is shifted', !s.sql.includes('-(sheet_row + 1)'), s.sql);
check('the line is upserted, not duplicated',
  s.sql.includes('on conflict (booking_id, line_seq) do update'), s.sql);
check('the payment records only what was handed over now',
  /insert into payments[\s\S]*500, 'انستاباي'/.test(s.sql) &&
  !/insert into payments[\s\S]*2100,/.test(s.sql), s.sql);
check('the booking total is left alone', !s.sql.includes('update bookings set total'),
  s.sql);

section('cancel: marks the row cancelled rather than deleting it');
reset();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));
run(cb('ef_delete'));
run(cb('edel_yes'));
s = shadow();
check('cancelled_at set', s.sql.includes('cancelled_at') && s.sql.includes('now()'), s.sql);
check('the note is carried too', s.sql.includes('ملغي'), s.sql);
sheetRows = null;

section('expense');
reset();
run(msg('/start')); run(cb('choice_expense'));
run(cb('eid_skip')); run(msg('كهرباء')); run(msg('350.5'));
// كاش asks for a receipt now, same as the transfer methods.
run(cb('eapt_0')); run(cb('epay_cash')); run(cb('ereceipt_skip'));
run(cb('enotes_skip'));
run(cb('esave'));
s = shadow({ builder: 'expense', filledRows: 9 });
check('row = filled + 2', s.sheet_row === 11, s.sheet_row);
check('targets the expenses table', s.sql.startsWith('insert into expenses'), s.sql);
check('decimal amount preserved', s.sql.includes('350.5'), s.sql);
check('apartment carried', s.sql.includes("'ذاكر حسين'"), s.sql);
check('upserts on sheet_row', s.sql.includes('on conflict (sheet_row)'), s.sql);

section('quoting: an apostrophe cannot break the statement');
reset();
run(msg('/start')); run(cb('choice_expense'));
run(cb('eid_skip')); run(msg("O'Brien's bill")); run(msg('10'));
run(cb('eapt_none')); run(cb('epay_cash')); run(cb('ereceipt_skip'));
run(cb('enotes_skip'));
run(cb('esave'));
s = shadow({ builder: 'expense', filledRows: 9 });
check('apostrophes doubled', s.sql.includes("'O''Brien''s bill'"), s.sql);
check('quotes balance', (s.sql.match(/'/g) || []).length % 2 === 0, s.sql);

section('safety: nothing to mirror is silent, never an error');
lastBrain = { save: {} };
check('no save payload → no statement', shadow() === null);
lastBrain = { save: { flow: 'edit', fields: {}, row: 5 } };
check('no changed columns → no statement', shadow() === null);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
