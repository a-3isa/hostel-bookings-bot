/**
 * The `payment_line` flow: a payment in a method the booking's own row does not
 * carry. Emits the body of ONE Google Sheets `values:batchUpdate` call.
 *
 * Up to two rows are written, and both are updates — nothing here appends:
 *
 *   1. the LINE. Either a row this branch has just inserted under the booking's
 *      block, or one that already carries this method and whose paid cell
 *      simply grows.
 *   2. the BOOKING's own row, when something on it changed in the same session.
 *      Absent when nothing did. Its اجمالي سعر الحجز is NOT among the changes —
 *      the agreed price stays whole there and the line leaves that cell blank.
 *
 * ## Why this builds a request body instead of rows
 *
 * It used to emit one item per row for a `googleSheets` update node. Measured
 * live on 2026-08-20, execution 1937: that node took **32,618 ms** of a 36,870 ms
 * turn — 88% of it — while every other node in the same execution finished
 * inside 450 ms. The receptionist watched a spinner for 37 seconds and tapped
 * Save again during the wait.
 *
 * The node has to FIND each row before it can write it: it reads the tab,
 * matching on `row_number`, and that read makes Google recalculate a workbook
 * carrying GOOGLEFINANCE calls and per-apartment FILTER(UNIQUE(…)) over
 * unbounded ranges. The same execution wrote column U through a plain HTTP node
 * in 287 ms. Nothing needs finding here — the row number is known and so is
 * every column — so this addresses the cells outright, exactly as
 * `values_put_id` does, and the whole write becomes one request.
 *
 * ## One range per field, deliberately
 *
 * Not one range per row. A row's changed fields are not contiguous — the
 * booking's own row often changes عدد الليالي and nothing else — and a
 * contiguous block write would blank every cell between the ones it meant to
 * set. A per-field range also means a column that is not named here is not
 * touched at all, which is what keeps K, N, P, R, S and T safe: they are sheet
 * formulas, and writing one — even an empty string — destroys it. They have no
 * entry in COLUMN below, so no range can ever address them.
 *
 * معرف النظام is likewise absent: "Write Line Id" writes column U afterwards in
 * its own request, for the same reason this node exists at all.
 */

const save = $('Brain').first().json.save;

/**
 * Header name -> column letter, for إدخال الحجوزات.
 *
 * The formula columns are missing on purpose and must stay missing:
 *   K تاريخ المغادرة   N نسبة البرنامج   P المتبقي
 *   R تاريخ الإدخال    S صافي الدخل      T آخر تعديل
 * E الجنسية is retired and left exactly as found. U is written elsewhere.
 */
const COLUMN = {
  'بوكنج ID': 'A',
  'ID': 'B',
  'اسم المقيم': 'C',
  'نوع الحجز': 'D',
  'رقم الهاتف': 'F',
  'اسم الشقة': 'G',
  'رقم الغرفة': 'H',
  'عدد الليالي': 'I',
  'تاريخ البداية': 'J',
  'اجمالي سعر الحجز': 'L',
  'اجمالي ما تم دفعه': 'M',
  'طريقة الدفع': 'O',
  'ملاحظات': 'Q',
};

const TAB = $('Config').first().json.BOOKINGS_TAB;
const data = [];

/** Add one field of one row, if it is a column this bot owns. */
function put(row, header, value) {
  const col = COLUMN[header];
  if (!col) return;                    // a formula column, or one we do not write
  // '=TODAY()-J{r}' on an open-ended stay: the row counts its own nights from
  // its OWN row, so {r} is this row and never the booking's.
  const v = typeof value === 'string' ? value.replace(/\{r\}/g, String(row)) : value;
  data.push({
    range: `'${TAB.replace(/'/g, "''")}'!${col}${row}`,
    values: [[v === undefined || v === null ? '' : v]],
  });
}

for (const header of Object.keys(save.fields || {})) {
  put(save.row, header, save.fields[header]);
}

if (save.bookingFields && Object.keys(save.bookingFields).length) {
  for (const header of Object.keys(save.bookingFields)) {
    put(save.bookingRow, header, save.bookingFields[header]);
  }
}

// One item, one request. Downstream nodes that only care that the write
// happened — Has Group?, Write Line Id — no longer see an item per row, which
// is what used to make them run twice.
return [{ json: { data, rows: data.length ? 1 : 0 } }];
