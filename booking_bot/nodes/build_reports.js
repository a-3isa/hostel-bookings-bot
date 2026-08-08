/**
 * Scheduled reports for the ops group — the "Build Reports" Code node.
 *
 * Input: إدخال الحجوزات read TWICE over the same range, and joined on row_number.
 * Neither render mode alone is enough:
 *
 *   - evaluated ("Read Report Values") gives real numbers for المتبقي, which is
 *     a sheet formula, but reports an open-ended stay as departing *today*,
 *     every day, because عدد الليالي is a live =TODAY()-J and the sheet derives
 *     تاريخ المغادرة from it;
 *   - FORMULA ("Read Report Formulas") shows exactly which rows are open-ended,
 *     but hands back formula text for المتبقي — and for اجمالي سعر الحجز too,
 *     which is `=500*I{row}` on nightly-rate bookings.
 *
 * So: money and dates come from the evaluated read, open-endedness from the
 * formula read. One extra Sheets call a day buys an exact answer.
 *
 * Output: one item per message to send, so the Telegram node downstream just
 * loops. Zero items on a quiet day means no message at all, which is the point:
 * a digest that fires "nothing today" every morning stops being read.
 *
 * Two reports share one trigger and one read:
 *   - the daily digest, every day;
 *   - the debt report, Saturdays only (the start of the working week here).
 */

// The reports branch has its own Config: the Telegram trigger's Config node
// does not execute on a schedule run, and referencing an unexecuted node throws.
const CFG = $('Report Config').first().json;
const TZ = CFG.TIMEZONE || 'Africa/Cairo';
const CHAT_ID = CFG.REPORT_GROUP_CHAT_ID;

const LONG_STAY_DAYS = 30;
const DEBT_WEEKDAY = 6;                       // 0 = Sunday … 6 = Saturday

const S = {
  digest_title: '☀️ *تقرير اليوم* — {date}',
  arrivals: '🛬 *وصول اليوم* ({n})',
  departures: '🛫 *مغادرة اليوم* ({n})',
  long_stays: '🕰️ *إقامات مفتوحة أطول من {days} يوم* ({n})',
  line_guest: '• {name} — {apartment} غرفة {room}',
  line_long: '• {name} — {apartment} غرفة {room} — منذ {arrival} ({days} يوم)',
  nothing: 'لا يوجد',
  debt_title: '💰 *المبالغ المتبقية* — {date}',
  debt_line: '• {name} — {apartment} غرفة {room} — متبقي {amount}',
  debt_total: '\n*الإجمالي المتبقي: {total}*',
  debt_none: '✅ لا توجد مبالغ متبقية.',
};

function t(key, vars) {
  let v = S[key] === undefined ? key : S[key];
  if (vars) v = v.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
  return v;
}

/** Telegram is sent parse_mode Markdown; guest names are free text. */
function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/([_*[\]`])/g, '\\$1'); }

function todayIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function weekdayInTz() {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' })
    .format(new Date());
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

function daysBetween(fromIso, toIso) {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fromIso || '').trim());
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(toIso || '').trim());
  if (!a || !b) return null;
  return Math.round(
    (Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86400000
  );
}

function isoAddDays(iso, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (m === null) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days)).toISOString().slice(0, 10);
}

function parseNum(v) {
  const n = parseFloat(String(v === undefined ? '' : v).replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}

const today = todayIso();

// row_number → true when عدد الليالي is a live formula, i.e. the stay is open.
const openByRow = {};
for (const i of $('Read Report Formulas').all()) {
  const j = i.json || {};
  openByRow[String(j.row_number)] =
    String(j['عدد الليالي'] === undefined ? '' : j['عدد الليالي']).trim().startsWith('=');
}

const rows = $input.all()
  .map(i => i.json)
  .filter(j => j && String(j['اسم المقيم'] || '').trim())
  // A cancelled booking is still a row; it must not appear as an arrival.
  .filter(j => String(j['ملاحظات'] || '').indexOf('ملغي') === -1);

const arrivals = [];
const departures = [];
const longStays = [];
const debts = [];

for (const j of rows) {
  const name = esc(j['اسم المقيم']);
  const apartment = esc(j['اسم الشقة'] || '—');
  const room = esc(j['رقم الغرفة'] || '—');
  const arrival = String(j['تاريخ البداية'] || '').trim();
  const isOpen = openByRow[String(j.row_number)] === true;
  const nights = parseNum(j['عدد الليالي']);
  // The sheet derives تاريخ المغادرة as J + I; trust it, but only for a stay
  // that actually has an end. For an open one it always evaluates to today.
  const departure = isOpen ? '' : (String(j['تاريخ المغادرة'] || '').trim() ||
    (nights === null ? '' : isoAddDays(arrival, Math.trunc(nights))));

  if (arrival === today) arrivals.push(t('line_guest', { name, apartment, room }));
  if (departure && departure === today) departures.push(t('line_guest', { name, apartment, room }));

  const age = daysBetween(arrival, today);
  if (isOpen && age !== null && age > LONG_STAY_DAYS) {
    longStays.push(t('line_long', { name, apartment, room, arrival, days: age }));
  }

  const remaining = parseNum(j['المتبقي']);
  if (remaining !== null && remaining > 0) {
    debts.push({ amount: remaining, line: t('debt_line', { name, apartment, room, amount: remaining }) });
  }
}

const messages = [];

// ── Daily digest ──
// Sent only when there is something to say.
if (arrivals.length || departures.length || longStays.length) {
  const parts = [t('digest_title', { date: today }), ''];
  if (arrivals.length) parts.push(t('arrivals', { n: arrivals.length }), ...arrivals, '');
  if (departures.length) parts.push(t('departures', { n: departures.length }), ...departures, '');
  if (longStays.length) {
    parts.push(t('long_stays', { days: LONG_STAY_DAYS, n: longStays.length }), ...longStays);
  }
  messages.push({ chat_id: CHAT_ID, text: parts.join('\n').trim(), parse_mode: 'Markdown' });
}

// ── Debt report, Saturdays ──
if (weekdayInTz() === DEBT_WEEKDAY) {
  debts.sort((a, b) => b.amount - a.amount);          // biggest first
  const total = debts.reduce((sum, x) => sum + x.amount, 0);
  const parts = [t('debt_title', { date: today }), ''];
  if (debts.length) {
    parts.push(...debts.map(x => x.line), t('debt_total', { total: Math.round(total * 100) / 100 }));
  } else {
    parts.push(t('debt_none'));
  }
  messages.push({ chat_id: CHAT_ID, text: parts.join('\n').trim(), parse_mode: 'Markdown' });
}

return messages.map(json => ({ json }));
