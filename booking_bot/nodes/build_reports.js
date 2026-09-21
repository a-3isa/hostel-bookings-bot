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
 * loops. Zero items means no message at all.
 *
 * ONE report goes out, every morning: 📋 تقرير اليوم, to REPORT_GROUP_CHAT_ID.
 * Three sections —
 *
 *   🏠 الغرف المشغولة   every room with a guest in it right now, by apartment
 *   🛫 مغادرة اليوم      whoever's تاريخ المغادرة is today
 *   💰 العملاء المدينون  every booking with المتبقي > 0, plus the total
 *
 * Asked for on 2026-09-21, and it replaces the Saturday-only debt report: the
 * debts are a section of the daily message now, not a message of their own.
 * It is sent even when all three sections are empty — a report that only shows
 * up when there is news cannot be told apart from a branch that has died, which
 * is exactly what happened to this one between 2026-08-28 and now.
 *
 * The old ☀️ digest — arrivals and long open stays — stays switched off behind
 * SEND_DAILY_DIGEST, where the user put it on 2026-08-28. Its departures
 * section is what the new report's مغادرة اليوم grew out of, so flipping that
 * flag back on would announce departures twice. Pick one.
 *
 * The trigger, both reads and this node also drive the reconcile snapshot and
 * the mirror append that publishes dashboard-born bookings into the sheet, so
 * the branch runs whatever this node decides to emit.
 */

// The reports branch has its own Config: the Telegram trigger's Config node
// does not execute on a schedule run, and referencing an unexecuted node throws.
const CFG = $('Report Config').first().json;
const TZ = CFG.TIMEZONE || 'Africa/Cairo';
const CHAT_ID = CFG.REPORT_GROUP_CHAT_ID;

const LONG_STAY_DAYS = 30;
// Telegram rejects a message over 4096 characters outright, and a full house
// plus a long debt list gets there. Sections are packed into as few messages as
// fit under this, and a message is never split mid-line.
const MAX_CHARS = 3500;

// The daily digest, off since 2026-08-28 at the user's request. Flip to true to
// bring it back; everything it needs is still computed below, because the debt
// report walks the same rows and the open-stay read is what tells the two of
// them apart from a stay that merely looks like it ends today.
const SEND_DAILY_DIGEST = false;

const S = {
  digest_title: '☀️ *تقرير اليوم* — {date}',
  arrivals: '🛬 *وصول اليوم* ({n})',
  departures: '🛫 *مغادرة اليوم* ({n})',
  long_stays: '🕰️ *إقامات مفتوحة أطول من {days} يوم* ({n})',
  line_guest: '• {name} — {apartment} غرفة {room}',
  line_long: '• {name} — {apartment} غرفة {room} — منذ {arrival} ({days} يوم)',
  nothing: 'لا يوجد',
  debt_line: '• {name} — {apartment} غرفة {room} — متبقي {amount}',
  debt_total: '\n*الإجمالي المتبقي: {total}*',
  daily_title: '📋 *تقرير اليوم* — {date}',
  occupied: '🏠 *الغرف المشغولة* ({n} غرفة / {g} نزيل)',
  occ_apartment: '*{apartment}*',
  occ_line: '  • غرفة {room} — {name} (منذ {arrival})',
  occ_none: '🏠 *الغرف المشغولة* — لا يوجد',
  dep_none: '🛫 *مغادرة اليوم* — لا يوجد',
  debt_section: '💰 *العملاء المدينون* ({n})',
  debt_section_none: '💰 *العملاء المدينون* — لا يوجد',
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

/**
 * Lines -> as few messages as fit under MAX_CHARS, never splitting a line.
 *
 * Telegram refuses a message over 4096 characters outright: the send fails, and
 * with it the whole report, on exactly the busy morning when the report matters
 * most. A full house plus a long debt list gets there.
 *
 * A single line longer than the limit is passed through rather than cut. It
 * cannot be made to fit, and a truncated one would break the Markdown around a
 * guest's name and fail the send anyway.
 */
function pack(lines) {
  const out = [];
  let buf = [];
  let len = 0;
  for (const line of lines) {
    const cost = String(line).length + 1;
    if (buf.length && len + cost > MAX_CHARS) {
      out.push(buf.join('\n').trim());
      buf = [];
      len = 0;
    }
    buf.push(line);
    len += cost;
  }
  const last = buf.join('\n').trim();
  if (last) out.push(last);
  return out;
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

/**
 * A continuation LINE, not a guest.
 *
 * Column U is `413` on a booking's own row and `413-2` on a row carrying one of
 * its payments in a second method. Everything identifying the guest is repeated
 * on that row — name, apartment, arrival, and on an open stay the live
 * `=TODAY()-J{r}` — so to every loop below it looks like a second booking.
 *
 * It cost three wrong reports at once, from 2026-08-18, when the money rule
 * changed to leave اجمالي سعر الحجز BLANK on a line:
 *
 *   - the Saturday debt report. المتبقي is L − M, so a 2,200 stay showing 600
 *     on its own row and 1,600 on an انستاباي line reads +1,600 owed on the
 *     booking row and −1,600 on the line. The negative is dropped by the
 *     `> 0` filter and the positive is reported, so a guest who has paid in
 *     full is billed for their own second payment and الإجمالي المتبقي is
 *     inflated by every payment line on the tab.
 *   - the daily digest, which listed the guest twice under arrivals.
 *   - long stays, which listed them twice again.
 *
 * The booking's own row carries the whole truth about the stay; the line row
 * carries money that is already counted in it.
 */
const LINE_ROW = /^\s*\d+\s*-\s*\d+\s*$/;

const rows = $input.all()
  .map(i => i.json)
  .filter(j => j && String(j['اسم المقيم'] || '').trim())
  .filter(j => !LINE_ROW.test(String(j['معرف النظام'] || '')))
  // A cancelled booking is still a row; it must not appear as an arrival.
  .filter(j => String(j['ملاحظات'] || '').indexOf('ملغي') === -1);

const arrivals = [];
const departures = [];
const longStays = [];
const debts = [];
const occupied = [];

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

  /**
   * In the room right now.
   *
   * Arrived on or before today, and either open-ended or leaving after today.
   * The guest whose تاريخ المغادرة IS today is deliberately not counted here —
   * they are listed one section down, under مغادرة اليوم, and counting them in
   * both would make the room look taken by someone who is on their way out.
   *
   * A booking with neither an end nor a live =TODAY()-J is not counted either:
   * without عدد الليالي there is nothing to say when it ends, and guessing
   * "still here" would keep a stay from 2024 on the list forever.
   *
   * The dates are ISO, so a string compare is a date compare.
   */
  if (arrival !== '' && arrival <= today && (isOpen || (departure && departure > today))) {
    occupied.push({ apartment, room, name, arrival });
  }

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

// ── Daily digest ── OFF since 2026-08-28; see SEND_DAILY_DIGEST above.
// Sent only when there is something to say.
if (SEND_DAILY_DIGEST && (arrivals.length || departures.length || longStays.length)) {
  const parts = [t('digest_title', { date: today }), ''];
  if (arrivals.length) parts.push(t('arrivals', { n: arrivals.length }), ...arrivals, '');
  if (departures.length) parts.push(t('departures', { n: departures.length }), ...departures, '');
  if (longStays.length) {
    parts.push(t('long_stays', { days: LONG_STAY_DAYS, n: longStays.length }), ...longStays);
  }
  messages.push({ chat_id: CHAT_ID, text: parts.join('\n').trim(), parse_mode: 'Markdown' });
}

// ── The daily report ── 🏠 occupied rooms · 🛫 today's departures · 💰 debts ──
//
// Sent every morning, whatever it finds. The debts used to be a message of
// their own, on Saturdays; they are the third section of this one now.
{
  const parts = [t('daily_title', { date: today }), ''];

  // 🏠 Occupied, grouped by apartment. Sorted by apartment, then by room
  // NUMERICALLY — plain string order puts room 10 between 1 and 2, and the
  // room numbers on this sheet run past 9.
  if (occupied.length) {
    occupied.sort((a, b) =>
      a.apartment.localeCompare(b.apartment, 'ar') ||
      (parseNum(a.room) === null || parseNum(b.room) === null
        ? String(a.room).localeCompare(String(b.room), 'ar')
        : parseNum(a.room) - parseNum(b.room)));
    // One room can hold more than one guest (a family books a bed each under
    // its own name), so the headline counts both: distinct rooms, and people.
    // `apartment|room` is the room's identity — a bare room number is not
    // unique across apartments.
    const roomKeys = {};
    for (const o of occupied) roomKeys[o.apartment + '|' + o.room] = true;
    parts.push(t('occupied', { n: Object.keys(roomKeys).length, g: occupied.length }));
    let apartment = null;
    for (const o of occupied) {
      if (o.apartment !== apartment) {
        apartment = o.apartment;
        parts.push(t('occ_apartment', { apartment }));
      }
      parts.push(t('occ_line', { room: o.room, name: o.name, arrival: o.arrival }));
    }
    parts.push('');
  } else {
    parts.push(t('occ_none'), '');
  }

  // 🛫 Departures
  if (departures.length) {
    parts.push(t('departures', { n: departures.length }), ...departures, '');
  } else {
    parts.push(t('dep_none'), '');
  }

  // 💰 Debts, biggest first, with the total
  if (debts.length) {
    debts.sort((a, b) => b.amount - a.amount);
    const total = debts.reduce((sum, x) => sum + x.amount, 0);
    parts.push(t('debt_section', { n: debts.length }), ...debts.map(x => x.line),
               t('debt_total', { total: Math.round(total * 100) / 100 }));
  } else {
    parts.push(t('debt_section_none'));
  }

  for (const text of pack(parts)) {
    messages.push({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' });
  }
}

return messages.map(json => ({ json }));
