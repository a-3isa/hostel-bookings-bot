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
  for (const node of ['Build Booking Row', 'Build Expense Row', 'Build Edit Row',
                      'Build Line Rows']) {
    try {
      const n = $(node).first().json;
      if (n && n.row_number) return Number(n.row_number);
    } catch (e) { /* did not execute this turn */ }
  }
  return Number(save.row) || null;      // edit and cancel carry it on the payload
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
  // On an open stay the sheet cell is `=<rate>*I{row}`, so sqlNum would make it
  // NULL. The rate itself is what the database stores — `nightly_rate` — and
  // `bookings_live.effective_total` recomputes the running bill from it, which
  // is exactly what the sheet's formula shows.
  const totalRaw = F['اجمالي سعر الحجز'];
  const rateMatch = typeof totalRaw === 'string' && /^=([0-9.]+)\*I/.exec(totalRaw.trim());
  if (rateMatch) {
    cols.push(`nightly_rate = ${rateMatch[1]}`);
    set.push('nightly_rate = excluded.nightly_rate');
    cols.push('total = NULL');
    set.push('total = excluded.total');
  } else {
    put('total', totalRaw, sqlNum(totalRaw));
  }
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

  // ── The payment, as its own row ────────────────────────────────────────────
  //
  // One `payments` row per SHEET LINE, keyed on sheet_row. The sheet has a
  // single cumulative paid cell per line, so that is the most this can honestly
  // record — mirroring it line for line keeps the two in step and stays
  // idempotent on a retry. Individual payments get their own rows after the
  // flip, when the sheet is no longer the one holding the number.
  //
  // Without this the table goes stale the moment it is created: it was
  // backfilled at 09:50 and the first live payment at 09:52 was already missing
  // from it, which `reconcile_payments` duly reported.
  const act = save.payment;
  if (act && Number(act.added)) {
    // ── A payment as an EVENT ────────────────────────────────────────────────
    //
    // The sheet holds one method per row, so a guest paying twice in two
    // methods keeps the running total but loses the first label — confirmed
    // live on row 59, where 'كاش' became 'انستاباي' while the amount added up
    // correctly. This records what was actually paid this time, and how, so the
    // database keeps both and nobody has to insert a row to say it.
    //
    // Its own row, never an upsert on the line: two payments against one line
    // must be two rows. `client_ref` carries the bot's save-lock timestamp, so
    // a double tap converges rather than paying twice.
    const methodSql = sqlStr(act.method);
    sql +=
      ' insert into payments (booking_id, amount, method, currency, receipt_file_id, ' +
      'paid_at, client_ref, source) select coalesce(b.merged_into, b.id), ' +
      `${sqlNum(act.added)}, ${methodSql}, ` +
      `case when ${methodSql} like '%دولار%' then 'USD' ` +
      `when ${methodSql} like '%يورو%' then 'EUR' else 'EGP' end, ` +
      `${sqlStr(save.receiptFileId)}, now(), ${sqlStr(act.ref)}, 'bot' ` +
      `from bookings b where b.sheet_row = ${row} ` +
      'on conflict (client_ref) do nothing;';
  } else if (F['اجمالي ما تم دفعه'] !== undefined) {
    // No payment act on the payload: a correction typed into the paid column,
    // a correction, or a replay of an older session. Fall back to mirroring the
    // line, which is what every row backfilled from the sheet looks like.
    const paidSql = sqlNum(F['اجمالي ما تم دفعه']);
    if (paidSql === 'NULL' || Number(paidSql) === 0) {
      // Paid cleared — a correction. The line no longer records a
      // payment, so neither may the table: both the mirrored line row and any
      // payment acts recorded against that line go.
      //
      // A first payment made at booking time is keyed `new:<guest>:<ms>`, not
      // `<row>:<ms>`, because the row did not exist yet — so zeroing the paid
      // cell of a brand new booking leaves that act behind. The daily
      // reconcile_payments reports it, which is the right place for something
      // this rare to surface rather than a guess made here.
      sql += ` delete from payments where sheet_row = ${row}` +
             ` or client_ref like '${row}:%';`;
    } else {
      // booking_id resolves through merged_into: a continuation line's payment
      // belongs to the booking it continues, not to the line.
      // The method IS the currency: طريقة الدفع = دولار means the amount is
      // dollars. Derived in SQL so it works whether the method came from this
      // edit or fell back to the column.
      const methodExpr =
        F['طريقة الدفع'] === undefined ? 'b.payment_method' : sqlStr(F['طريقة الدفع']);
      sql +=
        ' insert into payments (booking_id, amount, method, currency, receipt_file_id, ' +
        'paid_at, sheet_row, source) select coalesce(b.merged_into, b.id), ' +
        // An edit that changes only the amount leaves the method field absent.
        // Falling back to the column rather than to NULL, because the row was
        // just upserted above and so already holds the current method — writing
        // NULL here would erase how the guest paid.
        `${paidSql}, ${methodExpr}, ` +
        `case when ${methodExpr} like '%دولار%' then 'USD' ` +
        `when ${methodExpr} like '%يورو%' then 'EUR' else 'EGP' end, ` +
        `${sqlStr(save.receiptFileId)}, now(), ` +
        `${row}, 'bot' from bookings b where b.sheet_row = ${row} ` +
        'on conflict (sheet_row) do update set booking_id = excluded.booking_id, ' +
        'amount = excluded.amount, method = excluded.method, ' +
        'currency = excluded.currency, ' +
        'receipt_file_id = coalesce(excluded.receipt_file_id, payments.receipt_file_id), ' +
        'paid_at = excluded.paid_at;';
    }
  }
} else if (flow === 'payment_line') {
  // ── A payment on a line of its own ─────────────────────────────────────────
  //
  // The sheet write has already happened by the time this runs, so the database
  // is being told what the sheet now says, in the same order the sheet learned
  // it:
  //
  //   1. every row from the insert point down moved one row further down. This
  //      goes FIRST and through negative numbers, because sheet_row is UNIQUE
  //      and not deferrable — a single +1 pass collides with a row it has not
  //      reached yet. Skipped entirely when no row was inserted.
  //   2. the line itself, in booking_lines: which method it carries and which
  //      row it occupies. `on conflict` because a second payment in that method
  //      finds the line already there.
  //   3. the payment, as its own row, tagged with the line it belongs to. Never
  //      an upsert on the line — two payments on one line are two rows, which
  //      is the whole reason booking_lines exists.
  //   4. the booking's own total, when the sheet's was reduced to make room for
  //      the line. Left alone when the sheet computes it from a nightly rate.
  const act = save.payment || {};
  const seq = Number(save.lineSeq);
  const method = sqlStr(act.method || save.fields['طريقة الدفع']);
  sql = '';

  if (save.shiftFrom) {
    const from = Number(save.shiftFrom);
    for (const table of ['bookings', 'payments', 'booking_lines']) {
      sql += ` update ${table} set sheet_row = -(sheet_row + 1)` +
             ` where sheet_row >= ${from};` +
             ` update ${table} set sheet_row = -sheet_row where sheet_row < 0;`;
    }
  }

  sql +=
    ' insert into booking_lines (booking_id, line_seq, method, currency, sheet_row)' +
    ` select b.id, ${seq}, ${method},` +
    ` case when ${method} like '%دولار%' then 'USD'` +
    ` when ${method} like '%يورو%' then 'EUR' else 'EGP' end, ${row}` +
    ` from bookings b where b.sheet_row = ${Number(save.bookingRow)}` +
    ' on conflict (booking_id, line_seq) do update set method = excluded.method,' +
    ' currency = excluded.currency, sheet_row = excluded.sheet_row;';

  if (Number(act.added)) {
    sql +=
      ' insert into payments (booking_id, amount, method, currency, line_seq,' +
      ' receipt_file_id, paid_at, client_ref, source) select b.id,' +
      ` ${sqlNum(act.added)}, ${method},` +
      ` case when ${method} like '%دولار%' then 'USD'` +
      ` when ${method} like '%يورو%' then 'EUR' else 'EGP' end, ${seq},` +
      ` ${sqlStr(save.receiptFileId)}, now(), ${sqlStr(act.ref)}, 'bot'` +
      ` from bookings b where b.sheet_row = ${Number(save.bookingRow)}` +
      ' on conflict (client_ref) do nothing;';
  }

  const bf = save.bookingFields || {};
  if (bf['اجمالي سعر الحجز'] !== undefined) {
    sql += ` update bookings set total = ${sqlNum(bf['اجمالي سعر الحجز'])},` +
           ` updated_at = now() where sheet_row = ${Number(save.bookingRow)};`;
  }
  sql = sql.trim();
} else if (flow === 'expense') {
  sql =
    'insert into expenses (sheet_row, expense_ref, item, amount, apartment_id, ' +
    'apartment_name, notes, payment_method, responsible, receipt_file_id, spent_at, ' +
    'source) values (' +
    `${row}, ${sqlStr(plain(F['الرقم']))}, ${sqlStr(F['البند'])}, ${sqlNum(F['المبلغ'])}, ` +
    // Resolved in SQL rather than here: the bot offers the apartment list from
    // the same الإتاحة tab the registry is seeded from, so the name matches. If
    // it ever does not, the reference is simply NULL and the name still records
    // what was chosen.
    `(select id from apartments where name = ${sqlStr(F['الشقة'])}), ` +
    `${sqlStr(F['الشقة'])}, ${sqlStr(F['ملاحظات'])}, ${sqlStr(F['طريقة الدفع'])}, ` +
    `${sqlStr(F['اسم المسئول'])}, ${sqlStr(save.receiptFileId)}, ` +
    `${sqlStr(F['تاريخ'])}::timestamptz, 'bot') ` +
    'on conflict (sheet_row) do update set expense_ref = excluded.expense_ref, ' +
    'item = excluded.item, amount = excluded.amount, ' +
    'apartment_id = excluded.apartment_id, ' +
    'apartment_name = excluded.apartment_name, notes = excluded.notes, ' +
    'payment_method = excluded.payment_method, responsible = excluded.responsible, ' +
    'receipt_file_id = excluded.receipt_file_id, spent_at = excluded.spent_at;';
}

if (!sql) return [];
return [{ json: { sheet_row: row, flow, sql } }];
