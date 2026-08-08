/**
 * Bookings receptionist bot — full conversation state machine.
 *
 * This is the source-of-truth copy of the JS that lives inside the "Brain"
 * Code node of n8n/bookings-bot.workflow.json. Edit here, then paste into the
 * node (or re-run n8n/sync-brain.py to rebuild the workflow JSON).
 *
 * Port of handlers/booking.py (PTB ConversationHandler) + strings.py.
 * Session state is kept in n8n workflow static data, keyed by chat id.
 */

// ─── Config (from the "Config" Set node) ──────────────────────────────────────

const CFG = $('Config').first().json;
const upd = $('Telegram Trigger').first().json;

// Access lists. Each entry is either a numeric Telegram user id or an @username
// (stored lower-cased, without the @). Anyone on neither list gets nothing —
// this bot is closed to everybody else.
//
// Usernames are matched because two of the people below were only ever given to
// us as @handles. The trade-off is real: a user who clears or renames their
// username loses access until the list is updated. Prefer ids when known.
function parseUsers(raw) {
  return String(raw || '')
    .split(',').map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
}

// Full access: booking, expense, edit/cancel.
const ADMIN_USERS = parseUsers(
  CFG.ADMIN_USERS !== undefined && CFG.ADMIN_USERS !== ''
    ? CFG.ADMIN_USERS
    : '7941350507,@AbdulrahmanMohamed5,1226903540,5793725130'
);

// Cashier access: expenses, plus adding a payment to an existing booking.
const CASHIER_USERS = parseUsers(
  CFG.CASHIER_USERS !== undefined && CFG.CASHIER_USERS !== ''
    ? CFG.CASHIER_USERS
    : '@Seifgamal24,@seiiffseiif'
);

const TZ = CFG.TIMEZONE || 'Africa/Cairo';

// ─── Option lists (indexes are baked into callback_data — never reorder) ──────

const BTYPE_OPTS = ['خارجي', 'بوكينج'];

const APARTMENTS = [
  'ذاكر حسين', 'احمد فهيم', 'انبي 3', 'انبي 2', 'ابو حديد 11', 'عبدالله العربي',
];

const ROOMS_PER_APARTMENT = 5;

// 2026-08-06: dropped 'فودافون كاش علي رقم شاكر', 'علي شاكر' and 'وي باي'. That
// shifts the indexes of everything after 'فودافون كاش', which callback_data
// encodes — safe only because it was done while the bot was unpublished and no
// conversation was in flight. Append-only from here.
const PAYMENTS = [
  'كاش', 'انستاباي', 'Airbnb', 'فودافون كاش', 'غير مدفوع', 'يورو', 'دولار',
];

const EXP_PAYMENTS = ['كاش', 'انستاباي', 'فودافون كاش'];

/** Payment methods that produce a transfer receipt worth attaching. */
const RECEIPT_PAYMENTS = ['انستاباي', 'فودافون كاش'];

// Fields an already-saved booking may be edited through. Money + stay details
// only: the identity columns (اسم المقيم, ID, بوكنج ID, رقم الهاتف, نوع الحجز)
// are deliberately not editable. Keyed by callback suffix; append-only.
const EDIT_FIELDS = [
  { key: 'total',   labelKey: 'btn_edit_total',   col: 'اجمالي سعر الحجز' },
  { key: 'paid',    labelKey: 'btn_edit_paid',    col: 'اجمالي ما تم دفعه' },
  { key: 'payment', labelKey: 'btn_edit_payment', col: 'طريقة الدفع' },
  { key: 'nights',  labelKey: 'btn_edit_nights',  col: 'عدد الليالي' },
  { key: 'arrival', labelKey: 'btn_edit_arrival', col: 'تاريخ البداية' },
  { key: 'aptroom', labelKey: 'btn_edit_aptroom', col: null },   // writes G and H
  { key: 'notes',   labelKey: 'btn_edit_notes',   col: 'ملاحظات' },
];

// ─── Strings (port of strings.py) ─────────────────────────────────────────────

const S = {
  choose_action: 'اختر العملية:',
  btn_add_booking: '➕ حجز',
  btn_add_expense: '💸 مصروف',
  not_authorized: '⛔ غير مصرح لك باستخدام هذا البوت.',

  exp_ask_id: '🔢 رقم المصروف (إن وجد) أو اضغط تخطي:',
  exp_ask_item: '📝 البند (وصف المصروف):',
  exp_ask_amount: '💰 المبلغ:',
  exp_ask_apartment: '🏠 الشقة:',
  btn_apt_none: 'بدون/عام',
  exp_ask_payment: '💳 طريقة الدفع:',
  exp_ask_notes: '🗒️ ملاحظات (اختياري) أو اضغط تخطي:',
  exp_confirm_summary:
    '📋 *مراجعة المصروف:*\n\n' +
    '🔢 رقم المصروف: {exp_id}\n' +
    '📝 البند: {item}\n' +
    '💰 المبلغ: {amount}\n' +
    '🏠 الشقة: {apartment}\n' +
    '💳 الدفع: {payment}\n' +
    '🗒️ ملاحظات: {notes}\n' +
    '👤 المسئول: {responsible}\n' +
    '🕐 التاريخ: {date}\n' +
    '📎 الإيصال: {receipt}',
  exp_group_msg:
    '💸 *مصروف جديد*\n\n' +
    '🔢 رقم المصروف: {exp_id}\n' +
    '📝 البند: {item}\n' +
    '💰 المبلغ: {amount}\n' +
    '🏠 الشقة: {apartment}\n' +
    '💳 الدفع: {payment}\n' +
    '🗒️ ملاحظات: {notes}\n' +
    '👤 المسئول: {actor}\n' +
    '🕐 التاريخ: {date}\n' +
    '📎 الإيصال: {receipt}',
  exp_saved: '✅ تم حفظ المصروف وإرساله للجروب.\nأرسل /start من جديد.',
  exp_saved_no_group:
    '✅ تم حفظ المصروف.\n⚠️ تعذّر الإرسال للجروب (تأكد من إضافة البوت).\nأرسل /start من جديد.',

  ask_booking_id: '🔖 أدخل رقم البوكينج (إن وجد) أو اضغط تخطي:',
  btn_skip: 'تخطي',
  ask_private_id: '🆔 أدخل الـ ID:',
  ask_name: '👤 اسم المقيم:',
  name_error: '❌ أحرف ومسافات فقط، 3 أحرف على الأقل. حاول مجدداً:',
  ask_btype: '📑 نوع الحجز:',
  ask_phone: '📞 رقم الهاتف:',
  ask_apt_room: '🏠 اختر الشقة والغرفة:',
  ask_nights: '🌙 عدد الليالي:',
  btn_infinity: '∞ مفتوح',
  num_error: '❌ أدخل رقماً صحيحاً:',
  ask_arrival: '📅 اختر تاريخ البداية:',
  cal_months: ['', 'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
  cal_days: ['Sa', 'Su', 'Mo', 'Tu', 'We', 'Th', 'Fr'],
  ask_total: '💰 اجمالي سعر الحجز:',
  ask_payment: '💳 طريقة الدفع:',
  ask_paid: '💵 اجمالي ما تم دفعه:',
  ask_receipt: '📎 أرسل صورة إيصال التحويل أو اضغط تخطي:',
  receipt_error: '❌ أرسل صورة الإيصال أو اضغط تخطي:',
  receipt_attached: '✅ مرفق',
  ask_notes: '📝 ملاحظات (اختياري) أو اضغط تخطي:',
  confirm_summary:
    '📋 *مراجعة الحجز:*\n\n' +
    '🔖 بوكنج ID: {booking_id}\n' +
    '🆔 ID: {private_id}\n' +
    '👤 المقيم: {name}\n' +
    '📑 نوع الحجز: {btype}\n' +
    '📞 الهاتف: {phone}\n' +
    '🏠 الشقة: {apartment}\n' +
    '🚪 الغرفة: {room}\n' +
    '🌙 عدد الليالي: {nights}\n' +
    '📅 البداية: {arrival}\n' +
    '📅 المغادرة: {departure}\n' +
    '💰 الاجمالي: {total}\n' +
    '💵 المدفوع: {paid}\n' +
    '🧾 المتبقي: {remaining}\n' +
    '💳 الدفع: {payment}\n' +
    '📝 ملاحظات: {notes}\n' +
    '📎 الإيصال: {receipt}',
  group_msg:
    '🆕 *حجز جديد*\n\n' +
    '🔖 بوكنج ID: {booking_id}\n' +
    '🆔 ID: {private_id}\n' +
    '👤 المقيم: {name}\n' +
    '📑 نوع الحجز: {btype}\n' +
    '📞 الهاتف: {phone}\n' +
    '🏠 الشقة: {apartment}\n' +
    '🚪 الغرفة: {room}\n' +
    '🌙 عدد الليالي: {nights}\n' +
    '📅 البداية: {arrival}\n' +
    '📅 المغادرة: {departure}\n' +
    '💰 الاجمالي: {total}\n' +
    '💵 المدفوع: {paid}\n' +
    '🧾 المتبقي: {remaining}\n' +
    '💳 الدفع: {payment}\n' +
    '📝 ملاحظات: {notes}\n' +
    '📎 الإيصال: {receipt}\n' +
    '👤 بواسطة: {actor}',
  // ── Edit / cancel an already-saved booking ──
  btn_edit_booking: '✏️ تعديل حجز',
  edit_ask_paid_add:
    '💵 أدخل المبلغ المضاف (المدفوع حالياً: {current}):\n' +
    '↩️ للاسترداد أو تصحيح خطأ أدخل رقماً سالباً، مثل ‎-500',
  edit_paid_below_zero: '❌ المدفوع لا يمكن أن يقل عن صفر. المدفوع حالياً: {current}',
  edit_ask_id: '🔎 أدخل الـ ID:',
  edit_not_found: '❌ لا يوجد حجز بهذا الـ ID. حاول مجدداً أو أرسل /cancel:',
  edit_pick_match: '🔎 أكثر من حجز بنفس الرقم — اختر الحجز:',
  edit_menu: '✏️ اختر ما تريد تعديله:',
  btn_edit_total: '💰 اجمالي سعر الحجز',
  btn_edit_paid: '💵 اجمالي ما تم دفعه',
  btn_edit_payment: '💳 طريقة الدفع',
  btn_edit_nights: '🌙 عدد الليالي',
  btn_edit_arrival: '📅 تاريخ البداية',
  btn_edit_aptroom: '🏠 الشقة والغرفة',
  btn_edit_notes: '📝 ملاحظات',
  btn_edit_done: '✅ تم',
  // ── Checking an open-ended booking out, off the back of a payment ──
  edit_ask_left: '🚪 هل غادر النزيل؟',
  btn_yes: 'نعم',
  btn_no: 'لا',
  edit_ask_departure: '📅 اختر تاريخ المغادرة:',
  edit_departure_before_arrival:
    '❌ المغادرة ({departure}) قبل تاريخ البداية ({arrival}). اختر تاريخاً آخر:',
  edit_confirm_summary: '📋 *مراجعة التعديل:*\n\n{changes}',
  edit_departure_line: '📅 تاريخ المغادرة: {departure}',
  btn_delete_booking: '🗑️ إلغاء الحجز',
  edit_no_changes: 'لم يتم تغيير أي شيء. أرسل /start من جديد.',
  edit_saved: '✅ تم حفظ التعديلات وإرسالها للجروب.\nأرسل /start من جديد.',
  edit_saved_no_group: '✅ تم حفظ التعديلات.\n⚠️ تعذّر الإرسال للجروب.\nأرسل /start من جديد.',
  edit_group_msg:
    '✏️ *تعديل حجز*\n\n' +
    '👤 المقيم: {name}\n' +
    '🆔 ID: {private_id}\n\n' +
    '{changes}\n\n' +
    '👤 بواسطة: {actor}',
  del_confirm: '⚠️ تأكيد إلغاء الحجز التالي؟\n\n{summary}',
  del_saved: '✅ تم إلغاء الحجز وإرساله للجروب.\nأرسل /start من جديد.',
  del_saved_no_group: '✅ تم إلغاء الحجز.\n⚠️ تعذّر الإرسال للجروب.\nأرسل /start من جديد.',
  del_group_msg:
    '🗑️ *إلغاء حجز*\n\n' +
    '👤 المقيم: {name}\n' +
    '🆔 ID: {private_id}\n' +
    '🏠 الشقة: {apartment}\n' +
    '🚪 الغرفة: {room}\n' +
    '📅 البداية: {arrival}\n' +
    '👤 بواسطة: {actor}',
  del_note: 'ملغي',
  // ── Cashier: add a payment to an existing booking ──
  btn_add_paid: '💵 إضافة مبلغ مدفوع',
  paid_ask_id: '🔎 أدخل الـ ID الخاص بالحجز:',
  paid_ask_amount: '💵 أدخل المبلغ المدفوع (المدفوع حالياً: {current}):',
  paid_ask_receipt: '📎 أرسل صورة إيصال التحويل:',
  paid_receipt_error: '❌ لا بد من إرسال صورة الإيصال:',
  paid_saved: '✅ تم تسجيل الدفعة وإرسالها للجروب.\nأرسل /start من جديد.',
  paid_saved_no_group: '✅ تم تسجيل الدفعة.\n⚠️ تعذّر الإرسال للجروب.\nأرسل /start من جديد.',
  paid_group_msg:
    '💵 *دفعة جديدة*\n\n' +
    '👤 المقيم: {name}\n' +
    '🆔 ID: {private_id}\n' +
    '🏠 الشقة: {apartment}\n' +
    '➕ المبلغ المضاف: {added}\n' +
    '💵 اجمالي ما تم دفعه: {paid}\n' +
    '💳 الدفع: {payment}\n' +
    '📎 الإيصال: {receipt}\n' +
    '👤 بواسطة: {actor}',
  btn_confirm: '✅ حفظ',
  btn_cancel: '❌ إلغاء',
  saved: '✅ تم حفظ الحجز وإرساله للجروب.\nأرسل /start لإدخال حجز جديد.',
  saved_no_group:
    '✅ تم حفظ الحجز.\n⚠️ تعذّر الإرسال للجروب (تأكد من إضافة البوت للجروب).\nأرسل /start لإدخال حجز جديد.',
  cancelled: 'تم الإلغاء. أرسل /start للبدء من جديد.',
  error: '⚠️ حدث خطأ أثناء الحفظ. حاول مجدداً.',
  infinity_label: '∞ مفتوح',
  empty: '—',
};

function t(key, vars) {
  let val = S[key] !== undefined ? S[key] : key;
  if (typeof val === 'string' && vars) {
    val = val.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  }
  return val;
}

// ─── Keyboard helpers (port of _grid / _skip_kb / _num_keyboard) ──────────────

function grid(options, prefix, perRow) {
  perRow = perRow || 2;
  const rows = [];
  for (let i = 0; i < options.length; i += perRow) {
    rows.push(options.slice(i, i + perRow).map((opt, j) => ({
      text: opt, callback_data: `${prefix}${i + j}`,
    })));
  }
  return { inline_keyboard: rows };
}

function skipKb(cbData) {
  return { inline_keyboard: [[{ text: t('btn_skip'), callback_data: cbData }]] };
}

function numKeyboard(lo, hi, prefix, extra, perRow) {
  perRow = perRow || 5;
  const nums = [];
  for (let n = lo; n <= hi; n++) nums.push({ text: String(n), callback_data: `${prefix}${n}` });
  const rows = [];
  for (let i = 0; i < nums.length; i += perRow) rows.push(nums.slice(i, i + perRow));
  if (extra) rows.push(extra);
  return { inline_keyboard: rows };
}

function aptRoomKb() {
  const rows = [];
  APARTMENTS.forEach((apt, i) => {
    rows.push([{ text: `🏠 ${apt}`, callback_data: 'ar_hdr' }]);
    const nums = [];
    for (let n = 1; n <= ROOMS_PER_APARTMENT; n++) {
      nums.push({ text: String(n), callback_data: `ar_${i}_${n}` });
    }
    rows.push(nums);
  });
  return { inline_keyboard: rows };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

const MIN_YEAR = 2000, MIN_MONTH = 1;

function todayParts() {
  // "today" in the bot's timezone, not the n8n container's UTC clock.
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, m, d] = f.format(new Date()).split('-').map(Number);
  return { y, m, d };
}

function nowStamp() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  // en-CA gives "2026-08-06, 14:05" → normalise to "2026-08-06 14:05"
  return f.format(new Date()).replace(',', '').replace(/\s+/, ' ');
}

function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/** Whole days from one ISO date to another, or null if either is unparseable. */
function daysBetween(fromIso, toIso) {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fromIso || '').trim());
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(toIso || '').trim());
  if (!a || !b) return null;
  const ms = Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3]);
  return Math.round(ms / 86400000);
}

function isoAddDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Calendar keyboard, weeks starting Saturday (Python Calendar(firstweekday=5)). */
function calKeyboard(year, month) {
  const tp = todayParts();
  const rows = [
    [
      { text: '◀️', callback_data: `cal_prev_${year}_${String(month).padStart(2, '0')}` },
      { text: `${S.cal_months[month]} ${year}`, callback_data: 'cal_ignore' },
      { text: '▶️', callback_data: `cal_next_${year}_${String(month).padStart(2, '0')}` },
    ],
    S.cal_days.map(d => ({ text: d, callback_data: 'cal_ignore' })),
  ];
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // Sun=0..Sat=6
  const lead = (first - 6 + 7) % 7;                                // blanks before day 1
  const total = daysInMonth(year, month);
  let row = [];
  for (let i = 0; i < lead; i++) row.push({ text: ' ', callback_data: 'cal_ignore' });
  for (let day = 1; day <= total; day++) {
    const isToday = year === tp.y && month === tp.m && day === tp.d;
    row.push({
      text: isToday ? `[${day}]` : String(day),
      callback_data: `cal_day_${year}_${String(month).padStart(2, '0')}_${String(day).padStart(2, '0')}`,
    });
    if (row.length === 7) { rows.push(row); row = []; }
  }
  if (row.length) {
    while (row.length < 7) row.push({ text: ' ', callback_data: 'cal_ignore' });
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

// ─── Value helpers (port of _num / _txt / _parse_num / validate_name) ─────────

function parseNum(text) {
  const v = parseFloat(String(text).trim().replace(/,/g, ''));
  return Number.isNaN(v) ? null : v;
}

/** Drop trailing .0 for whole numbers so the sheet stays clean. */
function num(v) {
  const f = Number(v);
  return Number.isInteger(f) ? f : Math.round(f * 100) / 100;
}

/** Force text storage (preserve leading zeros in phones/IDs) via Sheets' ' marker. */
function txt(v) { return v ? `'${v}` : v; }

function validateName(text) {
  const cleaned = String(text).trim();
  if (cleaned.length < 3) return null;
  if (!/^[A-Za-z؀-ۿ\s]+$/.test(cleaned)) return null;
  return cleaned;
}

/** Quote a tab name for A1 notation (tab names here contain Arabic + spaces). */
function a1Tab(tab) { return `'${String(tab).replace(/'/g, "''")}'`; }

// ─── Session store (n8n Data Table, via the "Load Session" node) ──────────────
//
// This used to be $getWorkflowStaticData('global'). That silently loses state on
// every *manual* execution — n8n only persists static data for production runs —
// so a button tap after /start always arrived with no session and fell straight
// through to "No Action Needed". The row now comes from the `bookings_bot_sessions`
// data table and is written back by the "Save Session" node.

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// ─── Parse the incoming Telegram update ───────────────────────────────────────

const cq = upd.callback_query || null;
const msg = cq ? cq.message : upd.message;
const from = cq ? cq.from : (upd.message ? upd.message.from : null);

if (!msg || !from) return [];                       // ignore edits, joins, etc.

const chatId = String(msg.chat.id);
const text = cq ? null : String(upd.message.text || '');
const cbData = cq ? String(cq.data || '') : null;
const cbId = cq ? cq.id : null;

// Telegram sends photos as an array of sizes, smallest first; the last entry is
// the highest resolution. Only the RECEIPT states consume this.
const photoSizes = (!cq && upd.message && upd.message.photo) ? upd.message.photo : null;
const photoFileId =
  photoSizes && photoSizes.length ? photoSizes[photoSizes.length - 1].file_id : null;

if (!cq && !upd.message.text && !photoFileId) return [];   // stickers etc → ignore

const responsible =
  [from.first_name, from.last_name].filter(Boolean).join(' ') ||
  (from.username ? `@${from.username}` : String(from.id));

/**
 * Escape legacy-Markdown metacharacters. Group posts go out with
 * parse_mode: 'Markdown', and Telegram rejects the whole message with a 400 if
 * the entities do not balance — a single underscore in a username (@ahmed_isa)
 * is enough to lose the notification.
 */
function mdEscape(s) { return String(s).replace(/([_*[\]`])/g, '\\$1'); }

/**
 * Who performed this action, for the group notification — the display name on
 * its own. `responsible` already falls back to the @handle, then to the numeric
 * id, for accounts with no name set.
 */
const actor = mdEscape(responsible);

// ─── Who is this, and what may they do? ───────────────────────────────────────

const fromId = String(from.id);
const fromUsername = String(from.username || '').toLowerCase();

function inList(list) {
  return list.includes(fromId) || (Boolean(fromUsername) && list.includes(fromUsername));
}

const isAdmin = inList(ADMIN_USERS);
const isCashier = !isAdmin && inList(CASHIER_USERS);   // admin wins if on both

// ─── Load the session for this chat ───────────────────────────────────────────
// "Load Session" is a Data Table node filtered on chat_id. It has
// alwaysOutputData enabled, so a chat with no row yields an empty item ({}).

const loadedRow = $('Load Session').first().json || {};

function readSession(row) {
  if (!row || !row.state) return null;                // no row, or session ended
  if (Date.now() - Number(row.updated_at || 0) > SESSION_TTL_MS) return null;
  let parsed = {};
  try { parsed = JSON.parse(row.data || '{}'); } catch (e) { parsed = {}; }
  return { state: row.state, data: parsed };
}

const session = readSession(loadedRow);
const d = session ? session.data : {};
const state = session ? session.state : null;

// "Read Bookings For Edit" only runs when the loaded state is EDIT_FIND, so on
// every other turn the node is unexecuted and referencing it throws. That is the
// point — the lookup costs a Sheets call only on the one turn that needs it.
function bookingRows() {
  try {
    return $('Read Bookings For Edit').all().map((i, idx) => ({
      // n8n's Sheets read exposes the true sheet row as row_number. Prefer it:
      // positional arithmetic breaks if the node ever drops a blank row, and
      // editing the wrong row is the worst failure this flow has.
      row: Number(i.json.row_number) || idx + 2,
      json: i.json,
    }));
  } catch (e) {
    return [];
  }
}

// ─── Output builder ───────────────────────────────────────────────────────────

const out = {
  chatId,
  callbackQueryId: cbId,
  hasCallback: Boolean(cbId),
  hasReply: false,
  reply: null,
  hasSave: false,
  save: null,
  // Persisted by "Save Session". Default to whatever we loaded, so a turn that
  // changes nothing (an ignored tap) leaves the session exactly as it was.
  sessionState: session ? session.state : '',
  sessionData: session ? JSON.stringify(session.data) : '{}',
};

function reply(text_, markup, markdown) {
  out.hasReply = true;
  out.reply = {
    chat_id: chatId,
    text: text_,
    ...(markdown ? { parse_mode: 'Markdown' } : {}),
    ...(markup ? { reply_markup: markup } : {}),
  };
}

function setState(state, data) {
  out.sessionState = state;
  out.sessionData = JSON.stringify(data || {});
}

/** An ended session is stored as an empty state, not a deleted row — one upsert
 *  node then covers both cases and there is no delete branch to keep in sync. */
function endSession() {
  out.sessionState = '';
  out.sessionData = '{}';
}

// ─── Access gate ──────────────────────────────────────────────────────────────
// Nobody outside the two lists gets a conversation. Commands get one plain
// refusal so a legitimate new colleague knows to ask for access; anything else
// is dropped without a reply and without touching the session table, so the bot
// cannot be made to chatter at a stranger who keeps typing.

if (!isAdmin && !isCashier) {
  if ((text || '').startsWith('/')) {
    endSession();
    reply(t('not_authorized'));
    return [{ json: out }];
  }
  return [];
}

// ─── Derived / summary (port of _derived + _summary_kwargs) ───────────────────

function derived(dd) {
  const remaining = dd.total - dd.paid;
  const nightsDisp = dd.infinity ? t('infinity_label') : String(dd.nights);
  const departure = dd.infinity ? t('infinity_label') : isoAddDays(dd.arrival_date, dd.nights);
  return { remaining: num(remaining), nights_disp: nightsDisp, departure };
}

// Every message built from these vars is sent with parse_mode: 'Markdown', so
// each free-text field the user typed (or that came back off the sheet) has to be
// escaped. An unbalanced _ or * makes Telegram reject the whole message with a
// 400: the row is still written, but the confirmation or the group post silently
// never arrives. Fixed values — apartment names, payment methods, dates, numbers
// — come from our own lists and are left alone.
function summaryVars(dd, dv) {
  return {
    booking_id: mdEscape(dd.booking_id || t('empty')),
    private_id: mdEscape(dd.private_id), name: mdEscape(dd.name), btype: dd.btype,
    phone: mdEscape(dd.phone), apartment: dd.apartment, room: dd.room,
    nights: dv.nights_disp, arrival: dd.arrival_date, departure: dv.departure,
    total: num(dd.total), paid: num(dd.paid), remaining: dv.remaining,
    payment: dd.payment, notes: mdEscape(dd.notes || t('empty')),
    receipt: dd.receipt ? t('receipt_attached') : t('empty'),
    actor,
  };
}

function expVars(dd) {
  return {
    exp_id: mdEscape(dd.exp_id || t('empty')),
    item: mdEscape(dd.exp_item), amount: num(dd.exp_amount),
    apartment: dd.exp_apartment || t('empty'), payment: dd.exp_payment,
    notes: mdEscape(dd.exp_notes || t('empty')), responsible: mdEscape(dd.responsible),
    date: dd.exp_date,
    receipt: dd.exp_receipt ? t('receipt_attached') : t('empty'),
    // The sheet's اسم المسئول column keeps the plain name (`responsible`); only
    // the group post carries the @handle, so the two are not interchangeable.
    actor,
  };
}

// ─── Step transitions shared by several states ────────────────────────────────

function askPhone() { reply(t('ask_phone')); setState('PHONE', d); }
function askArrival() {
  const tp = todayParts();
  d.cal_year = tp.y; d.cal_month = tp.m;
  reply(t('ask_arrival'), calKeyboard(tp.y, tp.m));
  setState('ARRIVAL', d);
}
function showConfirm() {
  const dv = derived(d);
  reply(t('confirm_summary', summaryVars(d, dv)), {
    inline_keyboard: [
      [{ text: t('btn_confirm'), callback_data: 'save' }],
      [{ text: t('btn_cancel'), callback_data: 'cancel' }],
    ],
  }, true);
  setState('CONFIRM', d);
}
function showExpConfirm() {
  d.exp_date = nowStamp();
  d.responsible = responsible;
  reply(t('exp_confirm_summary', expVars(d)), {
    inline_keyboard: [
      [{ text: t('btn_confirm'), callback_data: 'esave' }],
      [{ text: t('btn_cancel'), callback_data: 'ecancel' }],
    ],
  }, true);
  setState('EXP_CONFIRM', d);
}
// ─── Edit flow helpers ────────────────────────────────────────────────────────

function startEdit() { reply(t('edit_ask_id'), null); setState('EDIT_FIND', {}); }

/** Menu of editable fields, plus finish and cancel-the-booking. */
function showEditMenu(dd) {
  const rows = EDIT_FIELDS.map(f => [{ text: t(f.labelKey), callback_data: `ef_${f.key}` }]);
  rows.push([{ text: t('btn_edit_done'), callback_data: 'ef_done' }]);
  rows.push([{ text: t('btn_delete_booking'), callback_data: 'ef_delete' }]);
  reply(t('edit_menu'), { inline_keyboard: rows });
  setState('EDIT_MENU', dd);
}

/**
 * What is paid on this booking right now: an amount already added earlier in
 * this same edit session if there is one, otherwise the sheet's value. Without
 * the editNew check, adding twice in one session would both times add to the
 * original figure and silently lose the first payment.
 */
function paidSoFar(dd) {
  const col = 'اجمالي ما تم دفعه';
  if (dd.editNew && dd.editNew[col] !== undefined) return Number(dd.editNew[col]) || 0;
  return parseNum(dd.editOrig ? dd.editOrig[col] : 0) || 0;
}

/** Record a change, keeping the original value for the group diff. */
function editSet(dd, col, value) {
  if (!dd.editNew) dd.editNew = {};
  dd.editNew[col] = value;
}

/** Lock the edit session onto one sheet row, then continue with the right flow. */
function applyPick(hit) {
  d.editRow = hit.row;
  d.editOrig = hit.json;
  d.editNew = {};
  d.editName = hit.json['اسم المقيم'] || '';
  d.editPrivateId = hit.json['ID'] || '';
  if (d.paidOnly) {
    // Cashier flow: the booking is found, so go straight to the amount. There is
    // no field menu for them — payment is the only thing they may touch.
    reply(t('paid_ask_amount', { current: num(paidSoFar(d)) }));
    setState('EDIT_PAID', d);
    return;
  }
  showEditMenu(d);
}

/**
 * Where a completed edit step goes next.
 *
 *  - cashier: linear, saves as soon as the payment (and its receipt) is in;
 *  - admin who just recorded a payment: asked whether the guest has left, since
 *    settling up is when a checkout actually gets noticed. That question is
 *    asked once per session (`leaveAsked`) and ends in a summary + approval
 *    rather than the field menu;
 *  - anything else: back to the field menu.
 */
function afterEditStep(dd) {
  if (dd.paidOnly) { commitEdit(dd); return; }
  if (dd.paidTouched && !dd.leaveAsked) {
    reply(t('edit_ask_left'), {
      inline_keyboard: [[
        { text: t('btn_yes'), callback_data: 'xleft_yes' },
        { text: t('btn_no'), callback_data: 'xleft_no' },
      ]],
    });
    setState('EDIT_LEFT', dd);
    return;
  }
  showEditMenu(dd);
}

/** Final review of everything this edit session changed, before it is written. */
function showEditConfirm(dd) {
  reply(t('edit_confirm_summary', { changes: changeLines(dd) }), {
    inline_keyboard: [
      [{ text: t('btn_confirm'), callback_data: 'xedone' }],
      [{ text: t('btn_cancel'), callback_data: 'xecancel' }],
    ],
  }, true);
  setState('EDIT_CONFIRM', dd);
}

function bookingLabel(rowJson) {
  return [rowJson['اسم المقيم'], rowJson['اسم الشقة'], rowJson['تاريخ البداية']]
    .filter(Boolean).join(' — ');
}

/**
 * A cell as it should appear in a Markdown message: an open-ended stay is stored
 * as a live formula, so show the word instead; everything else is sheet text and
 * has to be escaped before it reaches Telegram.
 */
function showValue(v) {
  if (v === undefined || v === '') return t('empty');
  return String(v).trim().startsWith('=') ? t('infinity_label') : mdEscape(v);
}

/**
 * '2000 ← 4500' lines for every column that actually changed, plus the resulting
 * departure date when a checkout was recorded. تاريخ المغادرة is a sheet formula
 * (J + I) so it is never written — it is shown here because it is what the person
 * approving actually wants to see.
 */
function changeLines(dd) {
  const out_ = [];
  for (const col of Object.keys(dd.editNew || {})) {
    out_.push(`${col}: ${showValue(dd.editOrig && dd.editOrig[col])} ← ${showValue(dd.editNew[col])}`);
  }
  if (dd.departure) out_.push(t('edit_departure_line', { departure: dd.departure }));
  return out_.join('\n');
}

/**
 * Hand the changed columns to the sheet writer. Shared by the admin field menu
 * ("تم") and by the cashier's add-a-payment flow, which differ only in what the
 * group and the confirmation say.
 */
function commitEdit(dd) {
  const paidCol = 'اجمالي ما تم دفعه';
  out.hasSave = true;
  out.save = {
    flow: 'edit',
    row: dd.editRow,                 // from the lookup, never computed
    fields: dd.editNew,              // only the columns that actually changed
    receiptFileId: dd.editReceipt || '',
    groupChatId: CFG.GROUP_CHAT_ID,
    groupText: dd.paidOnly
      ? t('paid_group_msg', {
        name: mdEscape(dd.editName || t('empty')),
        private_id: mdEscape(dd.editPrivateId || t('empty')),
        apartment: mdEscape((dd.editOrig && dd.editOrig['اسم الشقة']) || t('empty')),
        added: num(dd.paidAdded || 0),
        paid: dd.editNew[paidCol],
        payment: dd.editNew['طريقة الدفع'] || t('empty'),
        receipt: dd.editReceipt ? t('receipt_attached') : t('empty'),
        actor,
      })
      : t('edit_group_msg', {
        name: mdEscape(dd.editName), private_id: mdEscape(dd.editPrivateId),
        changes: changeLines(dd), actor,
      }),
    savedText: dd.paidOnly ? t('paid_saved') : t('edit_saved'),
    savedNoGroupText: dd.paidOnly ? t('paid_saved_no_group') : t('edit_saved_no_group'),
    errorText: t('error'),
  };
}

function startBooking() { reply(t('ask_booking_id'), skipKb('bid_skip')); setState('BOOKING_ID', {}); }
function startExpense() { reply(t('exp_ask_id'), skipKb('eid_skip')); setState('EXP_ID', {}); }

/**
 * Cashier's add-a-payment entry. It deliberately reuses the EDIT_FIND state:
 * the "Needs Bookings?" gate in the workflow keys the Sheets lookup off that
 * exact state name, so a separate state would need a graph change to be able to
 * find anything. `paidOnly` on the session data is what makes it linear.
 */
function startPaid() { reply(t('paid_ask_id')); setState('EDIT_FIND', { paidOnly: true }); }

// ─── Entry points: /start and /cancel ─────────────────────────────────────────

if (text === '/start' || (text || '').startsWith('/start@')) {
  endSession();
  if (isAdmin) {
    reply(t('choose_action'), {
      inline_keyboard: [
        [{ text: t('btn_add_booking'), callback_data: 'choice_booking' }],
        [{ text: t('btn_add_expense'), callback_data: 'choice_expense' }],
        [{ text: t('btn_edit_booking'), callback_data: 'choice_edit' }],
      ],
    });
  } else {
    // Cashier: expenses, or a payment against a booking. No booking entry, no
    // field menu — those buttons are never rendered, and CHOICE refuses their
    // callback_data anyway in case an old keyboard is still on screen.
    reply(t('choose_action'), {
      inline_keyboard: [
        [{ text: t('btn_add_expense'), callback_data: 'choice_expense' }],
        [{ text: t('btn_add_paid'), callback_data: 'choice_paid' }],
      ],
    });
  }
  setState('CHOICE', {});
  return [{ json: out }];
}

if (text === '/cancel' || (text || '').startsWith('/cancel@')) {
  endSession();
  reply(t('cancelled'));
  return [{ json: out }];
}

// No active conversation and not a command → stay silent (matches PTB).
if (!state) return [{ json: out }];

// ─── State machine ────────────────────────────────────────────────────────────

switch (state) {

  // ── Router ────────────────────────────────────────────────────────────────
  case 'CHOICE':
    if (cbData === 'choice_expense') startExpense();
    else if (cbData === 'choice_paid' && isCashier) startPaid();
    else if (cbData === 'choice_booking' && isAdmin) startBooking();
    else if (cbData === 'choice_edit' && isAdmin) startEdit();
    break;

  // ── Expense flow ──────────────────────────────────────────────────────────
  case 'EXP_ID':
    d.exp_id = cbData === 'eid_skip' ? '' : (text || '').trim();
    reply(t('exp_ask_item'));
    setState('EXP_ITEM', d);
    break;

  case 'EXP_ITEM':
    if (cq) break;
    d.exp_item = text.trim();
    reply(t('exp_ask_amount'));
    setState('EXP_AMOUNT', d);
    break;

  case 'EXP_AMOUNT': {
    if (cq) break;
    const v = parseNum(text);
    if (v === null || v < 0) { reply(t('num_error')); break; }
    d.exp_amount = v;
    const kb = grid(APARTMENTS, 'eapt_');
    kb.inline_keyboard.push([{ text: t('btn_apt_none'), callback_data: 'eapt_none' }]);
    reply(t('exp_ask_apartment'), kb);
    setState('EXP_APT', d);
    break;
  }

  case 'EXP_APT': {
    if (!cbData || !cbData.startsWith('eapt_')) break;
    const suffix = cbData.slice('eapt_'.length);
    d.exp_apartment = suffix === 'none' ? '' : APARTMENTS[Number(suffix)];
    reply(t('exp_ask_payment'), grid(EXP_PAYMENTS, 'epay_'));
    setState('EXP_PAY', d);
    break;
  }

  case 'EXP_PAY':
    if (!cbData || !cbData.startsWith('epay_')) break;
    d.exp_payment = EXP_PAYMENTS[Number(cbData.slice('epay_'.length))];
    if (RECEIPT_PAYMENTS.includes(d.exp_payment)) {        // transfer → offer receipt
      reply(t('ask_receipt'), skipKb('ereceipt_skip'));
      setState('EXP_RECEIPT', d);
      break;
    }
    reply(t('exp_ask_notes'), skipKb('enotes_skip'));
    setState('EXP_NOTES', d);
    break;

  case 'EXP_RECEIPT':
    if (cbData === 'ereceipt_skip') d.exp_receipt = '';
    else if (photoFileId) d.exp_receipt = photoFileId;
    else { reply(t('receipt_error'), skipKb('ereceipt_skip')); break; }
    reply(t('exp_ask_notes'), skipKb('enotes_skip'));
    setState('EXP_NOTES', d);
    break;

  case 'EXP_NOTES':
    d.exp_notes = cbData === 'enotes_skip' ? '' : (text || '').trim();
    showExpConfirm();
    break;

  case 'EXP_CONFIRM': {
    if (cbData === 'ecancel') { endSession(); reply(t('cancelled')); break; }
    if (cbData !== 'esave') break;
    const now = nowStamp();
    out.hasSave = true;
    out.save = {
      flow: 'expense',
      tabA1: a1Tab(CFG.EXPENSE_TAB),
      keyRange: `${a1Tab(CFG.EXPENSE_TAB)}!B:B`,   // البند — manual key column, no formulas
      // Keyed by the sheet's real header text — the Google Sheets node maps by
      // column NAME, not letter. Verified against row 1 on 2026-08-06; note the
      // responsible column is "اسم المسئول", not "المسئول".
      fields: {
        'تاريخ': now,
        'البند': d.exp_item,
        'المبلغ': num(d.exp_amount),
        'الشقة': d.exp_apartment,
        'ملاحظات': d.exp_notes,
        'طريقة الدفع': d.exp_payment,
        'اسم المسئول': d.responsible || responsible,
        'الرقم': txt(d.exp_id || ''),
      },
      // Legacy positional form, still consumed by the HTTP write path.
      ranges: [{
        range: 'A{r}:H{r}',
        values: [[
          now, d.exp_item, num(d.exp_amount), d.exp_apartment,
          d.exp_notes, d.exp_payment, d.responsible || responsible, txt(d.exp_id || ''),
        ]],
      }],
      receiptFileId: d.exp_receipt || '',   // '' → group gets a plain text message
      groupChatId: CFG.EXPENSE_GROUP_CHAT_ID,
      groupText: t('exp_group_msg', expVars(d)),
      savedText: t('exp_saved'),
      savedNoGroupText: t('exp_saved_no_group'),
      errorText: t('error'),
    };
    break;
  }

  // ── Booking flow ──────────────────────────────────────────────────────────
  case 'BOOKING_ID':
    d.booking_id = cbData === 'bid_skip' ? '' : (text || '').trim();
    reply(t('ask_private_id'));
    setState('PRIVATE_ID', d);
    break;

  case 'PRIVATE_ID':
    if (cq) break;
    d.private_id = text.trim();
    reply(t('ask_name'));
    setState('NAME', d);
    break;

  case 'NAME': {
    if (cq) break;
    const nm = validateName(text);
    if (nm === null) { reply(t('name_error')); break; }
    d.name = nm;
    if (d.booking_id) { d.btype = 'بوكينج'; askPhone(); }
    else { reply(t('ask_btype'), grid(BTYPE_OPTS, 'bt_')); setState('BTYPE', d); }
    break;
  }

  case 'BTYPE':
    if (!cbData || !cbData.startsWith('bt_')) break;
    d.btype = BTYPE_OPTS[Number(cbData.slice('bt_'.length))];
    askPhone();
    break;

  case 'PHONE':
    if (cq) break;
    d.phone = text.trim();
    reply(t('ask_apt_room'), aptRoomKb());
    setState('APT_ROOM', d);
    break;

  case 'APT_ROOM': {
    if (cbData === 'ar_hdr') break;                       // header tap → no-op
    const m = /^ar_(\d+)_(\d+)$/.exec(cbData || '');
    if (!m) break;
    d.apartment = APARTMENTS[Number(m[1])];
    d.room = m[2];
    reply(t('ask_nights'), numKeyboard(1, 30, 'nights_',
      [{ text: t('btn_infinity'), callback_data: 'nights_inf' }], 5));
    setState('NIGHTS', d);
    break;
  }

  case 'NIGHTS': {
    if (cbData && cbData.startsWith('nights_')) {
      const suffix = cbData.slice('nights_'.length);
      if (suffix === 'inf') { d.infinity = true; d.nights = null; }
      else { d.infinity = false; d.nights = Number(suffix); }
      askArrival();
      break;
    }
    if (cq) break;
    const v = parseNum(text);
    if (v === null || v <= 0) { reply(t('num_error')); break; }
    d.infinity = false; d.nights = Math.trunc(v);
    askArrival();
    break;
  }

  case 'ARRIVAL': {
    if (!cbData) break;
    if (cbData === 'cal_ignore') break;                   // answer callback only

    let m = /^cal_(prev|next)_(\d+)_(\d+)$/.exec(cbData);
    if (m) {
      const dir = m[1], y = Number(m[2]), mo = Number(m[3]);
      let ny = y, nm = mo;
      if (dir === 'prev') { nm = mo - 1; if (nm === 0) { nm = 12; ny = y - 1; } }
      else { nm = mo + 1; if (nm === 13) { nm = 1; ny = y + 1; } }
      if (ny < MIN_YEAR || (ny === MIN_YEAR && nm < MIN_MONTH)) break;
      d.cal_year = ny; d.cal_month = nm;
      reply(t('ask_arrival'), calKeyboard(ny, nm));
      setState('ARRIVAL', d);
      break;
    }

    m = /^cal_day_(\d+)_(\d+)_(\d+)$/.exec(cbData);
    if (m) {
      d.arrival_date = `${m[1]}-${m[2]}-${m[3]}`;
      reply(t('ask_total'));
      setState('TOTAL', d);
    }
    break;
  }

  case 'TOTAL': {
    if (cq) break;
    const v = parseNum(text);
    if (v === null || v < 0) { reply(t('num_error')); break; }
    d.total = v;
    reply(t('ask_payment'), grid(PAYMENTS, 'pay_'));
    setState('PAYMENT', d);
    break;
  }

  case 'PAYMENT':
    if (!cbData || !cbData.startsWith('pay_')) break;
    d.payment = PAYMENTS[Number(cbData.slice('pay_'.length))];
    if (d.payment === 'غير مدفوع') {                       // nothing paid → skip PAID
      d.paid = 0;
      reply(t('ask_notes'), skipKb('notes_skip'));
      setState('NOTES', d);
    } else {
      reply(t('ask_paid'));
      setState('PAID', d);
    }
    break;

  // The receipt is asked *after* the paid amount, so the user enters the figure
  // first and then attaches the transfer proving it.
  case 'RECEIPT':
    if (cbData === 'receipt_skip') d.receipt = '';
    else if (photoFileId) d.receipt = photoFileId;
    else { reply(t('receipt_error'), skipKb('receipt_skip')); break; }
    reply(t('ask_notes'), skipKb('notes_skip'));
    setState('NOTES', d);
    break;

  case 'PAID': {
    if (cq) break;
    const v = parseNum(text);
    if (v === null || v < 0) { reply(t('num_error')); break; }
    d.paid = v;
    if (RECEIPT_PAYMENTS.includes(d.payment)) {            // transfer → offer receipt
      reply(t('ask_receipt'), skipKb('receipt_skip'));
      setState('RECEIPT', d);
      break;
    }
    reply(t('ask_notes'), skipKb('notes_skip'));
    setState('NOTES', d);
    break;
  }

  case 'NOTES':
    d.notes = cbData === 'notes_skip' ? '' : (text || '').trim();
    showConfirm();
    break;

  case 'CONFIRM': {
    if (cbData === 'cancel') { endSession(); reply(t('cancelled')); break; }
    if (cbData !== 'save') break;
    const dv = derived(d);

    // Column I (عدد الليالي): open-ended → live formula; else the integer.
    // Column J = تاريخ البداية; the sheet derives K (مغادرة) = J + I automatically.
    // "{r}" is substituted with the real row number by "Build Booking Row".
    const nightsCell = d.infinity ? '=TODAY()-J{r}' : d.nights;

    // Legacy positional form, still consumed by the HTTP write path. Derived from
    // `fields` below so the two cannot drift apart.
    const aToJ = [
      txt(d.booking_id), txt(d.private_id), d.name, d.btype,
      '', txt(d.phone), d.apartment, Number(d.room),   // E (الجنسية) retired, kept blank
      nightsCell, d.arrival_date,
    ];

    out.hasSave = true;
    out.save = {
      flow: 'booking',
      tabA1: a1Tab(CFG.BOOKINGS_TAB),
      keyRange: `${a1Tab(CFG.BOOKINGS_TAB)}!C:C`,  // اسم المقيم — no formula → true last row
      // Keyed by the sheet's real header text (verified against row 1 on
      // 2026-08-06). Input columns ONLY: K تاريخ المغادرة, N نسبة البرنامج,
      // P المتبقي, R تاريخ الإدخال, S صافي الدخل and T آخر تعديل are calculated
      // by the sheet and are deliberately absent here, so the node never writes
      // them and their formulas survive.
      fields: {
        'بوكنج ID': txt(d.booking_id),
        'ID': txt(d.private_id),
        'اسم المقيم': d.name,
        'نوع الحجز': d.btype,
        'الجنسية': '',                                  // retired, kept blank
        'رقم الهاتف': txt(d.phone),
        'اسم الشقة': d.apartment,
        'رقم الغرفة': Number(d.room),
        'عدد الليالي': nightsCell,
        'تاريخ البداية': d.arrival_date,
        'اجمالي سعر الحجز': num(d.total),
        'اجمالي ما تم دفعه': num(d.paid),
        'طريقة الدفع': d.payment,
        'ملاحظات': d.notes,
      },
      ranges: [
        { range: 'A{r}:J{r}', values: [aToJ] },
        { range: 'L{r}:M{r}', values: [[num(d.total), num(d.paid)]] },
        { range: 'O{r}', values: [[d.payment]] },       // P skipped on purpose
        { range: 'Q{r}', values: [[d.notes]] },
      ],
      receiptFileId: d.receipt || '',   // '' → group gets a plain text message
      groupChatId: CFG.GROUP_CHAT_ID,
      groupText: t('group_msg', summaryVars(d, dv)),
      savedText: t('saved'),
      savedNoGroupText: t('saved_no_group'),
      errorText: t('error'),
    };
    break;
  }

  // ── Edit / cancel an existing booking ─────────────────────────────────────

  case 'EDIT_FIND': {
    if (cq) break;
    const q = (text || '').trim();
    if (!q) { reply(t(d.paidOnly ? 'paid_ask_id' : 'edit_ask_id')); break; }
    // Matches column B (ID) only — not بوكنج ID. The user is told to enter the
    // ID, and B is a required step at entry so every saved booking is reachable.
    const hits = bookingRows().filter(x => String(x.json['ID'] || '').trim() === q);
    if (!hits.length) { reply(t('edit_not_found')); break; }
    if (hits.length > 1) {                          // IDs are not enforced unique
      reply(t('edit_pick_match'), {
        inline_keyboard: hits.map(h => [{
          text: bookingLabel(h.json), callback_data: `epick_${h.row}`,
        }]),
      });
      setState('EDIT_PICK', d);
      break;
    }
    applyPick(hits[0]);
    break;
  }

  case 'EDIT_PICK': {
    const m = /^epick_(\d+)$/.exec(cbData || '');
    if (!m) break;
    const want = Number(m[1]);
    const hit = bookingRows().find(x => x.row === want);
    if (!hit) { reply(t('edit_not_found')); setState('EDIT_FIND', d); break; }
    applyPick(hit);
    break;
  }

  case 'EDIT_MENU': {
    if (cbData === 'ef_done') {
      if (!Object.keys(d.editNew || {}).length) {
        endSession(); reply(t('edit_no_changes')); break;
      }
      commitEdit(d);
      break;
    }
    if (cbData === 'ef_delete') {
      reply(t('del_confirm', { summary: bookingLabel(d.editOrig || {}) }), {
        inline_keyboard: [
          [{ text: t('btn_confirm'), callback_data: 'edel_yes' }],
          [{ text: t('btn_cancel'), callback_data: 'edel_no' }],
        ],
      });
      setState('EDIT_DEL_CONFIRM', d);
      break;
    }
    switch (cbData) {
      case 'ef_total':   reply(t('ask_total'));  setState('EDIT_TOTAL', d);   break;
      case 'ef_paid':
        reply(t('edit_ask_paid_add', { current: num(paidSoFar(d)) }));
        setState('EDIT_PAID', d);
        break;
      case 'ef_payment': reply(t('ask_payment'), grid(PAYMENTS, 'xpay_')); setState('EDIT_PAYMENT', d); break;
      case 'ef_nights':
        reply(t('ask_nights'), numKeyboard(1, 30, 'xnights_',
          [{ text: t('btn_infinity'), callback_data: 'xnights_inf' }], 5));
        setState('EDIT_NIGHTS', d);
        break;
      case 'ef_arrival': {
        const tp = todayParts();
        reply(t('ask_arrival'), calKeyboard(tp.y, tp.m));
        setState('EDIT_ARRIVAL', d);
        break;
      }
      case 'ef_aptroom': reply(t('ask_apt_room'), aptRoomKb()); setState('EDIT_APT_ROOM', d); break;
      case 'ef_notes':   reply(t('ask_notes'), skipKb('xnotes_skip')); setState('EDIT_NOTES', d); break;
      default: break;
    }
    break;
  }

  case 'EDIT_TOTAL': {
    if (cq) break;
    const v = parseNum(text);
    if (v === null || v < 0) { reply(t('num_error')); break; }
    editSet(d, 'اجمالي سعر الحجز', num(v));
    showEditMenu(d);
    break;
  }

  // Changing the paid amount always forces a payment method next — the money
  // moved somehow, and the sheet must say how.
  // The entered figure is an ADDITIONAL payment, not a replacement — the common
  // case is a guest settling the rest later. Added to whatever is already paid.
  case 'EDIT_PAID': {
    if (cq) break;
    const v = parseNum(text);
    if (v === null) { reply(t('num_error')); break; }
    // Negative is allowed — a refund, or undoing a mistyped payment. The total
    // may not go below zero though; that is always an error, not a credit.
    const current = paidSoFar(d);
    const total = current + v;
    if (total < 0) { reply(t('edit_paid_below_zero', { current: num(current) })); break; }
    d.paidAdded = num(v);               // for the cashier's group message
    d.paidTouched = true;               // admins get the checkout question after this
    editSet(d, 'اجمالي ما تم دفعه', num(total));
    reply(t('ask_payment'), grid(PAYMENTS, 'xpay_'));
    setState('EDIT_PAYMENT', d);
    break;
  }

  case 'EDIT_PAYMENT': {
    if (!cbData || !cbData.startsWith('xpay_')) break;
    const pay = PAYMENTS[Number(cbData.slice('xpay_'.length))];
    editSet(d, 'طريقة الدفع', pay);
    // Admins attach a receipt for the two transfer methods and may skip it. The
    // cashier is recording someone else's money, so anything that is not cash
    // needs proof, and there is no skip.
    const needsReceipt = d.paidOnly ? pay !== 'كاش' : RECEIPT_PAYMENTS.includes(pay);
    if (needsReceipt) {
      if (d.paidOnly) reply(t('paid_ask_receipt'));
      else reply(t('ask_receipt'), skipKb('xreceipt_skip'));
      setState('EDIT_RECEIPT', d);
      break;
    }
    afterEditStep(d);
    break;
  }

  case 'EDIT_RECEIPT':
    if (photoFileId) d.editReceipt = photoFileId;
    else if (cbData === 'xreceipt_skip' && !d.paidOnly) d.editReceipt = '';
    else if (d.paidOnly) { reply(t('paid_receipt_error')); break; }
    else { reply(t('receipt_error'), skipKb('xreceipt_skip')); break; }
    afterEditStep(d);
    break;

  // Asked once, right after a payment is recorded: has the guest gone? A "no"
  // goes straight to the review; a "yes" needs the date before the stay length
  // can be worked out.
  case 'EDIT_LEFT': {
    if (cbData !== 'xleft_yes' && cbData !== 'xleft_no') break;
    d.leaveAsked = true;
    if (cbData === 'xleft_no') { showEditConfirm(d); break; }
    const tp = todayParts();
    reply(t('edit_ask_departure'), calKeyboard(tp.y, tp.m));
    setState('EDIT_DEPARTURE', d);
    break;
  }

  case 'EDIT_DEPARTURE': {
    if (!cbData || cbData === 'cal_ignore') break;
    let m = /^cal_(prev|next)_(\d+)_(\d+)$/.exec(cbData);
    if (m) {
      const dir = m[1], y = Number(m[2]), mo = Number(m[3]);
      let ny = y, nm = mo;
      if (dir === 'prev') { nm = mo - 1; if (nm === 0) { nm = 12; ny = y - 1; } }
      else { nm = mo + 1; if (nm === 13) { nm = 1; ny = y + 1; } }
      if (ny < MIN_YEAR || (ny === MIN_YEAR && nm < MIN_MONTH)) break;
      reply(t('edit_ask_departure'), calKeyboard(ny, nm));
      setState('EDIT_DEPARTURE', d);
      break;
    }
    m = /^cal_day_(\d+)_(\d+)_(\d+)$/.exec(cbData);
    if (!m) break;
    const departure = `${m[1]}-${m[2]}-${m[3]}`;
    const arrival = String((d.editOrig || {})['تاريخ البداية'] || '').trim();
    const nights = daysBetween(arrival, departure);
    // A checkout before check-in is a mis-tap, not a zero-night stay. Same-day is
    // allowed: the =TODAY()-J formula reads 0 on the arrival date too.
    if (nights === null || nights < 0) {
      const tp = todayParts();
      reply(t('edit_departure_before_arrival', { departure, arrival: arrival || t('empty') }),
        calKeyboard(tp.y, tp.m));
      break;
    }
    d.departure = departure;
    // Only عدد الليالي is written. تاريخ المغادرة is the sheet's own J + I formula,
    // so it lands on the right date by itself — writing it would destroy it.
    editSet(d, 'عدد الليالي', nights);
    showEditConfirm(d);
    break;
  }

  case 'EDIT_CONFIRM': {
    if (cbData === 'xecancel') { endSession(); reply(t('cancelled')); break; }
    if (cbData !== 'xedone') break;
    if (!Object.keys(d.editNew || {}).length) {
      endSession(); reply(t('edit_no_changes')); break;
    }
    commitEdit(d);
    break;
  }

  case 'EDIT_NIGHTS': {
    if (cbData && cbData.startsWith('xnights_')) {
      const suffix = cbData.slice('xnights_'.length);
      // The row is already known, so the open-ended formula can be written out
      // directly instead of carrying a {r} placeholder.
      editSet(d, 'عدد الليالي',
        suffix === 'inf' ? `=TODAY()-J${d.editRow}` : Number(suffix));
      showEditMenu(d);
      break;
    }
    if (cq) break;
    const v = parseNum(text);
    if (v === null || v <= 0) { reply(t('num_error')); break; }
    editSet(d, 'عدد الليالي', Math.trunc(v));
    showEditMenu(d);
    break;
  }

  case 'EDIT_ARRIVAL': {
    if (!cbData || cbData === 'cal_ignore') break;
    let m = /^cal_(prev|next)_(\d+)_(\d+)$/.exec(cbData);
    if (m) {
      const dir = m[1], y = Number(m[2]), mo = Number(m[3]);
      let ny = y, nm = mo;
      if (dir === 'prev') { nm = mo - 1; if (nm === 0) { nm = 12; ny = y - 1; } }
      else { nm = mo + 1; if (nm === 13) { nm = 1; ny = y + 1; } }
      if (ny < MIN_YEAR || (ny === MIN_YEAR && nm < MIN_MONTH)) break;
      reply(t('ask_arrival'), calKeyboard(ny, nm));
      setState('EDIT_ARRIVAL', d);
      break;
    }
    m = /^cal_day_(\d+)_(\d+)_(\d+)$/.exec(cbData);
    if (m) {
      editSet(d, 'تاريخ البداية', `${m[1]}-${m[2]}-${m[3]}`);
      showEditMenu(d);
    }
    break;
  }

  case 'EDIT_APT_ROOM': {
    if (cbData === 'ar_hdr') break;
    const m = /^ar_(\d+)_(\d+)$/.exec(cbData || '');
    if (!m) break;
    editSet(d, 'اسم الشقة', APARTMENTS[Number(m[1])]);
    editSet(d, 'رقم الغرفة', Number(m[2]));
    showEditMenu(d);
    break;
  }

  case 'EDIT_NOTES':
    editSet(d, 'ملاحظات', cbData === 'xnotes_skip' ? '' : (text || '').trim());
    showEditMenu(d);
    break;

  case 'EDIT_DEL_CONFIRM': {
    if (cbData === 'edel_no') { showEditMenu(d); break; }
    if (cbData !== 'edel_yes') break;
    const orig = d.editOrig || {};
    // Append rather than clobber, so an existing note is not lost.
    const prevNote = String(orig['ملاحظات'] || '').trim();
    out.hasSave = true;
    out.save = {
      flow: 'cancel',
      row: d.editRow,
      fields: { 'ملاحظات': prevNote ? `${prevNote} ${t('del_note')}` : t('del_note') },
      formatRow: true,                  // black fill / white text, via HTTP
      receiptFileId: '',
      groupChatId: CFG.GROUP_CHAT_ID,
      groupText: t('del_group_msg', {
        name: mdEscape(orig['اسم المقيم'] || t('empty')),
        private_id: mdEscape(orig['ID'] || t('empty')),
        apartment: mdEscape(orig['اسم الشقة'] || t('empty')),
        room: mdEscape(orig['رقم الغرفة'] || t('empty')),
        arrival: mdEscape(orig['تاريخ البداية'] || t('empty')),
        actor,
      }),
      savedText: t('del_saved'),
      savedNoGroupText: t('del_saved_no_group'),
      errorText: t('error'),
    };
    break;
  }
}

// On a save the session is deliberately kept until the write succeeds, so a
// failed write leaves the user on CONFIRM and the Save button still works.
return [{ json: out }];
