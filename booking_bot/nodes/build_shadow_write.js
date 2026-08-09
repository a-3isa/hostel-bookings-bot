/**
 * Turns a completed sheet write into one Postgres upsert — the "Build Shadow
 * Write" Code node.
 *
 * This runs only after the spreadsheet write has already succeeded, and its
 * output feeds a Postgres node whose onError is `continueRegularOutput`. During
 * the trust period the sheet is authoritative and Supabase is a shadow copy, so
 * the rule is absolute: **nothing here may fail a booking**. If Supabase is
 * down, asleep, or wrong, the receptionist still sees the normal ✅ and the
 * daily reconcile reports the missing row.
 *
 * Keyed on `sheet_row`, so a retry or a replay converges instead of duplicating.
 *
 * The row number lives on whichever Build * Row node ran, and referencing a node
 * that did not execute throws — hence the try/catch ladder, the same trick
 * brain.js uses for its gated Sheets reads.
 */

const brain = $('Brain').first().json;
const save = brain.save || {};

/** The row the sheet write actually landed on. */
function sheetRow() {
  for (const node of ['Build Booking Row', 'Build Expense Row', 'Build Edit Row']) {
    try {
      const n = $(node).first().json;
      if (n && n.row_number) return Number(n.row_number);
    } catch (e) { /* did not execute this turn */ }
  }
  return Number(save.row) || null;      // edit/cancel/undo carry it on the payload
}

const row = sheetRow();
if (!row) return [];                    // nothing identifiable to mirror

function sqlStr(v) {
  if (v === undefined || v === null || v === '') return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function sqlNum(v) {
  if (v === undefined || v === null || v === '') return 'NULL';
  // The sheet stores IDs and phones text-forced with a leading apostrophe.
  const n = Number(String(v).replace(/^'/, '').replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : 'NULL';
}

/** Strip the ' that forces Sheets to keep leading zeros. */
function plain(v) {
  return v === undefined || v === null ? '' : String(v).replace(/^'/, '');
}

const F = save.fields || {};
const flow = save.flow;
let sql = null;

if (flow === 'booking' || flow === 'edit' || flow === 'cancel') {
  // An open-ended stay is the one case where عدد الليالي holds a formula rather
  // than a number. That is exactly what `open_ended` records, so the database
  // never has to tell the two apart by reading the cell twice.
  const nightsRaw = F['عدد الليالي'];
  const isOpen = typeof nightsRaw === 'string' && nightsRaw.trim().startsWith('=');
  const cols = [];
  const set = [];

  function put(col, value, quoted) {
    if (value === undefined) return;
    cols.push(`${col} = ${quoted}`);
    set.push(`${col} = excluded.${col}`);
  }

  put('booking_ref', F['بوكنج ID'], sqlStr(plain(F['بوكنج ID'])));
  put('guest_ref', F['ID'], sqlStr(plain(F['ID'])));
  put('guest_name', F['اسم المقيم'], sqlStr(F['اسم المقيم']));
  put('booking_type', F['نوع الحجز'], sqlStr(F['نوع الحجز']));
  put('phone', F['رقم الهاتف'], sqlStr(plain(F['رقم الهاتف'])));
  put('apartment_name', F['اسم الشقة'], sqlStr(F['اسم الشقة']));
  put('room_number', F['رقم الغرفة'], sqlStr(F['رقم الغرفة']));
  put('arrival', F['تاريخ البداية'], `${sqlStr(F['تاريخ البداية'])}::date`);
  if (nightsRaw !== undefined) {
    cols.push(`nights = ${isOpen ? 'NULL' : sqlNum(nightsRaw)}`);
    set.push('nights = excluded.nights');
    cols.push(`open_ended = ${isOpen ? 'true' : 'false'}`);
    set.push('open_ended = excluded.open_ended');
  }
  put('total', F['اجمالي سعر الحجز'], sqlNum(F['اجمالي سعر الحجز']));
  put('paid', F['اجمالي ما تم دفعه'], `coalesce(${sqlNum(F['اجمالي ما تم دفعه'])}, 0)`);
  put('payment_method', F['طريقة الدفع'], sqlStr(F['طريقة الدفع']));
  put('notes', F['ملاحظات'], sqlStr(F['ملاحظات']));

  if (save.receiptFileId) {
    cols.push(`receipt_file_id = ${sqlStr(save.receiptFileId)}`);
    set.push('receipt_file_id = excluded.receipt_file_id');
  }
  if (flow === 'cancel') {
    cols.push('cancelled_at = now()');
    set.push('cancelled_at = excluded.cancelled_at');
  }
  if (brain.actor || save.actor) {
    cols.push(`created_by = ${sqlStr(brain.actor || save.actor)}`);
  }

  if (!cols.length) return [];
  const names = cols.map(c => c.split(' = ')[0]);
  const values = cols.map(c => c.slice(c.indexOf(' = ') + 3));
  sql =
    `insert into bookings (sheet_row, ${names.join(', ')}, source) values ` +
    `(${row}, ${values.join(', ')}, 'bot') ` +
    `on conflict (sheet_row) do update set ${set.join(', ')}, updated_at = now();`;
} else if (flow === 'expense') {
  sql =
    'insert into expenses (sheet_row, expense_ref, item, amount, apartment_name, notes, ' +
    'payment_method, responsible, receipt_file_id, spent_at, source) values (' +
    `${row}, ${sqlStr(plain(F['الرقم']))}, ${sqlStr(F['البند'])}, ${sqlNum(F['المبلغ'])}, ` +
    `${sqlStr(F['الشقة'])}, ${sqlStr(F['ملاحظات'])}, ${sqlStr(F['طريقة الدفع'])}, ` +
    `${sqlStr(F['اسم المسئول'])}, ${sqlStr(save.receiptFileId)}, ` +
    `${sqlStr(F['تاريخ'])}::timestamptz, 'bot') ` +
    'on conflict (sheet_row) do update set expense_ref = excluded.expense_ref, ' +
    'item = excluded.item, amount = excluded.amount, ' +
    'apartment_name = excluded.apartment_name, notes = excluded.notes, ' +
    'payment_method = excluded.payment_method, responsible = excluded.responsible, ' +
    'receipt_file_id = excluded.receipt_file_id, spent_at = excluded.spent_at;';
}

if (!sql) return [];
return [{ json: { sheet_row: row, flow, sql } }];
