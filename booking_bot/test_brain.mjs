/**
 * Offline harness for brain.js — fakes the n8n Code-node globals ($, $input,
 * $getWorkflowStaticData) so the state machine can be driven through a full
 * booking and a full expense without an n8n instance.
 *
 *     node booking_bot/test_brain.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const brainSrc = readFileSync(join(HERE, 'brain.js'), 'utf8');
// The real "Build Booking Row" code node, synced from the live workflow.
const buildSrc = readFileSync(join(HERE, 'nodes', 'build_booking_row.js'), 'utf8');

const CONFIG = {
  BOT_TOKEN: 'x',
  BOOKINGS_SHEET_ID: 'sheet123',
  BOOKINGS_TAB: 'إدخال الحجوزات',
  EXPENSE_TAB: 'مصروفات عامة',
  GROUP_CHAT_ID: '-5001910339',
  EXPENSE_GROUP_CHAT_ID: '-5072732996',
  ADMIN_USERS: '7941350507,@AbdulrahmanMohamed5,1226903540,5793725130',
  CASHIER_USERS: '@Seifgamal24,@seiiffseiif',
  TIMEZONE: 'Africa/Cairo',
};

const brainFn = new Function('$', `${brainSrc}`);
const buildFn = new Function('$', '$input', `${buildSrc}`);

let lastBrain = null;

// Stands in for the `bookings_bot_sessions` data table: what "Load Session"
// hands to the Brain, and what "Save Session" upserts back. Going through a real
// JSON round-trip here is deliberate — the static-data version kept a live object
// reference, which hid any value that does not survive stringify/parse.
let sessionRow = {};

// Rows the "Read Bookings For Edit" node would return. null means the node did
// not execute this turn — n8n throws when you reference an unexecuted node, and
// brain.js relies on catching exactly that.
let sheetRows = null;

function run(update) {
  const $ = (name) => {
    const map = { Config: CONFIG, 'Telegram Trigger': update, 'Load Session': sessionRow };
    if (name === 'Read Bookings For Edit') {
      // Faithful to the graph: "Needs Bookings?" only lets this node run while
      // the LOADED state is a lookup state. Any other turn, referencing it throws.
      const st = sessionRow.state;
      if (sheetRows === null || (st !== 'EDIT_FIND' && st !== 'EDIT_PICK')) {
        throw new Error('Referenced node is unexecuted');
      }
      // The node reads A:T and adds row_number, so the double must too — an
      // earlier version handed over columns the real range never returned, which
      // hid a live bug where old values past column J were missing.
      return {
        all: () => sheetRows.map((j, i) => ({ json: { ...j, row_number: i + 2 } })),
      };
    }
    return { first: () => ({ json: map[name] }) };
  };
  const items = brainFn($);
  lastBrain = items.length ? items[0].json : null;
  if (lastBrain) {
    sessionRow = {
      chat_id: lastBrain.chatId,
      state: lastBrain.sessionState,
      data: lastBrain.sessionData,
      updated_at: Date.now(),
    };
  }
  return lastBrain;
}

/** Simulate a chat with no stored row at all (Load Session → empty item). */
function resetSession() { sessionRow = {}; }

/**
 * Run the live Build Booking Row node over the last save payload.
 * `filledRows` is how many data rows the key-column read returns; the node adds
 * 2 (header + next free row) to get the row it writes.
 */
function buildWrite(filledRows) {
  const $ = (name) => ({ json: lastBrain, first: () => ({ json: lastBrain }) });
  const items = Array.from({ length: filledRows }, (_, i) => ({ json: { key: `r${i}` } }));
  const $input = { all: () => items };
  return buildFn($, $input)[0].json;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER = { id: 7941350507, first_name: 'Ahmed', last_name: 'Isa', username: 'ahmed' };
// Admin listed by @username rather than by id — no username on the id list.
const ADMIN_BY_NAME = { id: 313131, first_name: 'Abdulrahman', username: 'AbdulrahmanMohamed5' };
const OTHER = { id: 111, first_name: 'Sara', username: 'someone' };
// The cashier: expenses + adding a payment, nothing else.
const EXPUSER = { id: 222, first_name: 'Seif', username: 'Seifgamal24' };
const CHAT = { id: 999 };

const msg = (text, from = USER) => ({ message: { chat: CHAT, from, text } });
const cb = (data, from = USER) => ({
  callback_query: { id: 'cbid', data, from, message: { chat: CHAT } },
});
// Telegram sends photo sizes smallest-first; the Brain must take the last one.
const photo = (fileId, from = USER) => ({
  message: {
    chat: CHAT,
    from,
    photo: [{ file_id: `${fileId}_thumb` }, { file_id: fileId }],
  },
});

// ─── Assertions ───────────────────────────────────────────────────────────────

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  ok   ${label}`); }
  else { failures++; console.log(`  FAIL ${label}${detail ? ` → ${JSON.stringify(detail)}` : ''}`); }
}
function section(name) { console.log(`\n${name}`); }

// ─── 1. Routing ───────────────────────────────────────────────────────────────

section('routing: access control');
let r = run(msg('/start', OTHER));
check('unlisted user is refused', r.reply.text === '⛔ غير مصرح لك باستخدام هذا البوت.', r.reply.text);
check('refusal starts no session', r.sessionState === '', r.sessionState);
r = run(msg('hello', OTHER));
check('unlisted user chatting gets no reply at all', r === null, r);
r = run(cb('choice_booking', OTHER));
check('unlisted user tapping a button gets nothing', r === null, r);

r = run(msg('/start'));
check('admin by id gets the full menu', r.reply.text === 'اختر العملية:', r.reply.text);
check('admin menu has booking, expense and edit',
  r.reply.reply_markup.inline_keyboard.map(row => row[0].callback_data).join() ===
  'choice_booking,choice_expense,choice_edit',
  r.reply.reply_markup.inline_keyboard);

r = run(msg('/start', ADMIN_BY_NAME));
check('admin listed by @username also gets the full menu',
  r.reply.reply_markup.inline_keyboard.length === 3, r.reply.reply_markup.inline_keyboard);

// The two people who were on the old BOOKING_USER_IDS / EXPENSE_USERNAMES lists.
// Dropping either would silently lock a working receptionist out of the live bot.
r = run(msg('/start', { id: 5793725130, first_name: 'Mostafa' }));
check('the second receptionist kept full access',
  r.reply.reply_markup.inline_keyboard.length === 3, r.reply.reply_markup.inline_keyboard);
r = run(msg('/start', { id: 444, first_name: 'Seif', username: 'seiiffseiif' }));
check('the old expense user is now a cashier',
  r.reply.reply_markup.inline_keyboard.map(row => row[0].callback_data).join() ===
  'choice_expense,choice_paid',
  r.reply.reply_markup.inline_keyboard);

r = run(msg('/start', EXPUSER));
check('cashier gets a two-option menu', r.reply.text === 'اختر العملية:', r.reply.text);
check('cashier menu is expense + add-payment only',
  r.reply.reply_markup.inline_keyboard.map(row => row[0].callback_data).join() ===
  'choice_expense,choice_paid',
  r.reply.reply_markup.inline_keyboard);
r = run(cb('choice_booking', EXPUSER));
check('cashier cannot start a booking even with the raw callback', r.hasReply === false);
r = run(cb('choice_edit', EXPUSER));
check('cashier cannot open the edit menu either', r.hasReply === false);

r = run(msg('/start'));
r = run(cb('choice_booking'));
check('choosing حجز starts the booking', r.reply.text.startsWith('🔖 أدخل رقم البوكينج'), r.reply.text);
check('skip button present', r.reply.reply_markup.inline_keyboard[0][0].callback_data === 'bid_skip');

// ─── 2. Booking happy path (no booking id → asks btype) ───────────────────────

section('booking: manual entry, 3 nights, cash');
r = run(cb('bid_skip'));
check('answers the callback', r.callbackQueryId === 'cbid');
check('asks private id', r.reply.text === '🆔 أدخل الـ ID:', r.reply.text);

r = run(msg('A12345'));
check('asks name', r.reply.text === '👤 اسم المقيم:');

r = run(msg('ab'));
check('rejects a 2-char name', r.reply.text.startsWith('❌ أحرف ومسافات'), r.reply.text);
r = run(msg('Ahmed 123'));
check('rejects digits in a name', r.reply.text.startsWith('❌ أحرف ومسافات'));
r = run(msg('محمد علي'));
check('accepts an Arabic name → asks btype', r.reply.text === '📑 نوع الحجز:', r.reply.text);
check('btype grid has both options', r.reply.reply_markup.inline_keyboard[0].length === 2);

r = run(cb('bt_0'));
check('btype chosen → asks phone', r.reply.text === '📞 رقم الهاتف:');

r = run(msg('01012345678'));
check('asks apartment+room', r.reply.text === '🏠 اختر الشقة والغرفة:');
check('apt/room kb = 6 apartments × 2 rows', r.reply.reply_markup.inline_keyboard.length === 12);
check('room button encodes apt+room', r.reply.reply_markup.inline_keyboard[1][0].callback_data === 'ar_0_1');

r = run(cb('ar_hdr'));
check('header tap sends no message', r.hasReply === false);

r = run(cb('ar_2_4'));
check('room chosen → asks nights', r.reply.text === '🌙 عدد الليالي:');
check('nights kb has 6 rows of 5 + ∞ row', r.reply.reply_markup.inline_keyboard.length === 7);
check('∞ button last', r.reply.reply_markup.inline_keyboard[6][0].callback_data === 'nights_inf');

r = run(cb('nights_3'));
check('nights chosen → calendar', r.reply.text === '📅 اختر تاريخ البداية:');
const cal = r.reply.reply_markup.inline_keyboard;
check('calendar header row has nav + label', cal[0].length === 3);
check('weekday header starts Saturday', cal[1][0].text === 'Sa');
check('all calendar body rows are 7 wide', cal.slice(2).every(row => row.length === 7));

// Calendar navigation
const navBack = cal[0][0].callback_data;          // cal_prev_YYYY_MM
r = run(cb(navBack));
check('prev month re-renders the calendar', r.reply.text === '📅 اختر تاريخ البداية:');
r = run(cb('cal_ignore'));
check('cal_ignore sends nothing', r.hasReply === false);
r = run(cb('cal_prev_2000_01'));
check('cannot page before 2000-01', r.hasReply === false);

r = run(cb('cal_day_2026_08_15'));
check('day picked → asks total', r.reply.text === '💰 اجمالي سعر الحجز:');

r = run(msg('abc'));
check('rejects non-numeric total', r.reply.text === '❌ أدخل رقماً صحيحاً:');
r = run(msg('4,500'));
check('accepts 4,500 → asks payment', r.reply.text === '💳 طريقة الدفع:');
check('payments grid = 7 options / 2 per row', r.reply.reply_markup.inline_keyboard.length === 4);
check('retired payment methods are gone',
  !JSON.stringify(r.reply.reply_markup.inline_keyboard).includes('شاكر') &&
  !JSON.stringify(r.reply.reply_markup.inline_keyboard).includes('وي باي'));

r = run(cb('pay_0'));
check('كاش → asks paid amount', r.reply.text === '💵 اجمالي ما تم دفعه:');

r = run(msg('2000'));
check('paid → asks notes', r.reply.text === '📝 ملاحظات (اختياري) أو اضغط تخطي:');

r = run(msg('طلب سرير إضافي'));
check('notes → confirm summary', r.reply.text.startsWith('📋 *مراجعة الحجز:*'));
check('summary is Markdown', r.reply.parse_mode === 'Markdown');
check('remaining computed 4500-2000', r.reply.text.includes('🧾 المتبقي: 2500'), r.reply.text);
check('departure = arrival + 3 nights', r.reply.text.includes('📅 المغادرة: 2026-08-18'), r.reply.text);
check('booking id shown as —', r.reply.text.includes('🔖 بوكنج ID: —'));

// ─── 3. Save payload ──────────────────────────────────────────────────────────

section('booking: save payload');
r = run(cb('save'));
check('save emits no chat reply', r.hasReply === false);
check('save flagged', r.hasSave === true);
check('key range = column C of the bookings tab', r.save.keyRange === "'إدخال الحجوزات'!C:C", r.save.keyRange);
check('4 write ranges', r.save.ranges.length === 4);
check('no range touches column P',
  r.save.ranges.every(x => !/(^|[^A-Z])P\d*\{r\}/.test(x.range) && !x.range.startsWith('P')),
  r.save.ranges.map(x => x.range));
check('ranges are A:J, L:M, O, Q',
  JSON.stringify(r.save.ranges.map(x => x.range)) ===
  JSON.stringify(['A{r}:J{r}', 'L{r}:M{r}', 'O{r}', 'Q{r}']));

// The Google Sheets node maps by column NAME. A typo in a header key writes the
// value into the wrong column (or silently nowhere), so pin the exact set. These
// strings were confirmed against row 1 of the live sheet on 2026-08-06.
const BOOKING_WRITE_HEADERS = [
  'بوكنج ID', 'ID', 'اسم المقيم', 'نوع الحجز', 'الجنسية', 'رقم الهاتف',
  'اسم الشقة', 'رقم الغرفة', 'عدد الليالي', 'تاريخ البداية',
  'اجمالي سعر الحجز', 'اجمالي ما تم دفعه', 'طريقة الدفع', 'ملاحظات',
];
// Calculated by the sheet — writing any of these destroys its formula.
const BOOKING_FORMULA_HEADERS = [
  'تاريخ المغادرة', 'نسبة البرنامج', 'المتبقي', 'تاريخ الإدخال',
  'صافي الدخل', 'آخر تعديل',
];
check('booking fields use the exact sheet headers',
  JSON.stringify(Object.keys(r.save.fields)) === JSON.stringify(BOOKING_WRITE_HEADERS),
  Object.keys(r.save.fields));
check('no formula column is ever written (incl. P المتبقي)',
  BOOKING_FORMULA_HEADERS.every(h => !(h in r.save.fields)),
  BOOKING_FORMULA_HEADERS.filter(h => h in r.save.fields));
check('fields agree with the positional ranges',
  r.save.fields['اسم المقيم'] === r.save.ranges[0].values[0][2] &&
  r.save.fields['اجمالي سعر الحجز'] === r.save.ranges[1].values[0][0] &&
  r.save.fields['طريقة الدفع'] === r.save.ranges[2].values[0][0]);
check('flow tagged booking', r.save.flow === 'booking');

const aToJ = r.save.ranges[0].values[0];
check('booking id blank stays blank (no apostrophe)', aToJ[0] === '');
check('private id forced to text', aToJ[1] === "'A12345");
check('E left blank (retired الجنسية)', aToJ[4] === '');
check('phone forced to text', aToJ[5] === "'01012345678");
check('apartment resolved from index', aToJ[6] === 'انبي 3', aToJ[6]);
check('room is numeric', aToJ[7] === 4);
check('nights numeric (not a formula)', aToJ[8] === 3);
check('arrival ISO', aToJ[9] === '2026-08-15');
check('total/paid numeric', JSON.stringify(r.save.ranges[1].values[0]) === '[4500,2000]');
check('O = payment', r.save.ranges[2].values[0][0] === 'كاش');
check('Q = notes', r.save.ranges[3].values[0][0] === 'طلب سرير إضافي');
check('group message built', r.save.groupText.startsWith('🆕 *حجز جديد*'));
check('group message names who entered the booking, with the @handle',
  r.save.groupText.includes('👤 بواسطة: Ahmed Isa'), r.save.groupText);
check('group chat id from config', r.save.groupChatId === '-5001910339');

const body = buildWrite(6);   // 6 filled data rows → header + 6 → write row 8
check('row = filled data rows + 2', body.row_number === 8, body.row_number);
check('the row is keyed by sheet header name, for autoMapInputData',
  'اسم المقيم' in body && 'اجمالي سعر الحجز' in body, Object.keys(body));
check('formula columns are never emitted',
  !['تاريخ المغادرة', 'المتبقي', 'نسبة البرنامج', 'صافي الدخل', 'آخر تعديل']
    .some(c => c in body), Object.keys(body));

// ─── 4. Booking variants ──────────────────────────────────────────────────────

section('booking: booking-id path, ∞ nights, unpaid');
run(msg('/start'));
run(cb('choice_booking'));
run(msg('BK-99'));                       // booking id given
run(msg('55555'));                       // private id
r = run(msg('Ahmed Mohamed'));
check('booking id present → btype auto-set, jumps to phone', r.reply.text === '📞 رقم الهاتف:', r.reply.text);
run(msg('0100'));
run(cb('ar_0_1'));
r = run(cb('nights_inf'));
check('∞ → calendar', r.reply.text === '📅 اختر تاريخ البداية:');
run(cb('cal_day_2026_01_02'));
run(msg('1000'));
r = run(cb('pay_4'));                    // غير مدفوع
check('غير مدفوع skips the paid step', r.reply.text === '📝 ملاحظات (اختياري) أو اضغط تخطي:', r.reply.text);
r = run(cb('notes_skip'));
check('∞ shown as مفتوح in summary', r.reply.text.includes('🌙 عدد الليالي: ∞ مفتوح'));
check('∞ departure shown as مفتوح', r.reply.text.includes('📅 المغادرة: ∞ مفتوح'));
check('unpaid → remaining = total', r.reply.text.includes('🧾 المتبقي: 1000'));

r = run(cb('save'));
check('btype auto = بوكينج', r.save.ranges[0].values[0][3] === 'بوكينج');
check('booking id forced to text', r.save.ranges[0].values[0][0] === "'BK-99");
check('∞ nights becomes a live formula', r.save.ranges[0].values[0][8] === '=TODAY()-J{r}');
const body2 = buildWrite(41);
check('the {r} placeholder is resolved to the real row',
  body2['عدد الليالي'] === '=TODAY()-J43', body2['عدد الليالي']);
check('paid 0 written', body2['اجمالي ما تم دفعه'] === 0, body2['اجمالي ما تم دفعه']);

// ─── 5. Cancel + expense flow ─────────────────────────────────────────────────

section('cancel');
run(msg('/start'));
run(msg('X'));
r = run(msg('/cancel'));
check('/cancel ends the conversation', r.reply.text.startsWith('تم الإلغاء'));
r = run(msg('hello'));
check('no session → silent', r.hasReply === false);

section('expense');
run(msg('/start', EXPUSER));
r = run(cb('choice_expense', EXPUSER));
check('cashier picking مصروف starts the expense', r.reply.text.startsWith('🔢 رقم المصروف'), r.reply.text);
r = run(msg('E-77', EXPUSER));
check('asks item', r.reply.text === '📝 البند (وصف المصروف):');
r = run(msg('كهرباء', EXPUSER));
check('asks amount', r.reply.text === '💰 المبلغ:');
r = run(msg('-1', EXPUSER));
check('rejects a negative amount', r.reply.text === '❌ أدخل رقماً صحيحاً:');
r = run(msg('350.5', EXPUSER));
check('asks apartment', r.reply.text === '🏠 الشقة:');
check('apartment kb has a بدون/عام row', r.reply.reply_markup.inline_keyboard.at(-1)[0].callback_data === 'eapt_none');
r = run(cb('eapt_none', EXPUSER));
check('asks payment', r.reply.text === '💳 طريقة الدفع:');
check('3 expense payment options incl. فودافون كاش',
  JSON.stringify(r.reply.reply_markup.inline_keyboard).includes('فودافون كاش') &&
  r.reply.reply_markup.inline_keyboard.flat().length === 3);
r = run(cb('epay_1', EXPUSER));                    // انستاباي → receipt step
check('انستاباي asks for a receipt', r.reply.text === '📎 أرسل صورة إيصال التحويل أو اضغط تخطي:', r.reply.text);
check('receipt prompt offers skip', r.reply.reply_markup.inline_keyboard[0][0].callback_data === 'ereceipt_skip');
r = run(msg('not a photo', EXPUSER));
check('text instead of a photo is rejected', r.reply.text === '❌ أرسل صورة الإيصال أو اضغط تخطي:', r.reply.text);
r = run(photo('EXPFILE123', EXPUSER));
check('photo accepted → asks notes', r.reply.text === '🗒️ ملاحظات (اختياري) أو اضغط تخطي:', r.reply.text);
r = run(cb('enotes_skip', EXPUSER));
check('expense confirm', r.reply.text.startsWith('📋 *مراجعة المصروف:*'));
check('responsible = full name', r.reply.text.includes('👤 المسئول: Seif'), r.reply.text);
check('decimal amount kept', r.reply.text.includes('💰 المبلغ: 350.5'));

r = run(cb('esave', EXPUSER));
check('expense key column is B', r.save.keyRange === "'مصروفات عامة'!B:B", r.save.keyRange);
check('single A:H range', r.save.ranges.length === 1 && r.save.ranges[0].range === 'A{r}:H{r}');
check('expense fields use the exact sheet headers',
  JSON.stringify(Object.keys(r.save.fields)) === JSON.stringify([
    'تاريخ', 'البند', 'المبلغ', 'الشقة', 'ملاحظات', 'طريقة الدفع',
    'اسم المسئول', 'الرقم',
  ]),
  Object.keys(r.save.fields));
check('receipt file id reaches the save payload', r.save.receiptFileId === 'EXPFILE123', r.save.receiptFileId);
check('highest-resolution photo size is used', r.save.receiptFileId !== 'EXPFILE123_thumb');
check('group text shows the receipt as attached', r.save.groupText.includes('📎 الإيصال: ✅ مرفق'), r.save.groupText);
check('responsible column is اسم المسئول, not المسئول',
  'اسم المسئول' in r.save.fields && !('المسئول' in r.save.fields));
check('group post names who entered it', r.save.groupText.includes('👤 المسئول: Seif'),
  r.save.groupText);
check('the sheet column keeps the plain name, no handle',
  r.save.fields['اسم المسئول'] === 'Seif', r.save.fields['اسم المسئول']);
check('flow tagged expense', r.save.flow === 'expense');
const row = r.save.ranges[0].values[0];
check('A = timestamp', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(row[0]), row[0]);
check('B = item', row[1] === 'كهرباء');
check('C = amount', row[2] === 350.5);
check('D = apartment blank for بدون/عام', row[3] === '');
check('F = payment', row[5] === 'انستاباي');
check('H = id forced to text', row[7] === "'E-77");
check('expense group id', r.save.groupChatId === '-5072732996');

// The Brain keeps the session on *_CONFIRM after emitting a save; the
// "Clear Session" node ends it only once the sheet write succeeded, so a failed
// write leaves the Save button live (same as handlers/booking.py).
section('save failure leaves the user on CONFIRM');
check('session still parked on EXP_CONFIRM', sessionRow.state === 'EXP_CONFIRM', sessionRow.state);
r = run(cb('esave', EXPUSER));
check('pressing Save again re-emits the write', r.hasSave === true);

// Simulate the Clear Session node running after a successful write.
resetSession();
r = run(cb('esave', EXPUSER));
check('after Clear Session a stale Save button is inert', r.hasSave === false && r.hasReply === false);

// ─── Booking receipt path: انستاباي asks for the image AFTER the paid amount ──

section('booking: receipt comes after the paid amount');
resetSession();
run(msg('/start'));
run(cb('choice_booking'));
run(cb('bid_skip'));
run(msg('B999'));
run(msg('Mona Ali'));
run(cb('bt_0'));
run(msg('01099887766'));
run(cb('ar_0_2'));
run(cb('nights_2'));
run(cb('cal_day_2026_08_10'));
r = run(msg('3000'));
check('asks payment', r.reply.text === '💳 طريقة الدفع:');
r = run(cb('pay_1'));                              // انستاباي
check('انستاباي asks the paid amount FIRST', r.reply.text === '💵 اجمالي ما تم دفعه:', r.reply.text);
r = run(msg('1500'));
check('receipt is asked after the amount', r.reply.text === '📎 أرسل صورة إيصال التحويل أو اضغط تخطي:', r.reply.text);
r = run(photo('BOOKFILE777'));
check('photo accepted → asks notes', r.reply.text === '📝 ملاحظات (اختياري) أو اضغط تخطي:', r.reply.text);
r = run(cb('notes_skip'));
check('confirm shows the receipt attached', r.reply.text.includes('📎 الإيصال: ✅ مرفق'), r.reply.text);
r = run(cb('save'));
check('booking receipt file id reaches the save payload', r.save.receiptFileId === 'BOOKFILE777', r.save.receiptFileId);
check('paid amount survived the receipt detour', r.save.fields['اجمالي ما تم دفعه'] === 1500);

// Skipping the receipt must still land on notes.
resetSession();
run(msg('/start')); run(cb('choice_booking')); run(cb('bid_skip'));
run(msg('B1000')); run(msg('Sara Omar'));
run(cb('bt_0')); run(msg('01000000000')); run(cb('ar_0_1')); run(cb('nights_1'));
run(cb('cal_day_2026_08_11')); run(msg('1000')); run(cb('pay_3'));   // فودافون كاش
r = run(msg('400'));
check('فودافون كاش also asks for a receipt', r.reply.text === '📎 أرسل صورة إيصال التحويل أو اضغط تخطي:', r.reply.text);
r = run(cb('receipt_skip'));
check('skipping the receipt goes to notes', r.reply.text === '📝 ملاحظات (اختياري) أو اضغط تخطي:', r.reply.text);
r = run(cb('notes_skip'));
check('confirm shows no receipt', r.reply.text.includes('📎 الإيصال: —'), r.reply.text);
r = run(cb('save'));
check('skipped receipt → empty file id', r.save.receiptFileId === '');

// ─── Edit an already-saved booking ────────────────────────────────────────────

const SHEET = [
  { 'بوكنج ID': '', 'ID': '55555', 'اسم المقيم': 'Ahmed Mohamed',
    'اسم الشقة': 'ذاكر حسين', 'رقم الغرفة': 1, 'تاريخ البداية': '2026-08-01',
    'اجمالي سعر الحجز': 5000, 'اجمالي ما تم دفعه': 2000,
    'طريقة الدفع': 'كاش', 'ملاحظات': 'وصل متأخر' },
  { 'بوكنج ID': 'BK-77', 'ID': '77777', 'اسم المقيم': 'Sara Omar',
    'اسم الشقة': 'انبي 2', 'رقم الغرفة': 3, 'تاريخ البداية': '2026-08-04',
    'اجمالي سعر الحجز': 1200, 'اجمالي ما تم دفعه': 1200,
    'طريقة الدفع': 'كاش', 'ملاحظات': '' },
  { 'بوكنج ID': '', 'ID': '55555', 'اسم المقيم': 'Khaled Nabil',
    'اسم الشقة': 'انبي 3', 'رقم الغرفة': 2, 'تاريخ البداية': '2026-08-09',
    'اجمالي سعر الحجز': 800, 'اجمالي ما تم دفعه': 0,
    'طريقة الدفع': 'غير مدفوع', 'ملاحظات': '' },
];

section('edit: finding the booking');
resetSession();
sheetRows = SHEET;
r = run(msg('/start'));
r = run(cb('choice_edit'));
check('edit asks for the id', r.reply.text === '🔎 أدخل الـ ID:', r.reply.text);
r = run(msg('NOPE'));
check('unknown id is rejected', r.reply.text.startsWith('❌ لا يوجد حجز'), r.reply.text);
r = run(msg('BK-77'));
check('بوكنج ID is NOT matched — ID column only', r.reply.text.startsWith('❌ لا يوجد حجز'), r.reply.text);
r = run(msg('55555'));
check('duplicate ids offer a picker', r.reply.text.startsWith('🔎 أكثر من حجز'), r.reply.text);
check('picker lists both matches', r.reply.reply_markup.inline_keyboard.length === 2);
check('picker encodes the sheet row', r.reply.reply_markup.inline_keyboard[0][0].callback_data === 'epick_2',
  r.reply.reply_markup.inline_keyboard[0][0].callback_data);
check('picker skips the non-matching row',
  r.reply.reply_markup.inline_keyboard[1][0].callback_data === 'epick_4',
  r.reply.reply_markup.inline_keyboard[1][0].callback_data);
r = run(cb('epick_4'));                      // Khaled Nabil
check('picking opens the edit menu', r.reply.text === '✏️ اختر ما تريد تعديله:', r.reply.text);
check('menu offers delete', JSON.stringify(r.reply.reply_markup.inline_keyboard).includes('ef_delete'));

section('edit: unique id goes straight to the menu');
resetSession();
r = run(msg('/start')); r = run(cb('choice_edit'));
r = run(msg('77777'));
check('unique ID opens the menu directly', r.reply.text === '✏️ اختر ما تريد تعديله:', r.reply.text);

section('edit: changing the paid amount forces a payment method');
sheetRows = null;                            // lookup node no longer executes
r = run(cb('ef_notes'));                     // a non-payment edit still uses the menu
r = run(msg('دفع الباقي'));
check('notes edit returns to the menu', r.reply.text === '✏️ اختر ما تريد تعديله:', r.reply.text);

r = run(cb('ef_paid'));
check('paid prompt says it ADDS and shows the current total',
  r.reply.text.startsWith('💵 أدخل المبلغ المضاف (المدفوع حالياً: 1200):'), r.reply.text);
check('brain survives the unexecuted lookup node', r.hasReply === true);
r = run(msg('900'));
check('paid change forces طريقة الدفع', r.reply.text === '💳 طريقة الدفع:', r.reply.text);
r = run(cb('xpay_1'));                       // انستاباي
check('transfer offers a receipt', r.reply.text === '📎 أرسل صورة إيصال التحويل أو اضغط تخطي:', r.reply.text);
r = run(photo('EDITFILE55'));
check('after the receipt the admin is asked whether the guest left',
  r.reply.text === '🚪 هل غادر النزيل؟', r.reply.text);
r = run(cb('xleft_no'));
check('answering لا goes to the review, not the menu',
  r.reply.text.startsWith('📋 *مراجعة التعديل:*'), r.reply.text);
check('review lists every change made this session',
  r.reply.text.includes('اجمالي ما تم دفعه: 1200 ← 2100') &&
  r.reply.text.includes('طريقة الدفع: كاش ← انستاباي') &&
  r.reply.text.includes('ملاحظات:'), r.reply.text);
check('review is not a save on its own', r.hasSave === false);

r = run(cb('xedone'));
check('edit flagged as a save', r.hasSave === true);
check('flow is edit', r.save.flow === 'edit');
check('row comes from the lookup, not a computed append', r.save.row === 3);
check('only changed columns are written',
  JSON.stringify(Object.keys(r.save.fields).sort()) ===
  JSON.stringify(['اجمالي ما تم دفعه', 'طريقة الدفع', 'ملاحظات'].sort()),
  Object.keys(r.save.fields));
check('المتبقي is never written', !('المتبقي' in r.save.fields));
check('paid amount was ADDED to the existing 1200, not replaced',
  r.save.fields['اجمالي ما تم دفعه'] === 2100, r.save.fields['اجمالي ما تم دفعه']);
check('group message is a diff, not the whole booking',
  r.save.groupText.includes('✏️ *تعديل حجز*') &&
  r.save.groupText.includes('اجمالي ما تم دفعه: 1200 ← 2100') &&
  r.save.groupText.includes('طريقة الدفع: كاش ← انستاباي'),
  r.save.groupText);
check('edit receipt is carried through', r.save.receiptFileId === 'EDITFILE55');
check('edit says who made it', r.save.groupText.includes('👤 بواسطة: Ahmed Isa'),
  r.save.groupText);

section('edit: the review is terminal — no second payment in one session');
resetSession();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));   // paid = 1200
sheetRows = null;
run(cb('ef_paid')); run(msg('300'));
r = run(cb('xpay_0'));                                           // كاش → no receipt
check('cash goes straight to the checkout question',
  r.reply.text === '🚪 هل غادر النزيل؟', r.reply.text);
r = run(cb('ef_paid'));
check('the field menu is gone — a stale ef_ tap does nothing', r.hasReply === false);
r = run(cb('xleft_no'));
r = run(cb('xedone'));
check('the single addition is saved (1200+300)',
  r.save.fields['اجمالي ما تم دفعه'] === 1500, r.save.fields['اجمالي ما تم دفعه']);
check('diff shows the ORIGINAL sheet value as the before',
  r.save.groupText.includes('اجمالي ما تم دفعه: 1200 ← 1500'), r.save.groupText);

section('edit: refunds and corrections via negative amounts');
resetSession();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));   // paid = 1200
sheetRows = null;
run(cb('ef_paid'));
r = run(msg('-9999'));
check('cannot push the paid total below zero',
  r.reply.text === '❌ المدفوع لا يمكن أن يقل عن صفر. المدفوع حالياً: 1200', r.reply.text);
check('rejection keeps the user on the same step', r.hasSave === false);
r = run(msg('-200'));
check('a refund is accepted', r.reply.text === '💳 طريقة الدفع:', r.reply.text);
run(cb('xpay_0'));
run(cb('xleft_no'));
r = run(cb('xedone'));
check('refund subtracts (1200-200)', r.save.fields['اجمالي ما تم دفعه'] === 1000,
  r.save.fields['اجمالي ما تم دفعه']);
check('diff shows the reduction', r.save.groupText.includes('اجمالي ما تم دفعه: 1200 ← 1000'),
  r.save.groupText);

// Refunding the whole balance is legitimate; only going past zero is not.
resetSession();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));
sheetRows = null;
run(cb('ef_paid')); run(msg('-1200')); run(cb('xpay_0'));
run(cb('xleft_no'));
r = run(cb('xedone'));
check('refunding down to exactly zero is allowed', r.save.fields['اجمالي ما تم دفعه'] === 0,
  r.save.fields['اجمالي ما تم دفعه']);

section('edit: finishing with no changes posts nothing');
resetSession();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));
r = run(cb('ef_done'));
check('no changes → no save', r.hasSave === false);
check('no changes → told so', r.reply.text.startsWith('لم يتم تغيير'), r.reply.text);

section('cancel a booking');
resetSession();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));
r = run(cb('ef_delete'));
check('delete asks for confirmation', r.reply.text.startsWith('⚠️ تأكيد إلغاء'), r.reply.text);
r = run(cb('edel_no'));
check('declining returns to the menu', r.reply.text === '✏️ اختر ما تريد تعديله:', r.reply.text);
r = run(cb('ef_delete'));
r = run(cb('edel_yes'));
check('flow is cancel', r.save.flow === 'cancel');
check('row kept, not deleted', r.save.row === 3);
check('writes ملغي into ملاحظات', r.save.fields['ملاحظات'] === 'ملغي', r.save.fields['ملاحظات']);
check('asks for the black row formatting', r.save.formatRow === true);
check('cancel group message', r.save.groupText.includes('🗑️ *إلغاء حجز*') &&
  r.save.groupText.includes('Sara Omar'), r.save.groupText);
check('cancel says who did it', r.save.groupText.includes('👤 بواسطة: Ahmed Isa'),
  r.save.groupText);

section('cancel keeps an existing note');
resetSession();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('55555'));
run(cb('epick_2'));                          // Ahmed Mohamed, note 'وصل متأخر'
run(cb('ef_delete'));
r = run(cb('edel_yes'));
check('existing note is appended to, not clobbered',
  r.save.fields['ملاحظات'] === 'وصل متأخر ملغي', r.save.fields['ملاحظات']);

// ─── Cashier: add a payment to an existing booking ────────────────────────────

section('cashier: add a payment, non-cash → receipt required');
resetSession();
sheetRows = SHEET;
run(msg('/start', EXPUSER));
r = run(cb('choice_paid', EXPUSER));
check('add-payment asks for the booking id', r.reply.text === '🔎 أدخل الـ ID الخاص بالحجز:', r.reply.text);
r = run(msg('NOPE', EXPUSER));
check('unknown id rejected', r.reply.text.startsWith('❌ لا يوجد حجز'), r.reply.text);
r = run(msg('77777', EXPUSER));                  // unique, paid = 1200
check('found booking asks for the amount straight away — no field menu',
  r.reply.text === '💵 أدخل المبلغ المدفوع (المدفوع حالياً: 1200):', r.reply.text);
sheetRows = null;
r = run(msg('abc', EXPUSER));
check('non-numeric amount rejected', r.reply.text === '❌ أدخل رقماً صحيحاً:', r.reply.text);
r = run(msg('800', EXPUSER));
check('amount asks for the payment type', r.reply.text === '💳 طريقة الدفع:', r.reply.text);
check('full payment list offered', r.reply.reply_markup.inline_keyboard.flat().length === 7);
r = run(cb('xpay_1', EXPUSER));                  // انستاباي
check('non-cash demands a receipt', r.reply.text === '📎 أرسل صورة إيصال التحويل:', r.reply.text);
check('cashier receipt has no skip button', r.reply.reply_markup === undefined, r.reply.reply_markup);
r = run(cb('xreceipt_skip', EXPUSER));
check('the admin skip callback does not work here',
  r.reply.text === '❌ لا بد من إرسال صورة الإيصال:' && r.hasSave === false, r.reply.text);
r = run(msg('حولت بالفعل', EXPUSER));
check('text instead of a photo is rejected', r.reply.text === '❌ لا بد من إرسال صورة الإيصال:', r.reply.text);
r = run(photo('PAYFILE99', EXPUSER));
check('photo saves immediately — no confirm step', r.hasSave === true);
check('flow is edit (same writer as the admin edit)', r.save.flow === 'edit');
check('row from the lookup', r.save.row === 3);
check('only paid + payment method written',
  JSON.stringify(Object.keys(r.save.fields).sort()) ===
  JSON.stringify(['اجمالي ما تم دفعه', 'طريقة الدفع'].sort()), Object.keys(r.save.fields));
check('payment ADDED to the existing 1200', r.save.fields['اجمالي ما تم دفعه'] === 2000,
  r.save.fields['اجمالي ما تم دفعه']);
check('receipt carried to the save', r.save.receiptFileId === 'PAYFILE99');
check('group message is the payment notice, not the edit diff',
  r.save.groupText.includes('💵 *دفعة جديدة*') &&
  r.save.groupText.includes('➕ المبلغ المضاف: 800') &&
  r.save.groupText.includes('💵 اجمالي ما تم دفعه: 2000') &&
  r.save.groupText.includes('💳 الدفع: انستاباي') &&
  r.save.groupText.includes('👤 بواسطة: Seif'),
  r.save.groupText);
check('confirmation is the payment one', r.save.savedText.startsWith('✅ تم تسجيل الدفعة'), r.save.savedText);

section('cashier: cash needs no receipt');
resetSession();
sheetRows = SHEET;
run(msg('/start', EXPUSER)); run(cb('choice_paid', EXPUSER)); run(msg('77777', EXPUSER));
sheetRows = null;
run(msg('500', EXPUSER));
r = run(cb('xpay_0', EXPUSER));                  // كاش
check('cash saves without asking for an image', r.hasSave === true);
check('no receipt on the payload', r.save.receiptFileId === '');
check('cash payment recorded', r.save.fields['طريقة الدفع'] === 'كاش');

section('cashier: duplicate ids still get the picker');
resetSession();
sheetRows = SHEET;
run(msg('/start', EXPUSER)); run(cb('choice_paid', EXPUSER));
r = run(msg('55555', EXPUSER));
check('picker shown', r.reply.text.startsWith('🔎 أكثر من حجز'), r.reply.text);
r = run(cb('epick_2', EXPUSER));                 // Ahmed Mohamed, paid = 2000
check('picking goes to the amount, not the field menu',
  r.reply.text === '💵 أدخل المبلغ المدفوع (المدفوع حالياً: 2000):', r.reply.text);

section('admin edit is unaffected by the cashier rules');
resetSession();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));
sheetRows = null;
run(cb('ef_paid')); run(msg('100'));
r = run(cb('xpay_2'));                           // Airbnb — not a receipt payment
check('a payment with no receipt still reaches the checkout question',
  r.reply.text === '🚪 هل غادر النزيل؟', r.reply.text);

resetSession();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));
sheetRows = null;
run(cb('ef_paid')); run(msg('50'));
r = run(cb('xpay_1'));                           // انستاباي
check('admin receipt is still skippable',
  r.reply.reply_markup.inline_keyboard[0][0].callback_data === 'xreceipt_skip');
r = run(cb('xreceipt_skip'));
check('skipping the receipt lands on the checkout question',
  r.reply.text === '🚪 هل غادر النزيل؟', r.reply.text);

section('edit: a non-payment edit never asks about checkout');
resetSession();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));
sheetRows = null;
run(cb('ef_notes'));
r = run(msg('وصل متأخر'));
check('notes edit returns to the field menu', r.reply.text === '✏️ اختر ما تريد تعديله:', r.reply.text);
r = run(cb('ef_done'));
check('تم still saves directly when no payment was recorded', r.hasSave === true);

// ─── Checking a guest out off the back of a payment ───────────────────────────

section('checkout: نعم → departure date → nights are calculated');
resetSession();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));   // arrival 2026-08-04
sheetRows = null;
run(cb('ef_paid')); run(msg('300'));
r = run(cb('xpay_0'));
check('checkout question offers نعم / لا',
  r.reply.reply_markup.inline_keyboard[0].map(b => b.callback_data).join() === 'xleft_yes,xleft_no',
  r.reply.reply_markup.inline_keyboard);
r = run(cb('xleft_yes'));
check('نعم opens a calendar', r.reply.text === '📅 اختر تاريخ المغادرة:', r.reply.text);
check('calendar can be paged', JSON.stringify(r.reply.reply_markup).includes('cal_next_'));

r = run(cb('cal_day_2026_08_01'));               // before arrival (2026-08-04)
check('a departure before arrival is rejected',
  r.reply.text.startsWith('❌ المغادرة (2026-08-01) قبل تاريخ البداية (2026-08-04)'), r.reply.text);
check('rejection re-offers the calendar', Boolean(r.reply.reply_markup), r.reply);
check('rejection does not save', r.hasSave === false);

r = run(cb('cal_day_2026_08_10'));               // 6 nights after 2026-08-04
check('a valid departure goes to the review',
  r.reply.text.startsWith('📋 *مراجعة التعديل:*'), r.reply.text);
check('nights computed from arrival → departure', r.reply.text.includes('عدد الليالي: 1200'
  ) === false && r.reply.text.includes('← 6'), r.reply.text);
check('the departure date is shown even though it is never written',
  r.reply.text.includes('📅 تاريخ المغادرة: 2026-08-10'), r.reply.text);

r = run(cb('xedone'));
check('approving saves', r.hasSave === true);
check('عدد الليالي written as a plain number', r.save.fields['عدد الليالي'] === 6,
  r.save.fields['عدد الليالي']);
check('تاريخ المغادرة is NEVER written — it is a sheet formula',
  !('تاريخ المغادرة' in r.save.fields), Object.keys(r.save.fields));
check('the payment is saved in the same write', r.save.fields['اجمالي ما تم دفعه'] === 1500);
check('the group post carries the checkout', r.save.groupText.includes('عدد الليالي:') &&
  r.save.groupText.includes('📅 تاريخ المغادرة: 2026-08-10'), r.save.groupText);

section('checkout: same-day departure is 0 nights, not an error');
resetSession();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));
sheetRows = null;
run(cb('ef_paid')); run(msg('10')); run(cb('xpay_0')); run(cb('xleft_yes'));
r = run(cb('cal_day_2026_08_04'));               // exactly the arrival date
check('same-day checkout accepted', r.reply.text.startsWith('📋 *مراجعة التعديل:*'), r.reply.text);
r = run(cb('xedone'));
check('0 nights written', r.save.fields['عدد الليالي'] === 0, r.save.fields['عدد الليالي']);

section('checkout: an open-ended stay reads as مفتوح in the diff, not a formula');
resetSession();
sheetRows = [{ ...SHEET[1], 'عدد الليالي': '=TODAY()-J3' }];
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));
sheetRows = null;
run(cb('ef_paid')); run(msg('10')); run(cb('xpay_0')); run(cb('xleft_yes'));
r = run(cb('cal_day_2026_08_10'));
check('the before value is shown as مفتوح', r.reply.text.includes('عدد الليالي: ∞ مفتوح ← 6'),
  r.reply.text);

section('checkout: cancelling the review saves nothing');
resetSession();
sheetRows = SHEET;
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));
sheetRows = null;
run(cb('ef_paid')); run(msg('300')); run(cb('xpay_0'));
run(cb('xleft_no'));
r = run(cb('xecancel'));
check('cancelling posts nothing', r.hasSave === false);
check('cancelling ends the session', r.sessionState === '', r.sessionState);
check('user is told', r.reply.text.startsWith('تم الإلغاء'), r.reply.text);

section('checkout: the cashier never sees the question');
resetSession();
sheetRows = SHEET;
run(msg('/start', EXPUSER)); run(cb('choice_paid', EXPUSER)); run(msg('77777', EXPUSER));
sheetRows = null;
run(msg('300', EXPUSER));
r = run(cb('xpay_0', EXPUSER));
check('cashier saves immediately, no checkout question', r.hasSave === true);
check('cashier never touches عدد الليالي', !('عدد الليالي' in r.save.fields),
  Object.keys(r.save.fields));

// ─── Free text vs. Markdown ───────────────────────────────────────────────────

section('markdown: user-typed text cannot break the message');
// Everything below is sent with parse_mode Markdown. An unbalanced _ or * makes
// Telegram 400 the whole message — the row is written but the confirmation and
// the group post never arrive, and nobody notices.
const balanced = (s) =>
  (s.match(/(?<!\\)\*/g) || []).length % 2 === 0 &&
  (s.match(/(?<!\\)_/g) || []).length % 2 === 0 &&
  (s.match(/(?<!\\)`/g) || []).length % 2 === 0;

resetSession();
run(msg('/start', EXPUSER)); run(cb('choice_expense', EXPUSER));
run(msg('E_1', EXPUSER));                       // expense number with an underscore
run(msg('كهرباء 50_60 *عاجل*', EXPUSER));       // free-text item
run(msg('120', EXPUSER));
run(cb('eapt_none', EXPUSER));
run(cb('epay_0', EXPUSER));                     // كاش → no receipt
r = run(msg('راجع الفاتورة_2', EXPUSER));       // free-text notes
check('expense confirm survives Markdown metacharacters', balanced(r.reply.text), r.reply.text);
check('the item is escaped, not stripped', r.reply.text.includes('كهرباء 50\\_60 \\*عاجل\\*'),
  r.reply.text);
r = run(cb('esave', EXPUSER));
check('expense group post is balanced', balanced(r.save.groupText), r.save.groupText);
check('the SHEET keeps the raw text, unescaped',
  r.save.fields['البند'] === 'كهرباء 50_60 *عاجل*' &&
  r.save.fields['ملاحظات'] === 'راجع الفاتورة_2' &&
  r.save.fields['الرقم'] === "'E_1",
  [r.save.fields['البند'], r.save.fields['ملاحظات'], r.save.fields['الرقم']]);

resetSession();
run(msg('/start')); run(cb('choice_booking'));
run(msg('BK_7*7'));                             // booking id with metacharacters
run(msg('ID_99'));
run(msg('محمد علي'));
run(msg('010_1234'));
run(cb('ar_0_1'));
run(cb('nights_2'));
run(cb('cal_day_2026_08_04'));
run(msg('5000'));
run(cb('pay_0'));
run(msg('1000'));
r = run(msg('ملاحظة_مهمة *جدا*'));
check('booking confirm survives Markdown metacharacters', balanced(r.reply.text), r.reply.text);
r = run(cb('save'));
check('booking group post is balanced', balanced(r.save.groupText), r.save.groupText);
check('the SHEET keeps the raw booking text',
  r.save.fields['ملاحظات'] === 'ملاحظة_مهمة *جدا*' && r.save.fields['بوكنج ID'] === "'BK_7*7",
  [r.save.fields['ملاحظات'], r.save.fields['بوكنج ID']]);

// Sheet values flow back out through the edit diff, so they need it too.
resetSession();
sheetRows = [{ ...SHEET[1], 'ملاحظات': 'وصل_متأخر' }];
run(msg('/start')); run(cb('choice_edit')); run(msg('77777'));
sheetRows = null;
run(cb('ef_notes'));
r = run(msg('غادر *أخيرا*'));
r = run(cb('ef_done'));
check('edit diff is balanced', balanced(r.save.groupText), r.save.groupText);
check('both sides of the diff are escaped',
  r.save.groupText.includes('وصل\\_متأخر ← غادر \\*أخيرا\\*'), r.save.groupText);
check('the SHEET still gets the raw note', r.save.fields['ملاحظات'] === 'غادر *أخيرا*',
  r.save.fields['ملاحظات']);

// ─── Who did it, in the group post ────────────────────────────────────────────

/** Drive one edit to the save payload as `who`, and return it. */
function editAs(who) {
  resetSession();
  sheetRows = SHEET;
  run(msg('/start', who));
  run(cb('choice_edit', who));
  run(msg('77777', who));
  sheetRows = null;
  run(cb('ef_paid', who));
  run(msg('100', who));
  run(cb('xpay_0', who));
  run(cb('xleft_no', who));          // recording a payment now asks about checkout
  return run(cb('xedone', who));
}

section('actor: Markdown metacharacters in a name do not break the post');
// Group posts go out with parse_mode Markdown. One unescaped underscore makes
// Telegram reject the whole message with a 400, so the notification is lost —
// and a Telegram display name is free text, so it really can contain them.
r = editAs({ id: 1226903540, first_name: 'Ahmed_Isa', last_name: '*A*' });
check('metacharacters escaped', r.save.groupText.includes('👤 بواسطة: Ahmed\\_Isa \\*A\\*'),
  r.save.groupText);
check('every * and _ is balanced or escaped',
  (r.save.groupText.match(/(?<!\\)\*/g) || []).length % 2 === 0 &&
  (r.save.groupText.match(/(?<!\\)_/g) || []).length % 2 === 0,
  r.save.groupText);

section('actor: name only, never the @handle');
r = editAs({ id: 1226903540, first_name: 'Ahmed', last_name: 'Isa', username: 'ahmed_isa_2' });
check('display name is used', r.save.groupText.includes('👤 بواسطة: Ahmed Isa'), r.save.groupText);
check('the @handle is not shown', !r.save.groupText.includes('@ahmed'), r.save.groupText);

section('actor: falls back when there is no name');
r = editAs({ id: 1226903540, username: 'ahmedisa' });
check('no name → the @handle', r.save.groupText.includes('👤 بواسطة: @ahmedisa'), r.save.groupText);

const ID_ONLY = { id: 1226903540 };
r = editAs(ID_ONLY);
check('neither name nor handle → the numeric id',
  r.save.groupText.includes('👤 بواسطة: 1226903540'), r.save.groupText);

sheetRows = null;

// ─── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
