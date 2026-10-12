/**
 * Bookings receptionist bot — full conversation state machine.
 *
 * This is the source-of-truth copy of the JS that lives inside the "Brain"
 * Code node of n8n/bookings-bot.workflow.json. Edit here, then paste into the
 * node — `push_brain.py --publish` pushes this file to the live Brain, and
 * `build_workflow.py` bakes it into the committed workflow JSON.
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
    : '1430533008,5213695300'
);

const TZ = CFG.TIMEZONE || 'Africa/Cairo';

// ─── Option lists (indexes are baked into callback_data — never reorder) ──────

// callback_data carries a STABLE KEY, never a list position. The old `pay_0`
// form meant "whatever is 3rd in the array today", so reordering a list silently
// changed what an in-flight tap saved. Keys are bound to a value for good; the
// display order above them is free to change.
const BTYPE_OPTS = [
  { key: 'external', label: 'خارجي' },
  { key: 'booking', label: 'بوكينج' },
];

const PAYMENTS = [
  { key: 'cash', label: 'كاش' },
  { key: 'instapay', label: 'انستاباي' },
  { key: 'airbnb', label: 'Airbnb' },
  { key: 'vcash', label: 'فودافون كاش' },
  { key: 'unpaid', label: 'غير مدفوع' },
  { key: 'eur', label: 'يورو' },
  { key: 'usd', label: 'دولار' },
];

const EXP_PAYMENTS = ['cash', 'instapay', 'vcash'];

/** Payment methods that produce a transfer receipt worth attaching. */
const RECEIPT_PAYMENT_KEYS = ['instapay', 'vcash'];

const CASH_KEY = 'cash';
const UNPAID_KEY = 'unpaid';

/** The label غير مدفوع, read off PAYMENTS so the two can never drift apart. */
const UNPAID_LABEL = (PAYMENTS.find(p => p.key === UNPAID_KEY) || {}).label || 'غير مدفوع';

/**
 * The methods a payment can actually arrive by. غير مدفوع is the absence of a
 * payment, so offering it after an amount was typed let "500 غير مدفوع" open a
 * line that said unpaid while holding 500 (ruled out 2026-10-10).
 */
const PAY_METHODS = PAYMENTS.filter(p => p.key !== UNPAID_KEY);

/**
 * Foreign currencies. An amount paid in يورو or دولار is in THAT currency — 100
 * means €100, not 100 EGP — so it is never added to the pounds the price is
 * set in, never subtracted from المتبقي, and always kept on a line of its own.
 */
const FOREIGN_KEYS = ['eur', 'usd'];
const FOREIGN_LABELS = PAYMENTS.filter(p => FOREIGN_KEYS.indexOf(p.key) !== -1).map(p => p.label);
function isForeign(method) { return FOREIGN_LABELS.indexOf(String(method || '').trim()) !== -1; }

/**
 * Does this طريقة الدفع cell name a way money actually changed hands?
 *
 * غير مدفوع does not. It is the absence of a payment written into the column
 * that names payments, so every rule that asks "has this booking been paid in a
 * method already?" has to read it as a blank — otherwise the first real payment
 * looks like a SECOND method and opens a line under a row that says nothing was
 * paid. Mirrored by `has_method` in `supabase/mirror.py` and `hasMethod` in
 * `webui/lib/mirror.js`; the three must agree.
 */
function hasMethod(m) {
  const v = String(m === undefined || m === null ? '' : m).trim();
  return Boolean(v) && v !== UNPAID_LABEL;
}

/**
 * The same, for EXPENSES, where cash is included.
 *
 * A transfer keeps its own receipt in the banking app, which is why the list
 * above is what it is. Cash spent on the business does not: what exists is a
 * paper invoice from the shop, and a photo of it is the only evidence the money
 * left the till and what it bought. That is worth more here than for a booking,
 * where cash comes IN across the desk and the sheet's own row is the record.
 *
 * Bookings and payments deliberately keep the narrower list.
 */
const EXPENSE_RECEIPT_PAYMENT_KEYS = RECEIPT_PAYMENT_KEYS.concat([CASH_KEY]);

/**
 * Resolve a payment from callback data.
 *
 * Accepts the old positional form (`pay_3`) as well as the current key form
 * (`pay_vcash`). A keyboard drawn before this code deployed is still on
 * someone's screen; without this, their next tap does nothing and they have to
 * start the booking again. The order below is the order those old keyboards
 * were drawn in — do not rewrite it to match a future PAYMENTS reordering.
 */
const LEGACY_PAY_ORDER = ['cash', 'instapay', 'airbnb', 'vcash', 'unpaid', 'eur', 'usd'];

function payByKey(key) {
  const direct = PAYMENTS.find(p => p.key === key);
  if (direct) return direct;
  if (/^\d+$/.test(String(key))) {
    const legacy = LEGACY_PAY_ORDER[Number(key)];
    return legacy ? PAYMENTS.find(p => p.key === legacy) || null : null;
  }
  return null;
}

function payLabel(key) { const p = payByKey(key); return p ? p.label : ''; }

/** The canonical key for a payment, whichever form the callback used. */
function payKeyOf(key) { const p = payByKey(key); return p ? p.key : ''; }

/**
 * Apartments and their rooms come from the الإتاحة tab (one row per
 * apartment+room), so opening a property or changing a room count is a sheet
 * edit rather than a deploy. This list is only the fallback for a failed read —
 * a Sheets hiccup must not stop the bot taking a booking. Room counts here match
 * الإتاحة as of 2026-08-08; the old code offered 5 rooms everywhere, which
 * invented a room 5 in four of the six apartments.
 */
const FALLBACK_REGISTRY = [
  { apartment: 'ذاكر حسين', rooms: ['1', '2', '3', '4', '5'] },
  { apartment: 'احمد فهيم', rooms: ['1', '2', '3', '4', '5'] },
  { apartment: 'انبي 3', rooms: ['1', '2', '3', '4'] },
  { apartment: 'انبي 2', rooms: ['1', '2', '3', '4'] },
  { apartment: 'ابو حديد 11', rooms: ['1', '2', '3', '4'] },
  { apartment: 'عبدالله العربي', rooms: ['1', '2', '3', '4'] },
];

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
  exp_ask_id_suggest:
    '🔢 رقم المصروف: المقترح {n}\nاضغط ✅ للتأكيد، أو اكتب رقماً آخر، أو اضغط تخطي:',
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
  exp_saved: '✅ تم حفظ المصروف.',
  exp_saved_no_group:
    '✅ تم حفظ المصروف.\n⚠️ تعذّر الإرسال للجروب (تأكد من إضافة البوت).',

  ask_booking_id: '🔖 أدخل رقم البوكينج (إن وجد) أو اضغط تخطي:',
  btn_skip: 'تخطي',
  ask_private_id: '🆔 أدخل الـ ID:',
  ask_private_id_suggest:
    '🆔 الـ ID: المقترح {n}\nاضغط ✅ للتأكيد، أو اكتب رقماً آخر، أو اضغط تخطي:',
  btn_ok_ref: '✅ {n}',
  ask_name: '👤 اسم المقيم:',
  name_error: '❌ الاسم مطلوب. اكتب اسم المقيم:',
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
  // An open-ended stay has no total to ask for. Asking for one produces a
  // number somebody made up, and the sheet then grew hand-typed `=500*I10`
  // formulas to express what was meant — six of them, before this existed.
  ask_rate: '💰 سعر الليلة (الحجز مفتوح، الاجمالي يُحسب تلقائياً):',
  rate_per_night: '{rate} / ليلة',
  running_total: 'يُحسب تلقائياً',
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
    '💵 أدخل المبلغ المضاف:\n{status}\n' +
    '↩️ للاسترداد أو تصحيح خطأ أدخل رقماً سالباً، مثل ‎-500',
  total_formula_replaced:
    '⚠️ السعر كان معادلة (سعر الليلة × عدد الليالي) وأصبح رقماً ثابتاً — '
    + 'لن يتحدّث تلقائياً بعد الآن.',
  ask_total_formula:
    '⚠️ هذا الحجز سعره معادلة في الشيت (سعر الليلة × عدد الليالي)، '
    + 'ويتحدّث تلقائياً كلما طالت الإقامة.\n'
    + 'إدخال رقم ثابت سيلغي المعادلة ويثبّت السعر عند هذا الرقم.\n\n'
    + '💰 أدخل اجمالي سعر الحجز، أو /cancel للتراجع:',
  // A confirmation card waits for a button, and a text message there used to be
  // swallowed in silence — see waitingForButton().
  use_buttons:
    '👆 استخدم الأزرار في رسالة المراجعة أعلاه للحفظ أو الإلغاء.\n'
    + 'لو الرسالة اختفت من الشاشة، أرسل /cancel ثم /start للبدء من جديد.',
  edit_paid_below_zero: '❌ المدفوع لا يمكن أن يقل عن صفر. المدفوع حالياً: {current}',
  // The same rule, one turn later, for the row the money really lands on — see
  // the note beside lineTotal in EDIT_PAYMENT.
  line_paid_below_zero:
    '❌ لا يمكن استرداد أكثر مما دُفع بطريقة «{method}». '
    + 'المدفوع بهذه الطريقة حالياً: {current}',
  // Deliberately asks for a human instead of retrying: the bot cannot tell
  // "the row was inserted and only the write failed" from "nothing ran", and
  // guessing wrong adds a second row that shifts every row beneath it.
  line_retry_blocked: '⚠️ تمت محاولة حفظ هذه الدفعة بالفعل، وقد يكون السطر '
    + '{row} أُضيف في الشيت.\n\nراجع الشيت أولاً:\n'
    + '• إن كان السطر موجوداً وبياناته صحيحة، فالدفعة محفوظة.\n'
    + '• إن كان ناقصاً أو فارغاً، أكمله يدوياً أو احذفه ثم أعد المحاولة.\n\n'
    + 'أرسل /cancel لإنهاء هذه العملية.',
  edit_ask_id: '🔎 أدخل الـ ID:',
  edit_not_found: '❌ لا يوجد حجز بهذا الـ ID. حاول مجدداً أو أرسل /cancel:',
  edit_pick_match: '🔎 أكثر من حجز بنفس الرقم — اختر الحجز:',
  edit_menu: '✏️ اختر ما تريد تعديله:',
  btn_edit_total: '💰 اجمالي سعر الحجز',
  // The button says what the step DOES. It never set a total — it always asked
  // for an amount to add and summed it with what was already paid — and calling
  // it "اجمالي ما تم دفعه" invited people to type the new total, which would be
  // counted on top of the old one.
  btn_edit_paid: '💵 إضافة دفعة',
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
  edit_saved: '✅ تم حفظ التعديلات.',
  edit_saved_no_group: '✅ تم حفظ التعديلات.\n⚠️ تعذّر الإرسال للجروب.',
  edit_group_msg:
    '✏️ *تعديل حجز*\n\n' +
    '👤 المقيم: {name}\n' +
    '🆔 ID: {private_id}\n\n' +
    '{changes}\n\n' +
    '👤 بواسطة: {actor}',
  del_confirm: '⚠️ تأكيد إلغاء الحجز التالي؟\n\n{summary}',
  del_saved: '✅ تم إلغاء الحجز.',
  del_saved_no_group: '✅ تم إلغاء الحجز.\n⚠️ تعذّر الإرسال للجروب.',
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
  // ── On demand: the morning availability report, now ──
  btn_availability: '🏠 تقرير الإتاحة',
  avail_sent: '🏠 جاري إرسال تقرير الإتاحة إلى الجروب.',
  // ── AI edit: one free-text request, reviewed before anything is written ──
  btn_ai_edit: '🤖 تعديل بالذكاء الاصطناعي',
  ai_ask:
    '🤖 اكتب التعديل المطلوب، مثل:\n' +
    '• حجز 3 دفع 400 كاش\n' +
    '• حجز 12 غرفة 3 وزود ليلتين\n' +
    '• حجز 7 غادر النهاردة\n\n' +
    'أو أرسل /cancel للتراجع:',
  ai_unavailable:
    '⚠️ الذكاء الاصطناعي غير متاح الآن. حاول مرة أخرى، أو استخدم ✏️ تعديل حجز من /start.',
  ai_not_understood:
    '❓ لم أفهم الطلب.{reason}\nاكتبه مرة أخرى بالـ ID وما تريد تغييره، أو أرسل /cancel:',
  ai_bad_amount: '❌ المبلغ غير واضح. اكتب الطلب مرة أخرى:',
  ai_bad_date: '❌ التاريخ غير واضح. اكتب الطلب مرة أخرى:',
  ai_departure_before:
    '❌ المغادرة ({departure}) قبل تاريخ البداية ({arrival}). اكتب الطلب مرة أخرى:',
  ai_open_ended:
    '❌ هذه إقامة مفتوحة (بدون عدد ليالٍ ثابت) فلا يمكن تمديدها. اذكر تاريخ المغادرة، '
    + 'أو عدّل عدد الليالي من ✏️ تعديل حجز.',
  ai_nights_unknown:
    '❌ عدد الليالي الحالي غير مسجّل لهذا الحجز فلا يمكن حساب التمديد. '
    + 'اذكر تاريخ المغادرة بدلاً من ذلك:',
  ai_no_arrival:
    '❌ تاريخ بداية هذا الحجز غير صالح في الشيت، فلا يمكن حساب الإقامة. عدّله من ✏️ تعديل حجز.',
  ai_room_unknown:
    '🏠 لم أتعرف على هذه الشقة أو الغرفة. الشقق المتاحة: {list}\nاكتب الطلب مرة أخرى:',
  ai_echo: '🤖 فهمت: «{request}»',
  paid_ask_id: '🔎 أدخل الـ ID الخاص بالحجز:',
  paid_ask_amount: '💵 أدخل المبلغ المدفوع:\n{status}',
  // What the booking has been paid across ALL its rows, not just its own one —
  // a guest with 500 كاش on the row and 300 انستاباي on a line has paid 800.
  pay_status_paid: '💵 المدفوع حالياً: {paid}',
  pay_status_of: '💵 المدفوع حالياً: {paid} من {price}\n📉 المتبقي: {remaining}',
  pay_status_foreign: '💱 مدفوع {amount} {currency} (لا يُحسب من المتبقي)',
  paid_zero_error: '❌ المبلغ لا يمكن أن يكون صفراً. أدخل المبلغ:',
  paid_refund_admin_only:
    '❌ الاسترداد (مبلغ بالسالب) للمسؤول فقط. أدخل مبلغاً أكبر من صفر:',
  paid_ask_receipt: '📎 أرسل صورة إيصال التحويل (صورة أو ملف):',
  paid_receipt_error: '❌ لا بد من إرسال صورة الإيصال (صورة أو ملف):',
  paid_confirm:
    '🧾 *راجع الدفعة قبل الحفظ*\n\n' +
    '👤 المقيم: {name}\n' +
    '🆔 ID: {private_id}\n' +
    '🏠 الشقة: {apartment}\n' +
    '➕ المبلغ: {added}\n' +
    '💳 الدفع: {method}\n' +
    '📎 الإيصال: {receipt}\n\n' +
    '{status}',
  overpay_warning:
    '⚠️ المدفوع بعد هذه الدفعة ({paid}) أكبر من سعر الحجز ({price}) بـ {over}. '
    + 'تأكد من المبلغ قبل الحفظ.',
  paid_saved: '✅ تم تسجيل الدفعة.',
  paid_saved_no_group: '✅ تم تسجيل الدفعة.\n⚠️ تعذّر الإرسال للجروب.',
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
  // Said only when the payment opened or grew a line of its own, so the group
  // is not surprised by a second row appearing under the booking.
  paid_new_line: '📄 سطر منفصل بطريقة الدفع: {method}',
  // The same fact on the review screen, before anything is written.
  edit_line_review: '➕ دفعة {added} بطريقة {method} — سطر منفصل (إجمالي السطر: {total})',
  // An admin can add a payment and change other things in the same session.
  // The payment leads, because that is the part the group is watching for, and
  // whatever else moved is listed underneath rather than lost.
  payment_other_changes: '✏️ تعديلات أخرى:\n{changes}',
  conflict_warning:
    '⚠️ *تعارض في الحجز* — {room} محجوزة في نفس الفترة ({count}):\n{list}',
  // Two lines per clash on purpose. The first says who is in the room and for
  // how long; the second says exactly which nights are contested, which is the
  // number the receptionist is actually deciding on.
  conflict_line:
    '• {name}{id_part}\n' +
    '   🛏️ {arrival} ← {departure}\n' +
    '   🔻 التداخل: {overlap_from} ← {overlap_to}{nights_part}',
  conflict_id_part: ' — ID {private_id}',
  conflict_nights_part: ' ({nights} ليلة)',
  // Not the same thing as a conflict. A conflict is two guests in one room; this
  // is the SAME guest, room and date already on the sheet — almost always the
  // same booking entered twice. On 2026-08-15 that happened 45 minutes apart and
  // produced bookings 1015 and 1019, identical down to the 1,420 كاش payment.
  dup_warning:
    '⚠️ *حجز مشابه موجود بالفعل* ({count}):\n{list}\n' +
    'لو ده نفس الحجز، اضغط إلغاء.',
  dup_line: '• صف {row} — {name}{id_part}\n   🛏️ {arrival} — {apartment} / {room}',
  btn_confirm_dup: '⚠️ احفظ حجز جديد رغم التشابه',
  btn_confirm_anyway: '⚠️ احفظ رغم التعارض',
  btn_confirm: '✅ حفظ',
  btn_cancel: '❌ إلغاء',
  saved: '✅ تم حفظ الحجز.',
  saved_no_group:
    '✅ تم حفظ الحجز.\n⚠️ تعذّر الإرسال للجروب (تأكد من إضافة البوت للجروب).',
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

/** The suggested number as its own button, above the usual skip. */
function suggestKb(n, okData, skipData) {
  return { inline_keyboard: [
    [{ text: t('btn_ok_ref', { n }), callback_data: okData }],
    [{ text: t('btn_skip'), callback_data: skipData }],
  ] };
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

/** A grid over [{ key, label }] options, keyed rather than positional. */
function keyGrid(options, prefix, perRow) {
  perRow = perRow || 2;
  const rows = [];
  for (let i = 0; i < options.length; i += perRow) {
    rows.push(options.slice(i, i + perRow).map(o => ({
      text: o.label, callback_data: `${prefix}${o.key}`,
    })));
  }
  return { inline_keyboard: rows };
}

/**
 * Apartment + room grid over the registry loaded this turn.
 *
 * The callback carries a position into `reg` and `reg` is written to the session
 * alongside it, so the tap is resolved against exactly the list that was shown.
 * A sheet edit between the keyboard being drawn and the button being pressed
 * cannot shift the meaning — which is the whole failure mode a global index has.
 */
function aptRoomKb(reg) {
  const rows = [];
  reg.forEach((entry, i) => {
    rows.push([{ text: `🏠 ${entry.apartment}`, callback_data: 'ar_hdr' }]);
    rows.push(entry.rooms.map(room => ({
      text: String(room), callback_data: `ar_${i}_${room}`,
    })));
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

/**
 * Arabic-Indic and Persian digits, rewritten as ASCII.
 *
 * The keyboard these receptionists type on produces ٢٥, not 25, and everything
 * downstream — parseFloat, the ID comparison, the sheet — speaks ASCII only.
 * Observed live on 2026-08-09: an admin looked up "٢٥", guest 25 exists on row
 * 45, and the bot said "لا يوجد حجز بهذا الـ ID". The same typo class silently
 * re-prompts on any amount entered in Arabic digits.
 */
function asciiDigits(s) {
  return String(s === undefined || s === null ? '' : s).replace(
    /[٠-٩۰-۹]/g,
    ch => String(ch.charCodeAt(0) & 0x0f),
  );
}

function parseNum(text) {
  const v = parseFloat(asciiDigits(text).trim().replace(/,/g, ''));
  return Number.isNaN(v) ? null : v;
}

/** Drop trailing .0 for whole numbers so the sheet stays clean. */
function num(v) {
  const f = Number(v);
  return Number.isInteger(f) ? f : Math.round(f * 100) / 100;
}

/** Force text storage (preserve leading zeros in phones/IDs) via Sheets' ' marker. */
function txt(v) { return v ? `'${v}` : v; }

/**
 * An ID or a number column as the sheet should hold it. The ' marker txt()
 * adds was showing in the cell editor as part of the ID ("the id was input
 * with ' with it", 2026-10-01), and stored a counter as text. So a plain
 * counter goes in as a number, and anything else as typed — except what the
 * sheet would reinterpret (the write is USER_ENTERED): a leading zero it would
 * drop, `1/5` it would turn into a date, `1E5` into a number, `+20…` or `=…`
 * into a formula. Those still get the marker.
 */
function idCell(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return '';
  if (/^[1-9][0-9]{0,14}$/.test(s)) return Number(s);
  if (/^[=+\-@]/.test(s) || /^[0-9\s.,\/:\-]+$/.test(s)
      || /^[0-9.]+e[+\-]?[0-9]+$/i.test(s)) return txt(s);
  return s;
}

/**
 * The guest's name, as typed. Anything is a name.
 *
 * This used to demand letters and spaces only, three characters minimum, and it
 * was wrong on every count. Real guests are entered as "احمد ٢", "J.R.", "Ali
 * (booking.com)", "Bo" — Arabic-Indic digits, punctuation, room numbers,
 * two-letter names — and every one of them was refused with a message about
 * letters and spaces while somebody stood at the desk waiting.
 *
 * The one thing still refused is nothing at all. اسم المقيم is column C, which
 * is the key column: it is what tells a read which rows are occupied, precisely
 * because it never holds a formula. A row saved with an empty name is a row the
 * sheet cannot see, and the next booking is written on top of it — the same
 * failure that put an expense over a hand-typed row on 2026-08-14.
 */
function validateName(text) {
  const cleaned = String(text).trim();
  if (!cleaned) return null;
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

// A receipt can also arrive as a FILE: a screenshot sent uncompressed, or the
// PDF a banking app exports. Only images and PDFs count, and only the payment
// receipt step takes them — see the check after the session is loaded.
const doc = (!cq && upd.message && upd.message.document) ? upd.message.document : null;
const docFileId = doc && /^(image\/|application\/pdf$)/.test(String(doc.mime_type || ''))
  ? doc.file_id : null;

if (!cq && !upd.message.text && !photoFileId && !docFileId) return [];   // stickers etc → ignore

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

// A file with no text is a receipt or it is nothing. Anywhere but the payment
// receipt step it would arrive as an empty message, and a state that takes free
// text (notes, a name) would accept "" as the answer — so it is dropped there
// exactly as it was before files were accepted at all.
if (docFileId && !photoFileId && !upd.message.text && state !== 'EDIT_RECEIPT') return [];

// "Read Bookings For Edit" only runs on the turns that need it, so on every
// other turn the node is unexecuted and referencing it throws. That is the
// point — the lookup costs a Sheets call only when it is actually used.
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

/**
 * Apartments and rooms as the الإتاحة tab has them: one row per apartment+room
 * in columns A and B, which is exactly the registry this bot needs. Same gated
 * pattern as bookingRows — unexecuted on turns that draw no apartment keyboard.
 *
 * Falls back to the baked-in list rather than returning nothing: an empty grid
 * would leave a receptionist unable to finish a booking over a transient read.
 */
function locationRegistry() {
  let rows = [];
  try {
    rows = $('Read Locations').all().map(i => i.json);
  } catch (e) {
    return FALLBACK_REGISTRY;
  }
  const byApartment = [];
  const seen = {};
  for (const rowJson of rows) {
    // The read starts at the tab's header row, so the columns normally arrive
    // named. Fall back to position if that header is ever edited — the grid
    // must not empty itself over a renamed column.
    let apartment = rowJson['الشقة'];
    let room = rowJson['الغرفة'];
    if (apartment === undefined || room === undefined) {
      const vals = Object.keys(rowJson).filter(k => k !== 'row_number').map(k => rowJson[k]);
      apartment = vals[0];
      room = vals[1];
    }
    apartment = String(apartment === undefined ? '' : apartment).trim();
    room = String(room === undefined ? '' : room).trim();
    if (!apartment || !room) continue;
    if (seen[apartment] === undefined) {
      seen[apartment] = byApartment.length;
      byApartment.push({ apartment, rooms: [] });
    }
    const entry = byApartment[seen[apartment]];
    if (entry.rooms.indexOf(room) === -1) entry.rooms.push(room);
  }
  return byApartment.length ? byApartment : FALLBACK_REGISTRY;
}

/**
 * The ID offered for a new booking: one past the previous one, from the
 * database (read_next_booking_id.sql). Gated like the reads above — it runs
 * only on the turn that asks for the ID — so anywhere else, or if the query
 * failed, this is null and the question goes out as it always did.
 */
function nextBookingId() {
  try {
    const n = Number($('Read Next Booking ID').first().json.next_booking_id);
    return Number.isInteger(n) && n > 0 ? String(n) : null;
  } catch (e) {
    return null;
  }
}

/**
 * The number offered for a new expense: one past the highest in the expense
 * tab's الرقم column. From the sheet, not the database, because the expense
 * numbering restarts with the tab ("Restart at 1 with the sheet", 2026-10-01),
 * so an empty tab offers 1. A failed read offers nothing rather than a 1 that
 * would collide with the rows it could not see.
 */
function nextExpenseNumber() {
  let items;
  try {
    items = $('Read Expense Numbers').all();
  } catch (e) {
    return null;
  }
  let max = 0;
  for (const i of items) {
    const j = i.json || {};
    if (j.error) return null;
    const v = asciiDigits(String(j['الرقم'] === undefined ? '' : j['الرقم']))
      .replace(/^'/, '').trim();
    if (/^[0-9]{1,6}$/.test(v)) max = Math.max(max, Number(v));
  }
  return String(max + 1);
}

/**
 * Bookings that clash with a stay: same apartment, same room, overlapping dates.
 *
 * Cancelled rows are ignored, and a stay whose nights cell is a live formula is
 * open-ended, so it runs to infinity and clashes with anything after its start.
 * Half-open ranges — a departure and an arrival on the same day do not overlap,
 * because that is a normal same-day turnover.
 */
/** A cell the sheet stores text-forced with a leading apostrophe, as read. */
function plainId(v) {
  return v === undefined || v === null ? '' : String(v).replace(/^'/, '').trim();
}

function findConflicts(apartment, room, arrival, nights, isOpen, skipRow) {
  const startA = arrival;
  const endA = isOpen ? null : isoAddDays(arrival, nights);
  const hits = [];
  for (const x of bookingRows()) {
    const j = x.json;
    if (skipRow && x.row === skipRow) continue;
    if (String(j['اسم الشقة'] || '').trim() !== String(apartment).trim()) continue;
    if (String(j['رقم الغرفة'] || '').trim() !== String(room).trim()) continue;
    if (String(j['ملاحظات'] || '').indexOf(t('del_note')) !== -1) continue;
    const startB = String(j['تاريخ البداية'] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startB)) continue;
    const rawNights = j['عدد الليالي'];
    const openB = String(rawNights === undefined ? '' : rawNights).trim().startsWith('=');
    const nB = parseNum(rawNights);
    const endB = openB || nB === null ? null : isoAddDays(startB, Math.trunc(nB));
    // [startA, endA) ∩ [startB, endB) ≠ ∅, with null standing in for +∞.
    const startsBeforeOtherEnds = endB === null || startA < endB;
    const otherStartsBeforeThisEnds = endA === null || startB < endA;
    if (startsBeforeOtherEnds && otherStartsBeforeThisEnds) {
      // The overlapping stretch itself, not just the other stay's dates. A
      // receptionist deciding whether to put someone in an occupied room needs
      // to know it is one night, not eleven — and the two stays' own dates make
      // them work that out in their head while a guest waits.
      const overlapFrom = startB > startA ? startB : startA;
      let overlapTo = null;                       // null = both run open-ended
      if (endA !== null && endB !== null) overlapTo = endA < endB ? endA : endB;
      else if (endA !== null) overlapTo = endA;
      else if (endB !== null) overlapTo = endB;
      hits.push({
        name: j['اسم المقيم'] || t('empty'),
        privateId: plainId(j['ID']),
        phone: plainId(j['رقم الهاتف']),
        arrival: startB,
        departure: endB === null ? t('infinity_label') : endB,
        overlapFrom,
        overlapTo: overlapTo === null ? t('infinity_label') : overlapTo,
        overlapNights: overlapTo === null ? null : daysBetween(overlapFrom, overlapTo),
      });
    }
  }
  // Soonest first: the stay about to end is the one most likely to make the
  // clash acceptable.
  hits.sort((a, b) => (a.arrival < b.arrival ? -1 : a.arrival > b.arrival ? 1 : 0));
  return hits;
}

/** Names compare as people read them: collapsed spaces, no case, no tatweel. */
function sameName(a, b) {
  const norm = (s) => String(s || '')
    .replace(/ـ/g, '')            // ـ, which changes nothing but the width
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const na = norm(a);
  return na !== '' && na === norm(b);
}

/**
 * Rows that look like THIS booking already being on the sheet.
 *
 * Same guest, same apartment, same room, same arrival. `saveLocked` cannot see
 * these: it swallows a second tap inside one session for a minute, and the two
 * saves of ابو الحسن on 2026-08-15 were 45 minutes and two sessions apart. The
 * sheet is the only thing that remembers across both.
 *
 * A warning, never a block — the same rule findConflicts follows. Two guests
 * really can share a name, and a receptionist standing in front of one knows
 * things the sheet does not. It does make them say so.
 */
function findDuplicates(guest, apartment, room, arrival, skipRow) {
  const hits = [];
  for (const x of bookingRows()) {
    const j = x.json;
    if (skipRow && x.row === skipRow) continue;
    if (String(j['ملاحظات'] || '').indexOf(t('del_note')) !== -1) continue;
    if (!sameName(j['اسم المقيم'], guest)) continue;
    if (String(j['اسم الشقة'] || '').trim() !== String(apartment).trim()) continue;
    if (String(j['رقم الغرفة'] || '').trim() !== String(room).trim()) continue;
    if (String(j['تاريخ البداية'] || '').trim() !== String(arrival).trim()) continue;
    hits.push({
      row: x.row,
      name: j['اسم المقيم'] || t('empty'),
      privateId: plainId(j['ID']),
      apartment: j['اسم الشقة'] || t('empty'),
      room: j['رقم الغرفة'] || t('empty'),
      arrival: String(j['تاريخ البداية'] || '').trim(),
    });
  }
  return hits;
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
  // Fires the availability chain ("Wants Availability?" in the workflow).
  hasAvailability: false,
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
  const nightsDisp = dd.infinity ? t('infinity_label') : String(dd.nights);
  const departure = dd.infinity ? t('infinity_label') : isoAddDays(dd.arrival_date, dd.nights);
  // An open-ended stay has no total yet — it is a rate, and the bill is however
  // many nights it turns out to be. Showing a scalar here would be inventing a
  // checkout date nobody has agreed to, so the summary shows the rate and says
  // the total is still running.
  if (dd.infinity) {
    return {
      remaining: t('running_total'),
      nights_disp: nightsDisp,
      departure,
      total_disp: t('rate_per_night', { rate: num(dd.nightly_rate) }),
    };
  }
  return {
    remaining: num(dd.total - dd.paid),
    nights_disp: nightsDisp,
    departure,
    total_disp: num(dd.total),
  };
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
    total: dv.total_disp, paid: num(dd.paid), remaining: dv.remaining,
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

function askPhone() { reply(t('ask_phone'), skipKb('phone_skip')); setState('PHONE', d); }
function askArrival() {
  const tp = todayParts();
  d.cal_year = tp.y; d.cal_month = tp.m;
  reply(t('ask_arrival'), calKeyboard(tp.y, tp.m));
  setState('ARRIVAL', d);
}
/** The clash warning, as Markdown: who is in the room, and for which nights. */
function conflictBlock(apartment, room, clashes) {
  return t('conflict_warning', {
    room: `${mdEscape(apartment)} — ${mdEscape(String(room))}`,
    count: clashes.length,
    list: clashes
      .map(c => t('conflict_line', {
        name: mdEscape(c.name),
        id_part: c.privateId ? t('conflict_id_part', { private_id: mdEscape(c.privateId) }) : '',
        arrival: c.arrival,
        departure: c.departure,
        overlap_from: c.overlapFrom,
        overlap_to: c.overlapTo,
        nights_part: c.overlapNights ? t('conflict_nights_part', { nights: c.overlapNights }) : '',
      }))
      .join('\n'),
  });
}

function showConfirm() {
  const dv = derived(d);
  // The one turn where the room is known along with the dates, so it is the only
  // place a clash can be caught before the row is written.
  const clashes = findConflicts(d.apartment, d.room, d.arrival_date, d.nights, d.infinity);
  d.conflict = clashes.length > 0;
  let body = t('confirm_summary', summaryVars(d, dv));
  if (d.conflict) body += '\n\n' + conflictBlock(d.apartment, d.room, clashes);
  // Shown on the turn that draws the confirmation, because that is the turn the
  // booking rows are already loaded for — the availability check needs them, so
  // this costs no extra query. It is also the right moment: before the save, not
  // after it.
  const dups = findDuplicates(d.name, d.apartment, d.room, d.arrival_date);
  d.duplicate = dups.length > 0;
  if (d.duplicate) {
    body += '\n\n' + t('dup_warning', {
      count: dups.length,
      list: dups
        .map(x => t('dup_line', {
          row: x.row,
          name: mdEscape(x.name),
          id_part: x.privateId ? t('conflict_id_part', { private_id: mdEscape(x.privateId) }) : '',
          arrival: x.arrival,
          apartment: mdEscape(x.apartment),
          room: mdEscape(String(x.room)),
        }))
        .join('\n'),
    });
  }
  reply(body, {
    inline_keyboard: [
      // Neither a conflict nor a duplicate blocks the save — a receptionist
      // standing in front of a guest knows things the sheet does not. Both make
      // them say so, and the duplicate is named first because it is the one that
      // is usually a mistake rather than a judgement call.
      [{
        text: d.duplicate ? t('btn_confirm_dup')
          : d.conflict ? t('btn_confirm_anyway') : t('btn_confirm'),
        callback_data: 'save',
      }],
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

function startAi() { reply(t('ai_ask')); setState('AI_TEXT', {}); }

function validIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const dt = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === s;
}

/** Today in the bot's timezone, as the ISO date the sheet stores. */
function todayIso() {
  const tp = todayParts();
  return `${tp.y}-${String(tp.m).padStart(2, '0')}-${String(tp.d).padStart(2, '0')}`;
}

/**
 * The model's answer for an AI_TEXT message, checked field by field. This is
 * where its answer stops being trusted: it only ever read the text.
 *
 * Returns { intent } when everything it filled in is usable, or { fail, reason }
 * where `fail` is the string key to answer with. A field the model leaves out,
 * or sets to null, simply is not part of the request.
 *
 * `item` is the AI Extract node's item: { output } on success, whatever n8n puts
 * there on an error, or null when the node did not run.
 */
function readAiIntent(item) {
  const o = item && item.output;
  if (!o || typeof o !== 'object') return { fail: 'ai_unavailable' };
  const unclear = String(o.unclear === undefined || o.unclear === null ? '' : o.unclear).trim();
  if (unclear) return { fail: 'ai_not_understood', reason: unclear };

  const id = asciiDigits(o.booking_id).trim();
  if (!id) return { fail: 'ai_not_understood' };
  const intent = { id, payment: null, room: null, stay: null };

  const p = o.payment;
  if (p && typeof p === 'object') {
    const amount = Number(p.amount);
    if (!Number.isFinite(amount) || amount === 0) return { fail: 'ai_bad_amount' };
    // Compared as written. payByKey() would also read "0" as a position in the
    // retired positional order, and a model answering "0" must not mean cash.
    const key = String(p.method || '');
    if (!PAY_METHODS.some(m => m.key === key)) return { fail: 'ai_not_understood' };
    intent.payment = { amount, key };
  }

  const rm = o.room;
  if (rm && typeof rm === 'object') {
    const apartment = String(rm.apartment || '').trim();
    const room = asciiDigits(rm.room).trim();
    if (!apartment || !room) return { fail: 'ai_not_understood' };
    intent.room = { apartment, room };
  }

  const s = o.stay;
  if (s && typeof s === 'object') {
    if (s.kind === 'extend') {
      const nights = Math.trunc(Number(s.nights));
      if (!(nights >= 1)) return { fail: 'ai_not_understood' };
      intent.stay = { kind: 'extend', nights };
    } else if (s.kind === 'until' || s.kind === 'leave') {
      const date = String(s.date || '').trim();
      if (date && !validIsoDate(date)) return { fail: 'ai_bad_date' };
      if (s.kind === 'until' && !date) return { fail: 'ai_bad_date' };
      intent.stay = { kind: s.kind, date };          // a leave with no date is today
    } else {
      return { fail: 'ai_not_understood' };
    }
  }

  if (!intent.payment && !intent.room && !intent.stay) return { fail: 'ai_not_understood' };
  return { intent };
}

function replyAiFail(got) {
  if (got.fail === 'ai_not_understood') {
    reply(t('ai_not_understood', { reason: got.reason ? `\n(${got.reason})` : '' }));
  } else {
    reply(t(got.fail));
  }
}

/** Find the booking the request names, then apply it. Several matches open the picker. */
function openAiBooking(intent) {
  // Matches column B (ID) only, in ASCII on both sides — the same rule as EDIT_FIND.
  const hits = bookingRows().filter(x => asciiDigits(x.json['ID'] || '').trim() === intent.id);
  if (!hits.length) { reply(t('edit_not_found')); return; }       // stays in AI_TEXT
  if (hits.length > 1) {                                           // IDs are not enforced unique
    d.aiIntent = intent;
    reply(t('edit_pick_match'), {
      inline_keyboard: hits.map(h => [{ text: bookingLabel(h.json), callback_data: `epick_${h.row}` }]),
    });
    setState('AI_PICK', d);
    return;
  }
  applyAiIntent(hits[0], intent);
}

/** Task 4 turns this into the real thing. */
function applyAiIntent(hit, intent) {
  reply(t('ai_not_understood', { reason: '' }));
}

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

/**
 * What the booking has been paid across its own row AND every line, in pounds,
 * with foreign currency kept apart.
 *
 * paidSoFar() is the booking row's cell alone. Shown to a cashier as "المدفوع
 * حالياً" it hid every line: 500 كاش on the row and 300 انستاباي underneath read
 * as 500, and the cashier collected the 300 again.
 *
 * `price` is null when it is not a number the bot can compare against. The
 * lookup hands over the evaluated total, so a nightly-rate booking still has one.
 */
function paymentTotals(dd) {
  const method = String((dd.editNew && dd.editNew['طريقة الدفع']) ||
    (dd.editOrig && dd.editOrig['طريقة الدفع']) || '').trim();
  let egp = 0;
  const foreign = {};
  const add = (m, amount) => {
    if (!amount) return;
    if (isForeign(m)) foreign[m] = num((foreign[m] || 0) + amount);
    else egp += amount;
  };
  add(method, paidSoFar(dd));
  for (const l of (Array.isArray(dd.editLines) ? dd.editLines : [])) {
    if (Number(l.row) === Number(dd.editRow)) continue;   // the row counted above
    add(String(l.method || '').trim(), Number(l.amount) || 0);
  }
  const totalCol = 'اجمالي سعر الحجز';
  const raw = (dd.editNew && dd.editNew[totalCol] !== undefined)
    ? dd.editNew[totalCol] : (dd.editOrig ? dd.editOrig[totalCol] : '');
  const price = String(raw === undefined ? '' : raw).trim().startsWith('=') ? null : parseNum(raw);
  return { egp: num(egp), foreign, price: price === null ? null : num(price) };
}

/**
 * The same, once the payment in this session has landed. A payment on the
 * booking's own row is already inside editNew; one on a line is not, because a
 * line is a separate write.
 */
function totalsAfterPayment(dd) {
  const tt = paymentTotals(dd);
  if (hasLinePayment(dd)) {
    const added = Number(parseNum(dd.paidAdded) || 0);
    if (isForeign(dd.payMethod)) tt.foreign[dd.payMethod] = num((tt.foreign[dd.payMethod] || 0) + added);
    else tt.egp = num(tt.egp + added);
  }
  return tt;
}

/** "المدفوع حالياً: 800 من 1500 / المتبقي: 700", plus a line per foreign currency. */
function paymentStatus(tt) {
  const lines = [(tt.price !== null && tt.price > 0)
    ? t('pay_status_of', { paid: tt.egp, price: tt.price, remaining: num(tt.price - tt.egp) })
    : t('pay_status_paid', { paid: tt.egp })];
  for (const cur of Object.keys(tt.foreign)) {
    lines.push(t('pay_status_foreign', { amount: tt.foreign[cur], currency: cur }));
  }
  return lines.join('\n');
}

/** An amount as the group should read it: 100 يورو is not 100 pounds. */
function moneyLabel(amount, method) {
  return isForeign(method) ? `${num(amount)} ${String(method).trim()}` : String(num(amount));
}

/**
 * A warning when this payment takes the pounds paid past the price. Not a block:
 * a deposit or a guest paying ahead is real. A typo like 50000 for 5000 is
 * also real, and this is the moment someone can still catch it.
 */
function overpayNote(dd) {
  const added = Number(parseNum(dd.paidAdded) || 0);
  if (added <= 0 || isForeign(dd.payMethod)) return '';
  const tt = totalsAfterPayment(dd);
  if (tt.price === null || !(tt.price > 0) || tt.egp <= tt.price) return '';
  return t('overpay_warning', { paid: tt.egp, price: tt.price, over: num(tt.egp - tt.price) });
}

/**
 * True when a save was already fired for this session moments ago.
 *
 * The session is deliberately kept until the write succeeds, so a failed write
 * leaves the button usable — which is also what lets an impatient double tap
 * write the row twice. Swallow the second tap for a minute; after that the user
 * is retrying a real failure and is let through.
 */
const SAVE_LOCK_MS = 60 * 1000;

/**
 * A confirmation card is waiting for a button, and the user typed instead.
 *
 * The three CONFIRM states accept exactly one callback each and `break` on
 * anything else, which for a TEXT message meant total silence. That is fine
 * while the card is on screen — the buttons are right there — and awful once it
 * has scrolled away or the user has come back hours later: the bot looks dead.
 *
 * Reported live on 2026-08-22 by the admin whose booking failed against the
 * expired Google credential that morning. The failed save left the session on
 * CONFIRM with the card 400 messages up the chat, and every message they sent
 * afterwards was dropped without a word. They concluded the bot had stopped
 * answering them, which from where they were sitting it had.
 *
 * Returns true when this turn is a plain message rather than a button press.
 */
function waitingForButton() {
  // `cq` is the callback_query, so it is truthy on a BUTTON press. The nudge is
  // for the other case.
  if (!cq) { reply(t('use_buttons')); return true; }
  return false;
}

function saveLocked(dd) {
  return Boolean(dd.savingAt) && (Date.now() - Number(dd.savingAt)) < SAVE_LOCK_MS;
}

/** Record a change, keeping the original value for the group diff. */
function editSet(dd, col, value) {
  if (!dd.editNew) dd.editNew = {};
  dd.editNew[col] = value;
}

/** Is there a payment waiting that belongs on a line rather than on this row? */
function hasLinePayment(dd) {
  return Boolean(dd.payTarget && dd.payTarget.kind !== 'booking' && dd.paidAdded);
}

/**
 * Which sheet LINE a payment belongs on.
 *
 * The user's rule, in their words: *if the new payment type is the same as the
 * old one then the payment amount is added to each other, but if the new
 * payment has a different type then add a new row* — and a third payment is
 * checked against every line that exists by then, not only the first.
 *
 * Until 2026-08-14 there was no rule: the payment wrote طريقة الدفع onto the
 * booking's own row whatever it said before, so a guest who paid cash and then
 * by انستاباي ended up looking like they had only ever paid by انستاباي. The
 * money was right and the method was a lie, and the Dashboard's per-method
 * balances read that cell.
 *
 * غير مدفوع is not a payment method, it is the ABSENCE of one (ruled by the
 * user on 2026-08-28). A booking whose طريقة الدفع still says غير مدفوع has
 * never been paid, so the first real payment belongs on its own row: the cell
 * is relabelled to the new method and the amount goes into اجمالي ما تم دفعه.
 * Opening a line there would leave the booking's row claiming it was unpaid
 * with a payment sitting underneath it — two "methods", one of which is a
 * statement that nothing was paid.
 *
 * Returns one of:
 *   {kind:'booking'} the booking's own row — same method, or it has none yet
 *   {kind:'line'}    a continuation row already carrying this method
 *   {kind:'new'}     no row has this method; one is inserted under the block
 */
function paymentTarget(dd, method) {
  const want = String(method || '').trim();
  const lines = Array.isArray(dd.editLines) ? dd.editLines : [];
  const own = String((dd.editOrig && dd.editOrig['طريقة الدفع']) || '').trim();

  // An empty طريقة الدفع cell — or one that still says غير مدفوع — is filled,
  // never left blank with a line beneath it: that is not what anyone means by
  // two payment methods.
  //
  // Except for a foreign currency. The booking row's paid cell is in pounds and
  // its المتبقي is price − paid, so €100 written there would be subtracted as
  // 100 pounds. Euros and dollars only ever join a row already in that currency.
  if (own === want || (!hasMethod(own) && !isForeign(want))) {
    return { kind: 'booking', row: dd.editRow };
  }

  const hit = lines.find((l) => String(l.method || '').trim() === want);
  if (hit) {
    return { kind: 'line', row: Number(hit.row), seq: Number(hit.seq),
             base: Number(hit.amount) || 0 };
  }

  const maxSeq = lines.reduce((m, l) => Math.max(m, Number(l.seq) || 1), 1);
  const after = Number(dd.blockEnd) || dd.editRow;
  return { kind: 'new', seq: maxSeq + 1, insertAfter: after, row: after + 1, base: 0 };
}

/**
 * Put `added` (non-zero, in the currency of `pay`) where it belongs for this
 * booking: on its own row, or on a payment line. `pay` is the method's Arabic
 * label. Returns null when applied, or the text to show when a refund would take
 * a line below zero. Shared by the manual EDIT_PAYMENT step and the AI edit.
 */
function applyPaymentChoice(dd, pay, added) {
  const target = paymentTarget(dd, pay);
  dd.payTarget = target;
  dd.payMethod = pay;
  if (target.kind === 'booking') {
    // The booking's own row: طريقة الدفع is this method already, or it had
    // none. اجمالي ما تم دفعه is cumulative there, as it always has been.
    editSet(dd, 'اجمالي ما تم دفعه', num(paidSoFar(dd) + added));
    editSet(dd, 'طريقة الدفع', pay);
    return null;
  }
  // A line of its own — either one that already carries this method, whose
  // cells simply grow, or a row that does not exist yet. Both are written
  // by the payment_line branch, and neither touches طريقة الدفع on the
  // booking's row. That cell describes the money on ITS row.
  //
  // The below-zero check in EDIT_PAID cannot cover this, and did not: it
  // runs a turn earlier, before the method is known, and it tests the
  // BOOKING's own paid cell. The row the money actually lands on is only
  // decided here. A booking with 500 كاش on its row and 300 انستاباي on a
  // line would let a −400 انستاباي refund through — 500 − 400 ≥ 0 — and
  // write −100 into that line's paid cell. Since المتبقي is L − M and L is
  // blank on a line, the row's المتبقي would then read +100 while the guest
  // was 400 short. Worse when no line carried the method yet: the same
  // refund INSERTED a row, shifted every row below it, stamped column U and
  // recorded a −400 payment, all to take money off a cell that was elsewhere.
  //
  // A refund can only come out of what that line actually holds.
  const lineTotal = target.base + added;
  if (lineTotal < 0) {
    return t('line_paid_below_zero', { method: pay, current: num(target.base) });
  }
  dd.lineTotal = num(lineTotal);
  return null;
}

/** Lock the edit session onto one sheet row and load what the edit steps need. */
function loadEditBooking(hit) {
  d.editRow = hit.row;
  d.editOrig = hit.json;
  d.editNew = {};
  d.editName = hit.json['اسم المقيم'] || '';
  d.editPrivateId = hit.json['ID'] || '';
  // Everything a payment needs to find its own line. The lookup carries these
  // alongside the sheet's columns; see read_bookings_for_edit.sql. A booking
  // with no lines yet simply has none, and the first payment in a second method
  // opens line 2.
  d.bookingId = hit.json.booking_id || null;
  d.editLines = Array.isArray(hit.json.lines) ? hit.json.lines : [];
  d.blockEnd = Number(hit.json.block_end) || hit.row;
  d.totalIsFormula = Boolean(hit.json.total_is_formula);
}

/** Lock the edit session onto one sheet row, then continue with the right flow. */
function applyPick(hit) {
  loadEditBooking(hit);
  if (d.paidOnly) {
    // Cashier flow: the booking is found, so go straight to the amount. There is
    // no field menu for them — payment is the only thing they may touch.
    reply(t('paid_ask_amount', { status: paymentStatus(paymentTotals(d)) }));
    setState('EDIT_PAID', d);
    return;
  }
  showEditMenu(d);
}

/**
 * Where a completed edit step goes next.
 *
 *  - the add-payment shortcut (`paidOnly`, cashier or admin): linear, and once
 *    the payment (and its receipt) is in, one review card before it is saved;
 *  - admin who just recorded a payment: asked whether the guest has left, since
 *    settling up is when a checkout actually gets noticed. That question is
 *    asked once per session (`leaveAsked`) and ends in a summary + approval
 *    rather than the field menu;
 *  - anything else: back to the field menu.
 */
function afterEditStep(dd) {
  if (dd.paidOnly) { showPaidConfirm(dd); return; }
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
  const warn = overpayNote(dd);
  reply(t('edit_confirm_summary', { changes: changeLines(dd) }) + (warn ? '\n\n' + warn : ''), {
    inline_keyboard: [
      [{ text: t('btn_confirm'), callback_data: 'xedone' }],
      [{ text: t('btn_cancel'), callback_data: 'xecancel' }],
    ],
  }, true);
  setState('EDIT_CONFIRM', dd);
}

/**
 * The add-payment shortcut's review card. Until 2026-10-10 the shortcut saved
 * the moment the method (or receipt) arrived, so a wrong tap — the wrong guest
 * off the picker, 50000 for 5000 — was already in the sheet and the group, and
 * only an admin could take it back out.
 */
function showPaidConfirm(dd) {
  const warn = overpayNote(dd);
  reply(t('paid_confirm', {
    name: mdEscape(dd.editName || t('empty')),
    private_id: mdEscape(dd.editPrivateId || t('empty')),
    apartment: mdEscape((dd.editOrig && dd.editOrig['اسم الشقة']) || t('empty')),
    added: moneyLabel(parseNum(dd.paidAdded) || 0, dd.payMethod),
    method: mdEscape(dd.payMethod || t('empty')),
    receipt: dd.editReceipt ? t('receipt_attached') : t('empty'),
    status: paymentStatus(totalsAfterPayment(dd)),
  }) + (warn ? '\n\n' + warn : ''), {
    inline_keyboard: [
      [{ text: t('btn_confirm'), callback_data: 'pconfirm' }],
      [{ text: t('btn_cancel'), callback_data: 'pcancel' }],
    ],
  }, true);
  setState('PAID_CONFIRM', dd);
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
/**
 * Resolve an `ar_<i>_<room>` tap against the registry that was offered.
 *
 * `dd.reg` is what the keyboard was drawn from, so the index means the same
 * thing at tap time as it did at draw time. The FALLBACK_REGISTRY branch only
 * catches conversations that were mid-flow when this code deployed and so carry
 * no `reg`; without it those taps would silently do nothing.
 */
function pickAptRoom(dd, cb) {
  const m = /^ar_(\d+)_(.+)$/.exec(cb || '');
  if (!m) return null;
  const reg = (dd.reg && dd.reg.length) ? dd.reg : FALLBACK_REGISTRY;
  const entry = reg[Number(m[1])];
  if (!entry) return null;
  const room = String(m[2]);
  if (entry.rooms.indexOf(room) === -1) return null;
  return { apartment: entry.apartment, room };
}

function changeLines(dd) {
  const out_ = [];
  // A payment that belongs on its own line is not a column changing on this
  // row, so it is not in editNew — and the review would show a payment session
  // as "ملاحظات: — ← …" and nothing about the money. Say it plainly instead.
  if (dd.payTarget && dd.payTarget.kind !== 'booking' && dd.paidAdded) {
    out_.push(t('edit_line_review', {
      added: num(parseNum(dd.paidAdded) || 0),
      method: dd.payMethod,
      total: num(parseNum(dd.lineTotal) || 0),
    }));
  }
  for (const col of Object.keys(dd.editNew || {})) {
    out_.push(`${col}: ${showValue(dd.editOrig && dd.editOrig[col])} ← ${showValue(dd.editNew[col])}`);
  }
  if (dd.departure) out_.push(t('edit_departure_line', { departure: dd.departure }));
  return out_.join('\n');
}

/**
 * The changed columns that are not the payment itself.
 *
 * The paid and method columns are already spelled out by the payment message,
 * so repeating them underneath as "0 ← 40" would say the same thing twice in
 * two different vocabularies.
 */
function otherChangeLines(dd) {
  const skip = ['اجمالي ما تم دفعه', 'طريقة الدفع'];
  const out_ = [];
  for (const col of Object.keys(dd.editNew || {})) {
    if (skip.indexOf(col) !== -1) continue;
    out_.push(`${col}: ${showValue(dd.editOrig && dd.editOrig[col])} ← ${showValue(dd.editNew[col])}`);
  }
  if (dd.departure) out_.push(t('edit_departure_line', { departure: dd.departure }));
  return out_.join('\n');
}

// Columns copied onto a new payment line, so the row reads as the same guest.
// E الجنسية is retired and left alone; K, N, P, R, S and T are the sheet's own
// formulas and are never written on any path.
const LINE_IDENTITY_COLS = [
  'بوكنج ID', 'ID', 'اسم المقيم', 'نوع الحجز', 'رقم الهاتف',
  'اسم الشقة', 'رقم الغرفة', 'تاريخ البداية', 'ملاحظات',
];

/**
 * A payment in a method the booking does not already carry on that row.
 *
 * Two shapes, one flow. `insert: true` puts a row under the booking's block
 * first; `insert: false` grows a line that is already there. Either way the
 * booking's own row keeps its method.
 *
 * **اجمالي سعر الحجز does not move** (ruled 2026-08-18). The price was agreed
 * once, it is a fact about the booking, and it stays whole on the booking's own
 * row; the LINE leaves that cell blank, because a line is a second METHOD of
 * paying the price and not a second price. Between them the column still sums
 * to the booking exactly once.
 *
 * It used to work the other way: the line carried its own amount in L and the
 * booking's L was reduced to match. Writing the payment into both made the
 * column read 3,800 for a 2,200 stay, and every formula that totals it read
 * that. supabase/mirror.py and webui/lib/mirror.js apply the same rule — see
 * primary_payload and line_payload in each.
 */
function commitPaymentLine(dd) {
  const paidCol = 'اجمالي ما تم دفعه';
  const totalCol = 'اجمالي سعر الحجز';
  const target = dd.payTarget;
  const added = Number(parseNum(dd.paidAdded) || 0);
  const lineTotal = num(Number(parseNum(dd.lineTotal) || 0));

  const fields = {};
  if (target.kind === 'new') {
    for (const col of LINE_IDENTITY_COLS) {
      const v = dd.editOrig ? dd.editOrig[col] : undefined;
      if (v !== undefined && v !== '') fields[col] = v;
    }
    // An open-ended stay counts its own nights from its own row, so the line
    // gets the formula and not the number it happens to show today.
    const nights = dd.editOrig ? dd.editOrig['عدد الليالي'] : '';
    fields['عدد الليالي'] = nights === '=OPEN' ? '=TODAY()-J{r}' : (nights || '');
    fields['معرف النظام'] = `${dd.bookingId || ''}-${target.seq}`;
  }
  // Blank, and written rather than omitted: an inserted row arrives with
  // `inheritFromBefore`, so it is already carrying a copy of the booking's own
  // price. Leaving the key out would leave that copy sitting there.
  fields[totalCol] = '';
  fields[paidCol] = lineTotal;
  fields['طريقة الدفع'] = dd.payMethod;

  // Whatever else the admin changed in the same session still belongs to the
  // booking's own row. The total is no longer among it — see the note above.
  const bookingFields = Object.assign({}, dd.editNew || {});

  // Pounds only. Summing every line's cell added €100 to the total as 100.
  const paidAfter = totalsAfterPayment(dd).egp;

  dd.savingAt = Date.now();
  out.sessionData = JSON.stringify(dd);   // the lock must outlive this turn
  out.hasSave = true;
  out.save = {
    flow: 'payment_line',
    insert: target.kind === 'new',
    // Where the row goes. `insertAfter` is the last row the booking occupies;
    // the new row is the one below it, and everything under that moves down.
    insertAfter: target.insertAfter || null,
    row: target.row,
    lineSeq: target.seq,
    bookingId: dd.bookingId || null,
    bookingRow: dd.editRow,
    bookingFields: Object.keys(bookingFields).length ? bookingFields : null,
    // Inserting a row renumbers every row beneath it. The database is told so
    // in the same breath, or the next payment lands on whoever moved into that
    // number — which has happened once already, in the other direction.
    shiftFrom: target.kind === 'new' ? target.row : null,
    fields,
    payment: {
      added: num(added),
      method: dd.payMethod,
      lineSeq: target.seq,
      ref: `${dd.editRow}:${dd.savingAt}`,
    },
    receiptFileId: dd.editReceipt || '',
    receiptKind: dd.editReceipt ? (dd.editReceiptKind || 'photo') : '',
    groupChatId: CFG.GROUP_CHAT_ID,
    groupText: t('paid_group_msg', {
      name: mdEscape(dd.editName || t('empty')),
      private_id: mdEscape(dd.editPrivateId || t('empty')),
      apartment: mdEscape((dd.editOrig && dd.editOrig['اسم الشقة']) || t('empty')),
      added: moneyLabel(added, dd.payMethod),
      paid: paidAfter,
      payment: dd.payMethod,
      receipt: dd.editReceipt ? t('receipt_attached') : t('empty'),
      actor,
    }) + '\n' + t('paid_new_line', { method: dd.payMethod }),
    savedText: t('paid_saved'),
    savedNoGroupText: t('paid_saved_no_group'),
    errorText: t('error'),
  };
}

/**
 * Hand the changed columns to the sheet writer. Shared by the admin field menu
 * ("تم") and by the cashier's add-a-payment flow, which differ only in what the
 * group and the confirmation say.
 */
function commitEdit(dd) {
  const paidCol = 'اجمالي ما تم دفعه';
  if (saveLocked(dd)) return;            // a second tap on the same save

  /*
   * A retry that would INSERT a second row is refused outright.
   *
   * The 60-second lock deliberately expires so a user can retry a real
   * failure. For every other flow that is safe — the write is an update of a
   * known row, and doing it twice writes the same cells twice. For a payment
   * line that needs a NEW row it is not: `payTarget` is still
   * `{kind:'new', row, insertAfter}` in the session, so the second attempt
   * emits `insert: true` against the same row and a second blank row is pushed
   * into the tab.
   *
   * That is the expensive failure. The sheet ends two rows longer than the
   * database was told about — `shiftFrom` says +1 on both attempts — so every
   * stored row number below the insert is off by two, and from then on each
   * edit and each payment writes to the wrong guest's row until somebody runs
   * reindex.py. HANDOFF records this exact shape happening once already.
   *
   * The bot cannot tell the three failure modes apart from here: it does not
   * know whether the insert succeeded and only the write failed, or whether
   * neither ran. So it stops and asks for a person, which is the one outcome
   * that cannot corrupt anything. The session is left intact — `/cancel` ends
   * it, and the row that may already exist is visible in the sheet.
   */
  if (dd.savingAt && dd.payTarget && dd.payTarget.kind === 'new' && dd.paidAdded) {
    reply(t('line_retry_blocked', { row: dd.payTarget.row }));
    return;
  }

  // A payment in a method this booking does not already have goes on a line of
  // its own, which is a different write entirely — a row inserted or an
  // existing line's cells grown, and the booking's own طريقة الدفع left saying
  // what IT was paid by.
  if (dd.payTarget && dd.payTarget.kind !== 'booking' && dd.paidAdded) {
    commitPaymentLine(dd);
    return;
  }

  // The amount and the method are set in two separate turns — EDIT_PAID then
  // EDIT_PAYMENT — and a session that loses the first one writes the method on
  // its own. Reported live on 2026-08-12: "changed amount paid and type, only
  // the type was saved". The method cannot be recorded without the money it
  // describes, so if the amount went missing, put it back from what the guest
  // has actually paid.
  if (dd.paidAdded && dd.editNew && dd.editNew[paidCol] === undefined) {
    const orig = parseNum(dd.editOrig ? dd.editOrig[paidCol] : 0) || 0;
    dd.editNew[paidCol] = num(orig + Number(dd.paidAdded));
  }
  // And the reverse: a method with no payment behind it is just a relabel, so
  // it must not carry a payment act into the database.
  if (!dd.editNew || dd.editNew[paidCol] === undefined) dd.paidAdded = 0;

  dd.savingAt = Date.now();
  out.sessionData = JSON.stringify(dd);  // the lock must outlive this turn
  out.hasSave = true;
  out.save = {
    flow: 'edit',
    row: dd.editRow,                 // from the lookup, never computed
    fields: dd.editNew,              // only the columns that actually changed
    // What was paid THIS TIME, and how — not the running total the sheet gets.
    // The sheet has one paid cell and one method cell per row, so a guest who
    // pays twice in two methods loses the first one there; recording the act
    // separately is what lets the database keep both without anybody inserting
    // a row. `ref` is the idempotency key, and reuses the save lock's timestamp
    // so a double tap converges instead of paying twice.
    payment: dd.paidAdded
      ? {
        added: dd.paidAdded,
        method: dd.editNew['طريقة الدفع'] ||
          (dd.editOrig ? dd.editOrig['طريقة الدفع'] : '') || '',
        ref: `${dd.editRow}:${dd.savingAt}`,
      }
      : null,
    receiptFileId: dd.editReceipt || '',
    // 'document' sends the receipt with sendDocument — a file's id is refused
    // by sendPhoto. Every other flow leaves this unset and keeps sendPhoto.
    receiptKind: dd.editReceipt ? (dd.editReceiptKind || 'photo') : '',
    groupChatId: CFG.GROUP_CHAT_ID,
    // A payment leads the message whoever recorded it. The step is called
    // "إضافة دفعة" now, so the group should read as one — "0 ← 40" describes a
    // cell changing, not money arriving, and the group is watching for money.
    // Anything else the admin changed in the same session follows underneath.
    groupText: (dd.paidOnly || dd.paidAdded)
      ? t('paid_group_msg', {
        name: mdEscape(dd.editName || t('empty')),
        private_id: mdEscape(dd.editPrivateId || t('empty')),
        apartment: mdEscape((dd.editOrig && dd.editOrig['اسم الشقة']) || t('empty')),
        added: moneyLabel(parseNum(dd.paidAdded) || 0, dd.payMethod),
        // The whole booking in pounds, lines included — the same figure the
        // review card showed — not this row's cell alone.
        paid: totalsAfterPayment(dd).egp,
        payment: dd.editNew['طريقة الدفع'] || t('empty'),
        receipt: dd.editReceipt ? t('receipt_attached') : t('empty'),
        actor,
      }) + (otherChangeLines(dd)
        ? '\n\n' + t('payment_other_changes', { changes: otherChangeLines(dd) })
        : '')
      : t('edit_group_msg', {
        name: mdEscape(dd.editName), private_id: mdEscape(dd.editPrivateId),
        // Replacing a nightly-rate formula with a fixed number is the one edit
        // whose consequence outlives the edit itself — the price stops growing
        // with the stay — so it is named here rather than left to look like an
        // ordinary total change.
        changes: changeLines(dd)
          + (dd.totalFormulaReplaced ? '\n' + t('total_formula_replaced') : ''),
        actor,
      }),
    savedText: (dd.paidOnly || dd.paidAdded) ? t('paid_saved') : t('edit_saved'),
    savedNoGroupText: (dd.paidOnly || dd.paidAdded)
      ? t('paid_saved_no_group') : t('edit_saved_no_group'),
    errorText: t('error'),
  };
}

function startBooking() { reply(t('ask_booking_id'), skipKb('bid_skip')); setState('BOOKING_ID', {}); }
function startExpense() {
  const n = nextExpenseNumber();
  if (n) reply(t('exp_ask_id_suggest', { n }), suggestKb(n, 'eid_ok', 'eid_skip'));
  else reply(t('exp_ask_id'), skipKb('eid_skip'));
  setState('EXP_ID', { exp_id_suggest: n });
}

/**
 * Cashier's add-a-payment entry. It deliberately reuses the EDIT_FIND state:
 * the "Needs Bookings?" gate in the workflow keys the Sheets lookup off that
 * exact state name, so a separate state would need a graph change to be able to
 * find anything. `paidOnly` on the session data is what makes it linear.
 */
function startPaid() { reply(t('paid_ask_id')); setState('EDIT_FIND', { paidOnly: true }); }

/**
 * The 08:00 availability report, sent to the reports group now rather than
 * tomorrow morning (user, 2026-10-08). The Brain only raises the flag: the
 * report itself is built by nodes/build_reports.js on its own chain, off the
 * same sheet the morning one reads. Nothing is asked, so there is no session.
 */
function sendAvailability() {
  out.hasAvailability = true;
  reply(t('avail_sent'));
  endSession();
}

// ─── Entry points: /start and /cancel ─────────────────────────────────────────

// `go_start` stands in for the /start a receptionist would otherwise type. It
// is rewritten to the command rather than handled separately, so there is
// exactly one implementation of /start.
//
// The session is already ended by the time a saved card is on screen, so this
// arrives with no state, which is precisely the shape /start expects.
//
// `go_start` is no longer on any card the bot draws — the menu buttons replaced
// it — and `go_undo` is not either, now that undo is gone. Telegram keeps every
// card already delivered on screen forever, so an old `go_undo` may still be
// tapped; it falls through to the silent no-op below, which is the right answer
// for a button that no longer means anything.
const cmd = cbData === 'go_start' ? '/start' : text;

if (cmd === '/start' || (cmd || '').startsWith('/start@')) {
  endSession();
  if (isAdmin) {
    reply(t('choose_action'), {
      inline_keyboard: [
        [{ text: t('btn_add_booking'), callback_data: 'choice_booking' }],
        [{ text: t('btn_add_expense'), callback_data: 'choice_expense' }],
        [{ text: t('btn_edit_booking'), callback_data: 'choice_edit' }],
        // A fourth entry, added 2026-08-18. Recording a payment IS an edit —
        // it has always been reachable through تعديل حجز — but getting there
        // meant the field menu and a choice nobody making a payment cares
        // about. `choice_paid` is the same flow the cashier gets: find the
        // booking, take the money, done. The cashier has had the shortcut
        // since the beginning and the admin, who does it more often, did not.
        [{ text: t('btn_add_paid'), callback_data: 'choice_paid' }],
        [{ text: t('btn_ai_edit'), callback_data: 'choice_ai' }],
        [{ text: t('btn_availability'), callback_data: 'choice_avail' }],
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
        [{ text: t('btn_availability'), callback_data: 'choice_avail' }],
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

// ─── The saved card's three shortcuts ─────────────────────────────────────────
//
// The card carries the same buttons as the /start menu, but by the time it is on
// screen the session is over — so these arrive with no state and the CHOICE case
// below never sees them. Dispatch them here, through the very same functions and
// the very same permission checks, so there is one implementation of each flow
// and a cashier cannot reach a booking by keeping an old card on screen.
//
// This also fixes tapping a menu button from a conversation that has since
// ended, which used to do nothing at all.
if (!state && cbData && cbData.indexOf('choice_') === 0) {
  if (cbData === 'choice_expense') startExpense();
  else if (cbData === 'choice_paid' && (isAdmin || isCashier)) startPaid();
  else if (cbData === 'choice_booking' && isAdmin) startBooking();
  else if (cbData === 'choice_edit' && isAdmin) startEdit();
  else if (cbData === 'choice_ai' && isAdmin) startAi();
  else if (cbData === 'choice_avail' && (isAdmin || isCashier)) sendAvailability();
  return [{ json: out }];
}

// No active conversation and not a command → stay silent (matches PTB).
if (!state) return [{ json: out }];

// ─── State machine ────────────────────────────────────────────────────────────

switch (state) {

  // ── Router ────────────────────────────────────────────────────────────────
  case 'CHOICE':
    if (cbData === 'choice_expense') startExpense();
    else if (cbData === 'choice_paid' && (isAdmin || isCashier)) startPaid();
    else if (cbData === 'choice_booking' && isAdmin) startBooking();
    else if (cbData === 'choice_edit' && isAdmin) startEdit();
    else if (cbData === 'choice_ai' && isAdmin) startAi();
    else if (cbData === 'choice_avail' && (isAdmin || isCashier)) sendAvailability();
    break;

  // ── Expense flow ──────────────────────────────────────────────────────────
  case 'EXP_ID':
    if (cbData === 'eid_ok' && d.exp_id_suggest) d.exp_id = d.exp_id_suggest;
    else d.exp_id = cbData === 'eid_skip' ? '' : (text || '').trim();
    delete d.exp_id_suggest;
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
    // Same session-scoped list trick as the booking grid: what was offered is
    // stored, and the callback indexes into that rather than into a live read.
    d.aptList = locationRegistry().map(e => e.apartment);
    const kb = grid(d.aptList, 'eapt_');
    kb.inline_keyboard.push([{ text: t('btn_apt_none'), callback_data: 'eapt_none' }]);
    reply(t('exp_ask_apartment'), kb);
    setState('EXP_APT', d);
    break;
  }

  case 'EXP_APT': {
    if (!cbData || !cbData.startsWith('eapt_')) break;
    const suffix = cbData.slice('eapt_'.length);
    if (suffix === 'none') d.exp_apartment = '';
    else {
      // A conversation that started before this code deployed has no aptList;
      // resolving against the fallback beats silently filing the expense with
      // no apartment at all.
      const list = (d.aptList && d.aptList.length)
        ? d.aptList : FALLBACK_REGISTRY.map(e => e.apartment);
      const chosen = list[Number(suffix)];
      if (!chosen) break;
      d.exp_apartment = chosen;
    }
    reply(t('exp_ask_payment'), keyGrid(EXP_PAYMENTS.map(k => payByKey(k)).filter(Boolean), 'epay_'));
    setState('EXP_PAY', d);
    break;
  }

  case 'EXP_PAY':
    if (!cbData || !cbData.startsWith('epay_')) break;
    const expKey = /^\d+$/.test(cbData.slice('epay_'.length))
      ? EXP_PAYMENTS[Number(cbData.slice('epay_'.length))]   // pre-key keyboards
      : payKeyOf(cbData.slice('epay_'.length));
    d.exp_payment = payLabel(expKey);
    if (!d.exp_payment) break;
    if (EXPENSE_RECEIPT_PAYMENT_KEYS.indexOf(expKey) !== -1) {
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
    if (waitingForButton()) break;
    if (cbData === 'ecancel') { endSession(); reply(t('cancelled')); break; }
    if (cbData !== 'esave') break;
    if (saveLocked(d)) break;
    d.savingAt = Date.now();
    setState('EXP_CONFIRM', d);          // keep the state, persist the lock
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
        'الرقم': idCell(d.exp_id),
      },
      // Legacy positional form, still consumed by the HTTP write path.
      ranges: [{
        range: 'A{r}:H{r}',
        values: [[
          now, d.exp_item, num(d.exp_amount), d.exp_apartment,
          d.exp_notes, d.exp_payment, d.responsible || responsible, idCell(d.exp_id),
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
    d.private_id_suggest = nextBookingId();
    if (d.private_id_suggest) {
      reply(t('ask_private_id_suggest', { n: d.private_id_suggest }),
        suggestKb(d.private_id_suggest, 'pid_ok', 'pid_skip'));
    } else {
      reply(t('ask_private_id'), skipKb('pid_skip'));
    }
    setState('PRIVATE_ID', d);
    break;

  // Whatever is typed, and nothing is allowed too. The ID is a passport number,
  // a national number, a scribble on a form or absent — the column is text and
  // nothing downstream parses it. بوكنج ID has had a skip since the beginning
  // and this did not, so a guest with no papers meant typing a space to get
  // past a question that had no answer.
  case 'PRIVATE_ID':
    if (cq && cbData !== 'pid_skip' && cbData !== 'pid_ok') break;
    if (cbData === 'pid_ok') {
      if (!d.private_id_suggest) break;
      d.private_id = d.private_id_suggest;
    } else {
      d.private_id = cbData === 'pid_skip' ? '' : text.trim();
    }
    delete d.private_id_suggest;
    reply(t('ask_name'));
    setState('NAME', d);
    break;

  case 'NAME': {
    if (cq) break;
    const nm = validateName(text);
    if (nm === null) { reply(t('name_error')); break; }
    d.name = nm;
    if (d.booking_id) { d.btype = 'بوكينج'; askPhone(); }
    else { reply(t('ask_btype'), keyGrid(BTYPE_OPTS, 'bt_')); setState('BTYPE', d); }
    break;
  }

  case 'BTYPE': {
    if (!cbData || !cbData.startsWith('bt_')) break;
    const raw = cbData.slice('bt_'.length);
    const bt = BTYPE_OPTS.find(o => o.key === raw) ||
      (/^\d+$/.test(raw) ? BTYPE_OPTS[Number(raw)] : null);   // pre-key keyboards
    if (!bt) break;
    d.btype = bt.label;
    askPhone();
    break;
  }

  // Same: any text, or none. A walk-in with no phone is a real booking.
  case 'PHONE':
    if (cq && cbData !== 'phone_skip') break;
    d.phone = cbData === 'phone_skip' ? '' : text.trim();
    d.reg = locationRegistry();
    reply(t('ask_apt_room'), aptRoomKb(d.reg));
    setState('APT_ROOM', d);
    break;

  case 'APT_ROOM': {
    if (cbData === 'ar_hdr') break;                       // header tap → no-op
    const picked = pickAptRoom(d, cbData);
    if (!picked) break;
    d.apartment = picked.apartment;
    d.room = picked.room;
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
      // An open stay is priced per night; a fixed one is priced in full.
      if (d.infinity) { reply(t('ask_rate')); setState('RATE', d); }
      else { reply(t('ask_total')); setState('TOTAL', d); }
    }
    break;
  }

  case 'RATE': {
    if (cq) break;
    const v = parseNum(text);
    if (v === null || v <= 0) { reply(t('num_error')); break; }
    d.nightly_rate = v;
    // No total: the sheet computes it from the rate and the night count, both
    // of which keep moving while the guest is still in the room.
    d.total = null;
    reply(t('ask_payment'), keyGrid(PAYMENTS, 'pay_'));
    setState('PAYMENT', d);
    break;
  }

  case 'TOTAL': {
    if (cq) break;
    const v = parseNum(text);
    if (v === null || v < 0) { reply(t('num_error')); break; }
    d.total = v;
    reply(t('ask_payment'), keyGrid(PAYMENTS, 'pay_'));
    setState('PAYMENT', d);
    break;
  }

  case 'PAYMENT': {
    if (!cbData || !cbData.startsWith('pay_')) break;
    const raw = cbData.slice('pay_'.length);
    if (!payByKey(raw)) break;
    d.paymentKey = payKeyOf(raw);
    d.payment = payLabel(raw);
    if (d.paymentKey === UNPAID_KEY) {                     // nothing paid → skip PAID
      d.paid = 0;
      reply(t('ask_notes'), skipKb('notes_skip'));
      setState('NOTES', d);
    } else {
      reply(t('ask_paid'));
      setState('PAID', d);
    }
    break;
  }

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
    if (RECEIPT_PAYMENT_KEYS.indexOf(d.paymentKey) !== -1) {  // transfer → offer receipt
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
    if (waitingForButton()) break;
    if (cbData === 'cancel') { endSession(); reply(t('cancelled')); break; }
    if (cbData !== 'save') break;
    if (saveLocked(d)) break;
    d.savingAt = Date.now();
    setState('CONFIRM', d);              // keep the state, persist the lock
    const dv = derived(d);

    // Column I (عدد الليالي): open-ended → live formula; else the integer.
    // Column J = تاريخ البداية; the sheet derives K (مغادرة) = J + I automatically.
    // "{r}" is substituted with the real row number by "Build Booking Row".
    const nightsCell = d.infinity ? '=TODAY()-J{r}' : d.nights;

    // اجمالي سعر الحجز on an open stay is the rate times however many nights it
    // has run, expressed as the formula rather than as a number that goes stale
    // overnight. This is what people were already typing by hand — `=500*I10`
    // appeared on five rows — now written deliberately, with the rate also
    // stored properly in the database.
    const totalCell = d.infinity ? `=${num(d.nightly_rate)}*I{r}` : num(d.total);

    // Legacy positional form, still consumed by the HTTP write path. Derived from
    // `fields` below so the two cannot drift apart.
    const aToJ = [
      idCell(d.booking_id), idCell(d.private_id), d.name, d.btype,
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
        'بوكنج ID': idCell(d.booking_id),
        'ID': idCell(d.private_id),
        'اسم المقيم': d.name,
        'نوع الحجز': d.btype,
        'الجنسية': '',                                  // retired, kept blank
        'رقم الهاتف': txt(d.phone),
        'اسم الشقة': d.apartment,
        'رقم الغرفة': Number(d.room),
        'عدد الليالي': nightsCell,
        'تاريخ البداية': d.arrival_date,
        'اجمالي سعر الحجز': totalCell,
        'اجمالي ما تم دفعه': num(d.paid),
        'طريقة الدفع': d.payment,
        'ملاحظات': d.notes,
      },
      ranges: [
        { range: 'A{r}:J{r}', values: [aToJ] },
        { range: 'L{r}:M{r}', values: [[totalCell, num(d.paid)]] },
        { range: 'O{r}', values: [[d.payment]] },       // P skipped on purpose
        { range: 'Q{r}', values: [[d.notes]] },
      ],
      // The booking's first payment, recorded as its own act so that a later
      // one in a different method adds to it instead of replacing its label.
      // No row number exists yet — the append decides it — so the idempotency
      // key uses the guest and the moment instead.
      payment: parseNum(d.paid)
        ? { added: num(d.paid), method: d.payment, ref: `new:${d.private_id || d.name}:${Date.now()}` }
        : null,
      receiptFileId: d.receipt || '',   // '' → group gets a plain text message
      groupChatId: CFG.GROUP_CHAT_ID,
      groupText: t('group_msg', summaryVars(d, dv)),
      savedText: t('saved'),
      savedNoGroupText: t('saved_no_group'),
      errorText: t('error'),
    };
    break;
  }

  // ── AI edit ───────────────────────────────────────────────────────────────

  case 'AI_TEXT': {
    if (cq) break;
    if (!isAdmin) { endSession(); break; }
    if (!text) break;                       // a photo or a file: nothing to read
    let item = null;
    try { item = $('AI Extract').first().json; } catch (e) { item = null; }
    const got = readAiIntent(item);
    if (got.fail) { replyAiFail(got); break; }     // the session stays exactly as it was
    d.aiText = text;
    openAiBooking(got.intent);
    break;
  }

  case 'AI_PICK': {
    const m = /^epick_(\d+)$/.exec(cbData || '');
    if (!m) break;
    const hit = bookingRows().find(x => x.row === Number(m[1]));
    if (!hit) { reply(t('edit_not_found')); setState('AI_TEXT', {}); break; }
    applyAiIntent(hit, d.aiIntent);
    break;
  }

  // ── Edit / cancel an existing booking ─────────────────────────────────────

  case 'EDIT_FIND': {
    if (cq) break;
    const q = (text || '').trim();
    if (!q) { reply(t(d.paidOnly ? 'paid_ask_id' : 'edit_ask_id')); break; }
    // Matches column B (ID) only — not بوكنج ID. The user is told to enter the
    // ID, and B is a required step at entry so every saved booking is reachable.
    // Compared in ASCII on both sides: the receptionist's keyboard produces
    // ٢٥ and the stored ID is 25, and those are the same booking.
    const qn = asciiDigits(q);
    const hits = bookingRows().filter(x => asciiDigits(x.json['ID'] || '').trim() === qn);
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
      // A payment on its own line is a change, and it is not in editNew — that
      // holds the columns of the BOOKING's row, and this money is not on it.
      if (!Object.keys(d.editNew || {}).length && !hasLinePayment(d)) {
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
      // The warning is worth a turn: on one of the sixteen nightly-rate
      // bookings, typing a number here replaces the sheet's own formula.
      case 'ef_total':
        reply(t(d.totalIsFormula ? 'ask_total_formula' : 'ask_total'));
        setState('EDIT_TOTAL', d);
        break;
      case 'ef_paid':
        reply(t('edit_ask_paid_add', { status: paymentStatus(paymentTotals(d)) }));
        setState('EDIT_PAID', d);
        break;
      case 'ef_payment': reply(t('ask_payment'), keyGrid(PAYMENTS, 'xpay_')); setState('EDIT_PAYMENT', d); break;
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
      case 'ef_aptroom':
        d.reg = locationRegistry();
        reply(t('ask_apt_room'), aptRoomKb(d.reg));
        setState('EDIT_APT_ROOM', d);
        break;
      case 'ef_notes':   reply(t('ask_notes'), skipKb('xnotes_skip')); setState('EDIT_NOTES', d); break;
      default: break;
    }
    break;
  }

  case 'EDIT_TOTAL': {
    if (cq) break;
    const v = parseNum(text);
    if (v === null || v < 0) { reply(t('num_error')); break; }
    /*
     * On a nightly-rate booking this replaces a live formula with a scalar.
     *
     * Sixteen bookings hold `=500*I10` — or `=(650*I19)-2200` where a lump sum
     * was written off — in اجمالي سعر الحجز, and ten of those are open-ended,
     * so the formula is what makes the bill grow as the stay does. Writing a
     * number freezes it on the day it was typed, and nobody notices until the
     * guest checks out short.
     *
     * `total_is_formula` has been fetched by read_bookings_for_edit.sql since
     * the lines were built, with a comment explaining exactly this, and until
     * 2026-08-21 nothing read it. supabase/mirror.py avoids the same trap with
     * sheet_owned_keys and webui/lib/publish.js with priceCell; the bot was the
     * last writer with no protection at all.
     *
     * It is allowed, because a typed number is a deliberate override and there
     * has to be a way to fix a price. It is no longer silent: the prompt says
     * what will happen, and the change is flagged where the group can see it.
     */
    editSet(d, 'اجمالي سعر الحجز', num(v));
    if (d.totalIsFormula) d.totalFormulaReplaced = true;
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
    // Zero is not a payment. It used to pass, and EDIT_PAYMENT reads "no money"
    // as a method RELABEL — so a cashier typing 0 and tapping انستاباي rewrote
    // the method on someone's booking with no payment and no receipt.
    if (v === 0) { reply(t('paid_zero_error')); break; }
    // Negative is allowed — a refund, or undoing a mistyped payment — for an
    // admin. A cashier records money coming in, not going out. The total may
    // not go below zero either way; that is always an error, not a credit.
    if (v < 0 && !isAdmin) { reply(t('paid_refund_admin_only')); break; }
    const current = paidSoFar(d);
    const total = current + v;
    if (total < 0) { reply(t('edit_paid_below_zero', { current: num(current) })); break; }
    d.paidAdded = num(v);               // for the cashier's group message
    d.paidTouched = true;               // admins get the checkout question after this
    // The cell is NOT written here any more. Which row the money lands on
    // depends on the method, and the method is the next turn — write it now and
    // a payment in a second method adds to the booking's own row before
    // anything has decided that is where it belongs.
    reply(t('ask_payment'), keyGrid(PAY_METHODS, 'xpay_'));
    setState('EDIT_PAYMENT', d);
    break;
  }

  case 'EDIT_PAYMENT': {
    if (!cbData || !cbData.startsWith('xpay_')) break;
    const payKey = payKeyOf(cbData.slice('xpay_'.length));
    const pay = payLabel(payKey);
    if (!pay) break;

    // Now that the method is known, the money can be put on the right row.
    const added = Number(parseNum(d.paidAdded) || 0);

    // A relabel (no money) is an admin correcting a record. Money with
    // غير مدفوع is a contradiction — the keyboard no longer offers it, and a
    // tap on an old card is ignored rather than written.
    if (!added && !isAdmin) break;
    if (added && payKey === UNPAID_KEY) break;

    /*
     * No money means this is a RELABEL, not an allocation.
     *
     * «تعديل طريقة الدفع» on the field menu comes here with `paidAdded` unset,
     * and the only reason that button exists is to correct a method recorded
     * wrongly — HANDOFF records that mistake happening live, كاش entered as
     * انستاباي on row 59.
     *
     * Routed through paymentTarget it did nothing at all. A different method
     * looks like a payment in a method the booking has never used, so the line
     * branch was taken; with `added` at 0 there was no payment to put there,
     * nothing was written to `editNew`, and `hasLinePayment` was false because
     * it tests `paidAdded`. The user got «لم يتم تغيير أي شيء» and the method
     * stayed wrong — or worse, if something else was edited in the same
     * session the save went through with a normal ✅ and the method was still
     * wrong, unmentioned in the group diff.
     *
     * A relabel belongs on the booking's own row and nowhere else: it renames
     * money that is already sitting there. No line is opened, no row inserted,
     * no payment recorded.
     */
    if (!added) {
      editSet(d, 'طريقة الدفع', pay);
      d.payTarget = { kind: 'booking', row: d.editRow, base: paidSoFar(d), seq: 1 };
      d.payMethod = pay;
      afterEditStep(d);
      break;
    }

    const refusal = applyPaymentChoice(d, pay, added);
    if (refusal) { reply(refusal); break; }
    // A receipt is asked for the two transfer methods only. Admins may skip
    // it; a cashier is recording someone else's money, so there is no skip.
    //
    // Until 2026-10-10 a cashier needed proof for anything but كاش, which made
    // Airbnb, يورو and دولار impossible to record: an Airbnb payout has no
    // screenshot, and foreign cash in hand has none either.
    //
    // The skip is keyed on the ROLE, not on `paidOnly`. Those were the same thing until
    // 2026-08-18, when the admin menu gained its own payment shortcut — which
    // also sets `paidOnly`, because that flag means "linear, save as soon as
    // the money is in" and not "this user is a cashier". Left as it was, an
    // admin taking the shortcut would have been held to the cashier's rule and
    // been unable to record a transfer they had no photo for.
    const strictReceipt = !isAdmin;
    const needsReceipt = RECEIPT_PAYMENT_KEYS.indexOf(payKey) !== -1;
    if (needsReceipt) {
      if (strictReceipt) reply(t('paid_ask_receipt'));
      else reply(t('ask_receipt'), skipKb('xreceipt_skip'));
      setState('EDIT_RECEIPT', d);
      break;
    }
    afterEditStep(d);
    break;
  }

  case 'EDIT_RECEIPT':
    // Same role test as the prompt that led here — see EDIT_PAYMENT above.
    if (photoFileId) { d.editReceipt = photoFileId; d.editReceiptKind = 'photo'; }
    else if (docFileId) { d.editReceipt = docFileId; d.editReceiptKind = 'document'; }
    else if (cbData === 'xreceipt_skip' && isAdmin) d.editReceipt = '';
    else if (!isAdmin) { reply(t('paid_receipt_error')); break; }
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
    if (waitingForButton()) break;
    if (cbData === 'xecancel') { endSession(); reply(t('cancelled')); break; }
    if (cbData !== 'xedone') break;
    if (!Object.keys(d.editNew || {}).length && !hasLinePayment(d)) {
      endSession(); reply(t('edit_no_changes')); break;
    }
    commitEdit(d);
    break;
  }

  // The add-payment shortcut's review card — see showPaidConfirm().
  case 'PAID_CONFIRM': {
    if (waitingForButton()) break;
    if (cbData === 'pcancel') { endSession(); reply(t('cancelled')); break; }
    if (cbData !== 'pconfirm') break;
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
    const picked = pickAptRoom(d, cbData);
    if (!picked) break;
    editSet(d, 'اسم الشقة', picked.apartment);
    editSet(d, 'رقم الغرفة', Number(picked.room));
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
    if (saveLocked(d)) break;
    d.savingAt = Date.now();
    setState('EDIT_DEL_CONFIRM', d);
    const orig = d.editOrig || {};
    // Append rather than clobber, so an existing note is not lost.
    const prevNote = String(orig['ملاحظات'] || '').trim();
    out.hasSave = true;
    out.save = {
      flow: 'cancel',
      row: d.editRow,
      // A cancelled booking is worth nothing and occupies no nights, and the
      // sheet has to say so: عدد الليالي and اجمالي سعر الحجز both go to zero.
      // Otherwise the row keeps counting towards occupancy and revenue in every
      // tab that sums those columns, and an open-ended cancellation keeps
      // billing a guest who left — its nights cell is a live =TODAY()-J that
      // never stops climbing.
      //
      // اجمالي ما تم دفعه is deliberately NOT zeroed. If the guest paid and the
      // booking was then cancelled, that money still changed hands; erasing it
      // here would hide a refund that may or may not have happened.
      fields: {
        'ملاحظات': prevNote ? `${prevNote} ${t('del_note')}` : t('del_note'),
        'عدد الليالي': 0,
        'اجمالي سعر الحجز': 0,
      },
      /*
       * The booking's CONTINUATION LINES, cancelled with it.
       *
       * Everything above applies to the booking's own row and, until
       * 2026-08-21, only to it. A booking paid in two methods occupies more
       * rows than that, and every one of them repeats the guest's name, the
       * apartment and the arrival — because the sheet's own formulas read
       * those cells off each row.
       *
       * On an open-ended stay the line also carries `=TODAY()-J{r}`, copied
       * there by commitPaymentLine. Cancel the booking and that formula went
       * on climbing forever: the departed guest kept appearing in occupancy on
       * every tab that sums عدد الليالي, and in the "long stays" section of
       * the daily digest. The row did not even look cancelled, because the
       * formatter blackened one row too.
       *
       * عدد الليالي goes to zero for exactly the reason it does above. The
       * line's اجمالي سعر الحجز is already blank and is left alone, and so is
       * its اجمالي ما تم دفعه: that money changed hands, and erasing it here
       * would hide a refund that may or may not have happened.
       */
      lineRows: (Array.isArray(d.editLines) ? d.editLines : [])
        .filter((l) => Number(l.row) > 0)
        .map((l) => ({
          row: Number(l.row),
          fields: { 'عدد الليالي': 0, 'ملاحظات': t('del_note') },
        })),
      formatRow: true,                  // black fill / white text, via HTTP
      // The last row of the block, so the formatter blackens the whole of it.
      formatThrough: Number(d.blockEnd) || d.editRow,
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

// ─── The saved card ───────────────────────────────────────────────────────────
//
// Every flow above sets `savedText` and `savedNoGroupText` as bare strings. Here
// they become complete sendMessage bodies with buttons on them, in one place
// rather than in six.
//
// The buttons replace "أرسل /start من جديد", which asked a receptionist holding a
// phone in one hand to type a command to do the single most likely next thing.
//
// "Send Saved" and "Send Saved No Group" read these instead of a plain string,
// which is also why they are HTTP nodes now — the Telegram node's inlineKeyboard
// is a fixed collection, so the number of rows is decided at design time, and
// this varies. Same reason "Send Reply" has always been an HTTP node.
if (out.hasSave && out.save) {
  const buttons = [];
  // The whole menu, not just "new booking". Removing "أرسل /start من جديد" took
  // away the only route back to the other two flows, so offering one of them
  // would have made the card a downgrade for anyone whose next job is an
  // expense. Same buttons, same callback_data and same permission split as the
  // /start menu — a cashier never sees the booking or edit entries.
  if (isAdmin) {
    buttons.push([{ text: t('btn_add_booking'), callback_data: 'choice_booking' }]);
    buttons.push([{ text: t('btn_add_expense'), callback_data: 'choice_expense' }]);
    buttons.push([{ text: t('btn_edit_booking'), callback_data: 'choice_edit' }]);
    buttons.push([{ text: t('btn_add_paid'), callback_data: 'choice_paid' }]);
    buttons.push([{ text: t('btn_ai_edit'), callback_data: 'choice_ai' }]);
  } else {
    buttons.push([{ text: t('btn_add_expense'), callback_data: 'choice_expense' }]);
    buttons.push([{ text: t('btn_add_paid'), callback_data: 'choice_paid' }]);
  }
  buttons.push([{ text: t('btn_availability'), callback_data: 'choice_avail' }]);
  const card = (body) => ({
    chat_id: chatId,
    text: body,
    reply_markup: { inline_keyboard: buttons },
  });
  out.save.savedBody = card(out.save.savedText);
  out.save.savedNoGroupBody = card(out.save.savedNoGroupText);
}

// On a save the session is deliberately kept until the write succeeds, so a
// failed write leaves the user on CONFIRM and the Save button still works.
return [{ json: out }];
