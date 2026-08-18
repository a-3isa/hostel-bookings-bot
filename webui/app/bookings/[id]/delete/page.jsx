import { notFound } from 'next/navigation';
import { one } from '../../../../lib/db';
import { checkRow, sheetsConfigured } from '../../../../lib/sheets';
import { day, num } from '../../../../lib/fmt';

export const dynamic = 'force-dynamic';

const ERRORS = {
  followers: 'لم يُحذف: ما زالت هناك سطور تابعة مرتبطة بهذا الحجز.',
  'no-row': 'لم يُحذف: هذا الحجز ليس له صف في الشيت.',
  unstamped: 'لم يُحذف: صف الشيت لا يحمل معرف النظام في العمود U.',
  mismatch: 'لم يُحذف: العمود U في هذا الصف يشير إلى حجز آخر.',
  'sheets-config': 'لم يُحذف: الاتصال بجوجل شيت غير مضبوط على الخادم.',
  'sheets-error': 'لم يُحذف: فشل الاتصال بجوجل شيت. لم يتغير شيء في قاعدة البيانات.',
};

// A confirmation step, not a modal: the delete button in the table links here,
// so a mis-click costs a page load rather than a booking and a sheet row.
export default async function DeleteBooking({ params, searchParams }) {
  const { id } = await params;
  const flags = await searchParams;
  const bookingId = Number(id);
  if (!Number.isInteger(bookingId)) notFound();

  const booking = await one('select * from bookings_live where id = $1', [bookingId]);
  if (!booking) notFound();

  const counts = await one(
    `select
       (select count(*)::int from payments      where booking_id = $1) as payments,
       (select count(*)::int from booking_stays where booking_id = $1) as stays,
       (select count(*)::int from booking_audit where booking_id = $1) as audit,
       (select count(*)::int from bookings      where merged_into = $1) as followers,
       (select count(*)::int from booking_lines where booking_id = $1
                                                  and sheet_row is not null) as lines,
       (select count(*)::int from bookings      where sheet_row > $2) as rows_below`,
    [bookingId, booking.sheet_row ?? 0],
  );

  // A booking paid in two methods occupies more than one row, and all of them
  // go — the booking's own and every continuation line under it. Counted here
  // so the confirmation says how many BEFORE the button is pressed.
  const sheetRows = sheet.ok ? 1 + counts.lines : 0;

  // The same check the POST handler runs, done here so the answer is on screen
  // before anyone presses the button rather than after.
  let sheet = { ok: false, reason: 'sheets-config' };
  if (sheetsConfigured()) {
    try {
      sheet = booking.sheet_row === null
        ? { ok: false, reason: 'no-row' }
        : await checkRow(Number(booking.sheet_row), bookingId);
    } catch (err) {
      sheet = { ok: false, reason: 'sheets-error', message: String(err.message) };
    }
  }

  // Only a continuation line blocks outright — that one is a foreign key that
  // would fail anyway. An unverifiable sheet row just narrows the delete to the
  // database.
  const blocked = counts.followers > 0;

  return (
    <>
      <p className="muted"><a href={`/bookings/${bookingId}`}>← رجوع للحجز</a></p>

      <div className="panel" style={{ maxWidth: 760 }}>
        <h2>حذف الحجز من قاعدة البيانات ومن الشيت؟</h2>

        <div className="banner bad">
          <span className="ico">⚠</span>
          <div>
            الحذف <strong>لا يمكن التراجع عنه</strong>، ولا يمر عبر سجل التعديلات —
            سجل الحجز نفسه يُحذف معه، فلن يفيد <code>/undo</code> بعده. إن كان
            المطلوب هو إلغاء الحجز فقط، استخدم «إلغاء الحجز» بدل الحذف.
          </div>
        </div>

        {flags?.error && ERRORS[flags.error] && (
          <div className="banner bad">
            <span className="ico">⚠</span><div>{ERRORS[flags.error]}</div>
          </div>
        )}

        <ul className="list">
          <li><span className="faint">ID</span><span>{booking.guest_ref ?? '—'}</span></li>
          <li><span className="faint">الضيف</span><span>{booking.guest_name ?? '—'}</span></li>
          <li>
            <span className="faint">الشقة / الغرفة</span>
            <span>{[booking.apartment_name, booking.room_number].filter(Boolean).join(' / ') || '—'}</span>
          </li>
          <li><span className="faint">الوصول</span><span>{day(booking.arrival)}</span></li>
          <li>
            <span className="faint">الإجمالي / المدفوع</span>
            <span>{num(booking.effective_total)} / {num(booking.paid)}</span>
          </li>
          <li><span className="faint">صف الشيت</span><span>{booking.sheet_row ?? '—'}</span></li>
        </ul>

        <h2 style={{ marginTop: 18 }}>التحقق من صف الشيت</h2>
        {sheet.ok ? (
          <div className="banner good">
            <span className="ico">✓</span>
            <div>
              الصف {booking.sheet_row} في تبويب «إدخال الحجوزات» يحمل معرف النظام{' '}
              <strong>{bookingId}</strong> باسم «{sheet.found?.guestName ?? '—'}» — مطابق،
              وسيُحذف.
            </div>
          </div>
        ) : (
          <div className="banner bad">
            <span className="ico">⚠</span>
            <div>
              {ERRORS[sheet.reason] ?? 'تعذر التحقق من صف الشيت.'}
              {sheet.found?.bookingId && (
                <> العمود U في الصف {booking.sheet_row} يقول{' '}
                  <strong>{sheet.found.bookingId}</strong>
                  {sheet.found.guestName && <> باسم «{sheet.found.guestName}»</>}.
                </>
              )}
              {sheet.message && <div className="faint">{sheet.message}</div>}
              <div className="faint">
                سيُحذف من قاعدة البيانات فقط، ولن يُمس أي صف في الشيت — بدون تطابق
                العمود U قد يكون هذا الصف لضيف آخر.
              </div>
            </div>
          </div>
        )}

        <p className="muted">سيُحذف معه:</p>
        <ul className="list">
          <li>
            <span>
              {sheet.ok
                ? (sheetRows === 1
                    ? 'صف واحد من تبويب «إدخال الحجوزات»'
                    : `${sheetRows} صفوف من تبويب «إدخال الحجوزات» — صف الحجز و${counts.lines} صف دفعة تحته`)
                : 'لا شيء من الشيت — الحذف من قاعدة البيانات فقط'}
            </span>
          </li>
          <li><span>{counts.payments} دفعة</span></li>
          <li><span>{counts.stays} مرحلة إقامة</span></li>
          <li><span>{counts.audit} سطر في سجل التعديلات</span></li>
        </ul>

        {counts.followers > 0 && (
          <div className="banner bad">
            <span className="ico">⚠</span>
            <div>
              لا يمكن الحذف: {counts.followers} سطر تابع يشير إلى هذا الحجز. احذف
              السطور التابعة أولًا، أو ألغِ الحجز بدل حذفه.
            </div>
          </div>
        )}

        {sheet.ok && counts.rows_below > 0 && (
          <div className="banner">
            <span className="ico">ℹ</span>
            <div>
              حذف صف من الشيت يرفع كل الصفوف تحته صفًا واحدًا، لذلك سيُعاد ترقيم
              «صف الشيت» لـ {counts.rows_below} حجزًا أسفله في قاعدة البيانات
              تلقائيًا. لقطة المطابقة ستظل قديمة حتى تشغيل
              <code>backfill.py --reconcile</code>.
            </div>
          </div>
        )}

        {/* A div, not a p: a <form> inside a <p> is invalid HTML, and the browser
            hoists it out of the paragraph, which breaks hydration. */}
        <div className="row" style={{ marginTop: 16 }}>
          <a className="btn ghost" href={`/bookings/${bookingId}`}>رجوع</a>
          {!blocked && (
            <form method="post" action={`/bookings/${bookingId}/delete/confirm`}>
              <button className="danger" type="submit">
                {sheet.ok ? 'نعم، احذف من الاثنين' : 'نعم، احذف من قاعدة البيانات'}
              </button>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
