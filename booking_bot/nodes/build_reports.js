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
 * The apartment/room registry comes from a third read, "Read Report Locations"
 * — the same query the Telegram branch's Read Locations node runs. Nothing on
 * the bookings tab knows which rooms exist, only which ones are slept in, so
 * the empty rooms cannot be named without it.
 *
 * Output: one item per message to send, so the Telegram node downstream just
 * loops. Zero items means no message at all.
 *
 * TWO reports go out, every morning, to REPORT_GROUP_CHAT_ID — split on
 * 2026-09-21 at the user's request, because the two get read by different
 * people for different reasons and one scrolling message served neither:
 *
 *   🏠 تقرير الإتاحة    every room in the building, apartment by apartment,
 *                      carrying its guest or reading متاحه, then who leaves today
 *   💰 تقرير المديونيات  every booking with المتبقي > 0, biggest first
 *
 * Both are sent even when empty — a report that only shows up when there is
 * news cannot be told apart from a branch that has died, which is exactly what
 * happened to this one between 2026-08-28 and 2026-09-21.
 *
 * The old ☀️ digest — arrivals and long open stays — stays switched off behind
 * SEND_DAILY_DIGEST, where the user put it on 2026-08-28. Its departures
 * section duplicates the availability report's مغادرة اليوم, so flipping that
 * flag back on would announce departures twice. Pick one.
 *
 * The trigger, the reads and this node also drive the reconcile snapshot and
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
  line_guest: '• {name} — {apartment} · {room}',
  line_long: '• {name} — {apartment} · {room} — منذ {arrival} ({days} يوم)',
  // A "·" between the apartment and the room on the departure line: the word
  // غرفة came off it on 2026-09-21, and "انبي 3 4" reads as one number when the
  // apartment name ends in a digit — which half of them do. The room lines need
  // no separator, their apartment is a heading above them, and the debt line
  // carries no room at all.
  nothing: 'لا يوجد',
  debt_line: '• {name} — {apartment}: {amount}',
  avail_title: '🏠 *تقرير الإتاحة* — {date}',
  debt_title: '💰 *تقرير المديونيات* — {date}',
  occupied: '🏠 *الغرف المشغولة* ({n} غرفة / {g} نزيل)',
  occ_apartment: '*{apartment}*',
  occ_line: '  • {room} — {name} ({arrival} ← {departure})',
  room_free: '  • {room} — متاحه',
  occ_open: 'مفتوح',
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
 * yyyy-mm-dd → dd/mm, for the availability lines.
 *
 * The year is noise on a report about who is in the building this morning: the
 * arrival and the departure are both within days of today. Anything that is not
 * an ISO date is passed through untouched rather than mangled.
 */
function dm(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  return m === null ? String(iso || '').trim() : m[3] + '/' + m[2];
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
 * Every room that exists, in registry order, or [] when it cannot be read.
 *
 * The node is wired with continueRegularOutput, and a graph deployed before
 * 2026-09-21 does not carry it at all — referencing a node that is not there
 * throws. Either way the answer is the same: say nothing about empty rooms
 * rather than announce the whole building as free, which is what subtracting
 * the occupied rooms from an empty registry would otherwise produce.
 */
function registry() {
  let items;
  try {
    items = $('Read Report Locations').all();
  } catch (e) {
    return [];
  }
  const out = [];
  for (const i of items || []) {
    const j = i.json || {};
    const apartment = String(j['الشقة'] || '').trim();
    const room = String(j['الغرفة'] || '').trim();
    if (apartment && room) out.push({ apartment, room });
  }
  return out;
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
  // Raw, not escaped: the room registry is matched on these, and the Markdown
  // escaping goes back on at render time.
  const apartment = String(j['اسم الشقة'] || '').trim() || '—';
  const room = String(j['رقم الغرفة'] || '').trim() || '—';
  const arrival = String(j['تاريخ البداية'] || '').trim();
  const isOpen = openByRow[String(j.row_number)] === true;
  const nights = parseNum(j['عدد الليالي']);
  // The sheet derives تاريخ المغادرة as J + I; trust it, but only for a stay
  // that actually has an end. For an open one it always evaluates to today.
  const departure = isOpen ? '' : (String(j['تاريخ المغادرة'] || '').trim() ||
    (nights === null ? '' : isoAddDays(arrival, Math.trunc(nights))));

  const where = { name, apartment: esc(apartment), room: esc(room) };
  if (arrival === today) arrivals.push(t('line_guest', where));
  if (departure && departure === today) departures.push(t('line_guest', where));

  /**
   * In the room right now.
   *
   * Arrived on or before today, and either open-ended or leaving after today.
   * The guest whose تاريخ المغادرة IS today is deliberately not counted here —
   * they are listed one section down, under مغادرة اليوم, and counting them in
   * both would make the room look taken by someone who is on their way out.
   * The same call is what makes the room they are leaving count as free today,
   * which is the question الغرف الفارغة is asked to answer.
   *
   * A booking with neither an end nor a live =TODAY()-J is not counted either:
   * without عدد الليالي there is nothing to say when it ends, and guessing
   * "still here" would keep a stay from 2024 on the list forever.
   *
   * The dates are ISO, so a string compare is a date compare.
   */
  if (arrival !== '' && arrival <= today && (isOpen || (departure && departure > today))) {
    occupied.push({ apartment, room, name, arrival, departure, isOpen });
  }

  const age = daysBetween(arrival, today);
  if (isOpen && age !== null && age > LONG_STAY_DAYS) {
    longStays.push(t('line_long', {
      name, apartment: esc(apartment), room: esc(room), arrival, days: age,
    }));
  }

  const remaining = parseNum(j['المتبقي']);
  if (remaining !== null && remaining > 0) {
    debts.push({
      amount: remaining,
      // Name, apartment and the amount — no room number and no "متبقي" (user,
      // 2026-09-21). Who owes, where, how much.
      line: t('debt_line', { name, apartment: esc(apartment), amount: remaining }),
    });
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

// ── Report 1 ── every room, in order, taken or متاحه · 🛫 today's departures ──
//
// Reshaped on 2026-09-21 to the layout the user drew: no occupied section and
// no empty section, one list of the WHOLE building, apartment by apartment,
// each room either carrying its guest or reading متاحه. The two-section version
// meant reading both lists and subtracting them in your head to answer the only
// question anyone asks it — is there a bed in انبي 2 tonight.
{
  const parts = [t('avail_title', { date: today }), ''];

  // `apartment|room` is a room's identity — a bare room number is not unique
  // across apartments.
  const guestsByRoom = {};
  for (const o of occupied) {
    const key = o.apartment + '|' + o.room;
    (guestsByRoom[key] = guestsByRoom[key] || []).push(o);
  }

  function roomLines(apartment, room) {
    const guests = guestsByRoom[apartment + '|' + room];
    // One room can hold more than one guest — a family books a bed each, under
    // its own name and sometimes its own dates — so each gets a line rather
    // than one line naming them both with one set of dates.
    if (!guests || !guests.length) return [t('room_free', { room: esc(room) })];
    return guests.map(o => t('occ_line', {
      room: esc(o.room),
      name: o.name,
      // Arrival and departure, day/month only — no year, no "منذ" and no
      // "غرفة" (user, 2026-09-21): the apartment heading above already says
      // these are rooms, and what the group reads off the line is when the bed
      // frees up.
      arrival: dm(o.arrival),
      departure: o.isOpen || !o.departure ? t('occ_open') : dm(o.departure),
    }));
  }

  const all = registry();
  if (all.length) {
    // Registry order is apartment, then room numerically — the query sorts it
    // that way, and room 10 must not land between 1 and 2.
    const blocks = [];
    const at = {};
    function block(apartment) {
      if (at[apartment] === undefined) {
        at[apartment] = blocks.length;
        blocks.push({ apartment, rooms: [], seen: {} });
      }
      return blocks[at[apartment]];
    }
    function room(apartment, number) {
      const b = block(apartment);
      if (b.seen[number] === undefined) {
        b.seen[number] = true;
        b.rooms.push(number);
      }
    }
    for (const r of all) room(r.apartment, r.room);
    // A guest in a room the registry has never heard of — a new room, or an
    // apartment spelled differently on the sheet — is appended rather than
    // dropped. Losing a guest off this report is worse than an odd-looking
    // block at the bottom of it.
    for (const o of occupied) room(o.apartment, o.room);

    for (const b of blocks) {
      parts.push(t('occ_apartment', { apartment: esc(b.apartment) }));
      for (const number of b.rooms) parts.push(...roomLines(b.apartment, number));
    }
    parts.push('');
  } else if (occupied.length) {
    // No registry: the empty rooms cannot be named, so this falls back to the
    // pre-2026-09-21 layout — the occupied rooms only, under their apartment,
    // with the counts that made that list readable on its own.
    occupied.sort((a, b) =>
      a.apartment.localeCompare(b.apartment, 'ar') ||
      (parseNum(a.room) === null || parseNum(b.room) === null
        ? String(a.room).localeCompare(String(b.room), 'ar')
        : parseNum(a.room) - parseNum(b.room)));
    const rooms = {};
    for (const o of occupied) rooms[o.apartment + '|' + o.room] = true;
    parts.push(t('occupied', { n: Object.keys(rooms).length, g: occupied.length }));
    let apartment = null;
    for (const o of occupied) {
      if (o.apartment !== apartment) {
        apartment = o.apartment;
        parts.push(t('occ_apartment', { apartment: esc(apartment) }));
      }
      parts.push(t('occ_line', {
        room: esc(o.room),
        name: o.name,
        arrival: dm(o.arrival),
        departure: o.isOpen || !o.departure ? t('occ_open') : dm(o.departure),
      }));
    }
    parts.push('');
  } else {
    parts.push(t('occ_none'), '');
  }

  // 🛫 Departures
  if (departures.length) {
    parts.push(t('departures', { n: departures.length }), ...departures);
  } else {
    parts.push(t('dep_none'));
  }

  for (const text of pack(parts)) {
    messages.push({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' });
  }
}

// ── Report 2 ── 💰 debts, biggest first ──
//
// A message of its own since 2026-09-21. It was the third section of the
// availability report for a day, and a Saturday-only message before that.
//
// No total line: the user dropped it the same evening. The list is what gets
// acted on, guest by guest, and a five-figure sum under it was a number nobody
// chased.
{
  const parts = [t('debt_title', { date: today }), ''];
  if (debts.length) {
    debts.sort((a, b) => b.amount - a.amount);
    parts.push(t('debt_section', { n: debts.length }), ...debts.map(x => x.line));
  } else {
    parts.push(t('debt_section_none'));
  }

  for (const text of pack(parts)) {
    messages.push({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' });
  }
}

return messages.map(json => ({ json }));
