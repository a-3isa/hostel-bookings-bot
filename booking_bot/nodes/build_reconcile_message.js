/**
 * Turn the reconcile query into the morning message — "Build Reconcile Message".
 *
 * This is the report that earns the flip. It answers one question: does the
 * database still agree with the spreadsheet?
 *
 * It posts even when everything matches. A report that only appears when
 * something is wrong is indistinguishable from a report that has quietly stopped
 * running, and the whole point of the trust period is knowing the difference.
 */

const CFG = $('Report Config').first().json;
const CHAT_ID = CFG.REPORT_GROUP_CHAT_ID;

// "Read Discrepancies" returns nothing at all when the two agree; n8n then hands
// this node a single empty item rather than an empty list.
const rows = $input.all()
  .map(i => i.json)
  .filter(j => j && j.sheet_row !== undefined && j.sheet_row !== null);

const checked = (() => {
  try { return Number($('Build Snapshot SQL').first().json.rows) || 0; } catch (e) { return 0; }
})();

const MAX_LINES = 20;

function esc(v) {
  return String(v === undefined || v === null ? '' : v).replace(/([_*[\]`])/g, '\\$1');
}

function show(v) {
  if (v === undefined || v === null || v === '') return '—';
  // Postgres hands dates back as ISO timestamps, and the UTC shift makes them
  // read a day early. Only the date part is meaningful here.
  const iso = /^(\d{4}-\d{2}-\d{2})T/.exec(String(v));
  return esc(iso ? iso[1] : v);
}

/** Only the fields that actually differ, so the line says what is wrong. */
function diffs(r) {
  const pairs = [
    ['الاسم', r.sheet_guest, r.db_guest],
    ['الشقة', r.sheet_apt, r.db_apt],
    ['الغرفة', r.sheet_room, r.db_room],
    ['البداية', r.sheet_arrival, r.db_arrival],
    ['الليالي', r.sheet_nights, r.db_nights],
    ['الاجمالي', r.sheet_total, r.db_total],
    ['المدفوع', r.sheet_paid, r.db_paid],
  ];
  return pairs
    .filter(([, a, b]) => String(a === null || a === undefined ? '' : a) !==
                          String(b === null || b === undefined ? '' : b))
    .map(([label, a, b]) => `${label}: ${show(a)} ≠ ${show(b)}`)
    .join('، ');
}

let text;
if (!rows.length) {
  text = `✅ *مطابقة* — ${checked} حجز، لا فروق بين الشيت وقاعدة البيانات.`;
} else {
  const missingDb = rows.filter(r => r.problem === 'missing in db');
  const missingSheet = rows.filter(r => r.problem === 'missing in sheet');
  const differs = rows.filter(r => r.problem === 'differs');

  const parts = [`⚠️ *فروق بين الشيت وقاعدة البيانات* — ${rows.length} من ${checked}`, ''];

  if (missingDb.length) {
    parts.push(`❌ *في الشيت وغير موجود في قاعدة البيانات* (${missingDb.length})`);
    parts.push(...missingDb.slice(0, MAX_LINES).map(
      r => `• صف ${r.sheet_row}: ${show(r.sheet_guest)}`));
    parts.push('');
  }
  if (missingSheet.length) {
    parts.push(`❌ *في قاعدة البيانات وغير موجود في الشيت* (${missingSheet.length})`);
    parts.push(...missingSheet.slice(0, MAX_LINES).map(
      r => `• صف ${r.sheet_row}: ${show(r.db_guest)}`));
    parts.push('');
  }
  if (differs.length) {
    parts.push(`✏️ *قيم مختلفة* (${differs.length})`);
    parts.push(...differs.slice(0, MAX_LINES).map(
      r => `• صف ${r.sheet_row} ${show(r.sheet_guest || r.db_guest)} — ${diffs(r)}`));
  }
  if (rows.length > MAX_LINES) {
    // esc() this too: the view name contains an underscore, which Telegram reads
    // as the start of an italic run and then rejects the whole message with a
    // 400. Escaping only the dynamic values is not enough — the literals count.
    parts.push('', `… وغيرها. الفروق كاملة في ${esc('reconcile_bookings')}.`);
  }
  text = parts.join('\n').trim();
}

return [{ json: { chat_id: CHAT_ID, text, parse_mode: 'Markdown' } }];
