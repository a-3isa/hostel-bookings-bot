/**
 * Snapshot the spreadsheet into `sheet_snapshot` — the "Build Snapshot SQL" node.
 *
 * Runs on the daily schedule branch, reusing the two reads the reports already
 * do. Emits one statement: replace the snapshot wholesale, inside a transaction,
 * so the reconcile that follows can never see a half-loaded table.
 *
 * The snapshot records what the SHEET currently shows — evaluated numbers, not
 * formulas. `reconcile_bookings` then compares that against `bookings_live`,
 * whose effective_* columns reproduce the same arithmetic from the database
 * side. Any difference is a real one.
 */

const rows = $input.all().map(i => i.json);

// Which rows are open-ended, from the FORMULA read. Not used to change what is
// stored — the snapshot is deliberately "what the sheet says" — but a row whose
// عدد الليالي is a formula has an evaluated night count that the database models
// as NULL + open_ended, and bookings_live turns that back into the same number.
const openByRow = {};
for (const i of $('Read Report Formulas').all()) {
  const j = i.json || {};
  openByRow[String(j.row_number)] =
    String(j['عدد الليالي'] === undefined ? '' : j['عدد الليالي']).trim().startsWith('=');
}

function s(v) {
  if (v === undefined || v === null || v === '') return 'NULL';
  return `'${String(v).replace(/^'/, '').replace(/'/g, "''")}'`;
}

function n(v) {
  if (v === undefined || v === null || v === '') return 'NULL';
  const x = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(x) ? String(x) : 'NULL';
}

const values = [];
for (const j of rows) {
  const name = String(j['اسم المقيم'] || '').trim();
  if (!name) continue;                     // formula-only tail rows
  const row = Number(j.row_number);
  if (!row) continue;
  // Column U — the booking's database id, written by the bot and by
  // reindex.py. This is what lets the reconcile key on the BOOKING instead of
  // the row it happens to occupy: inserting a row renumbers everything beneath
  // it, and keying on sheet_row reported forty of those as differences once.
  // Blank on a row nobody has stamped yet, and the reconcile falls back to
  // sheet_row for those.
  values.push(
    `(${row}, ${s(name)}, ${s(j['اسم الشقة'])}, ${s(j['رقم الغرفة'])}, ` +
    `${s(j['تاريخ البداية'])}::date, ${n(j['عدد الليالي'])}, ` +
    `${n(j['اجمالي سعر الحجز'])}, ${n(j['اجمالي ما تم دفعه'])}, ` +
    `${s(j['طريقة الدفع'])}, ${s(j['ملاحظات'])}, ${n(j['معرف النظام'])})`
  );
}

if (!values.length) return [];             // never blank the snapshot on a bad read

const sql =
  'begin; delete from sheet_snapshot; ' +
  'insert into sheet_snapshot (sheet_row, guest_name, apartment_name, room_number, ' +
  'arrival, nights, total, paid, payment_method, notes, booking_id) values ' +
  values.join(', ') + '; commit;';

return [{ json: { rows: values.length, open_rows: Object.values(openByRow).filter(Boolean).length, sql } }];
