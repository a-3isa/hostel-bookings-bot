import { notFound } from 'next/navigation';
import BookingForm, { PAYMENT_METHODS } from '../../../components/BookingForm';
import { addPayment, deletePayment, saveBooking, setCancelled } from '../../actions';
import { one, q } from '../../../lib/db';
import { day, num } from '../../../lib/fmt';

export const dynamic = 'force-dynamic';

// What happened to the sheet when a second payment was recorded.
const LINE = {
  added: null, // handled separately, it is the good case
  'no-row': 'هذا الحجز ليس له صف في الشيت',
  unstamped: 'صف الشيت لا يحمل معرف النظام في العمود U',
  mismatch: 'العمود U في ذلك الصف يشير إلى حجز آخر',
  'sheets-config': 'الاتصال بجوجل شيت غير مضبوط على الخادم',
  'sheets-error': 'تعذر الوصول إلى جوجل شيت',
};

export default async function EditBooking({ params, searchParams }) {
  const { id } = await params;
  const flags = await searchParams;
  const bookingId = Number(id);
  if (!Number.isInteger(bookingId)) notFound();

  const booking = await one('select * from bookings_live where id = $1', [bookingId]);
  if (!booking) notFound();

  const [rooms, payments, audit, overlaps, related, stays] = await Promise.all([
    q(`select r.id, r.number, a.name as apartment
         from rooms r join apartments a on a.id = r.apartment_id
        where r.active and a.active
        order by a.name, r.number`),
    q('select * from payments where booking_id = $1 order by paid_at, id', [bookingId]),
    q(`select changed_by, changed_at from booking_audit
        where booking_id = $1 order by changed_at desc limit 5`, [bookingId]),
    q(`select * from booking_overlaps
        where booking_id = $1 or other_booking_id = $1`, [bookingId]),
    // Same guest, other stays. guest_ref is not unique in this data, so match on
    // it OR the phone number and let the page show what it finds.
    q(`select id, guest_name, arrival, departure, effective_total, effective_remaining
         from bookings_live
        where id <> $1
          and ((guest_ref is not null and guest_ref = $2)
            or (phone is not null and phone = $3))
        order by arrival desc nulls last limit 8`,
      [bookingId, booking.guest_ref, booking.phone]),
    q(`select s.seq, s.apartment_name, s.room_number, s.from_date, s.nights,
              s.open_ended, s.nightly_rate, s.note
         from booking_stays s where s.booking_id = $1 order by s.seq`, [bookingId]),
  ]);

  const paymentsSum = payments.reduce((total, p) => total + Number(p.amount || 0), 0);
  const drift = payments.length > 0 && Math.abs(paymentsSum - Number(booking.paid || 0)) > 0.005;

  return (
    <>
      <p className="muted"><a href="/bookings">← كل الحجوزات</a></p>

      {flags?.saved && (
        <div className="banner good">
          <span className="ico">✓</span><div>تم الحفظ في Postgres. الشيت لم يتغير.</div>
        </div>
      )}
      {flags?.error === 'amount' && (
        <div className="banner bad"><span className="ico">⚠</span><div>المبلغ غير صالح.</div></div>
      )}
      {flags?.line === 'added' && (
        <div className="banner good">
          <span className="ico">✓</span>
          <div>
            تمت إضافة الدفعة، وأُدرج سطر جديد في الشيت أسفل صف الحجز بالمبلغ وطريقة
            الدفع الجديدة. خانة طريقة الدفع في صف الحجز لم تتغير — «متعدد» تظهر في
            اللوحة فقط.
          </div>
        </div>
      )}
      {flags?.line && flags.line !== 'added' && (
        <div className="banner">
          <span className="ico">ℹ</span>
          <div>
            سُجّلت الدفعة في قاعدة البيانات فقط — {LINE[flags.line] ?? 'تعذر التحقق من صف الشيت'}.
            لم يُدرج سطر في الشيت.
          </div>
        </div>
      )}
      {overlaps.length > 0 && (
        <div className="banner bad">
          <span className="ico">⚠</span>
          <div>
            الغرفة محجوزة لضيف آخر في نفس المدة:{' '}
            {overlaps.map((o, i) => {
              const otherId = String(o.booking_id) === String(bookingId)
                ? o.other_booking_id : o.booking_id;
              const otherName = String(o.booking_id) === String(bookingId)
                ? o.other_guest : o.guest;
              return (
                <span key={otherId}>
                  {i > 0 && ' · '}
                  <a href={`/bookings/${otherId}`}>{otherName ?? `#${otherId}`}</a>
                </span>
              );
            })}
            <span className="faint"> — تقرير وليس منعًا، قد يكون تغيير غرفة مقصودًا.</span>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="row">
          <h2 style={{ margin: 0 }}>
            {booking.guest_name ?? 'بدون اسم'}{' '}
            <span className="muted">
              ID {booking.guest_ref ?? '—'} · صف الشيت {booking.sheet_row ?? '—'}
            </span>
          </h2>
          <span className="spacer" />
          {booking.cancelled_at ? (
            <form action={setCancelled.bind(null, bookingId, false)}>
              <button className="ghost" type="submit">إلغاء الإلغاء</button>
            </form>
          ) : (
            <form action={setCancelled.bind(null, bookingId, true)}>
              <button className="ghost" type="submit">إلغاء الحجز</button>
            </form>
          )}
          <a className="btn danger" href={`/bookings/${bookingId}/delete`}>حذف</a>
        </div>

        {booking.cancelled_at && (
          <p className="muted">ملغي في {day(booking.cancelled_at)}.</p>
        )}
        {booking.merged_into && (
          <p className="muted">هذا سطر تابع للحجز رقم {booking.merged_into}.</p>
        )}

        <div className="kpis" style={{ marginTop: 14 }}>
          <div className="kpi">
            <div className="label">الليالي المحسوبة</div>
            <div className="value">{booking.effective_nights ?? '—'}</div>
          </div>
          <div className="kpi">
            <div className="label">الإجمالي المحسوب</div>
            <div className="value">{num(booking.effective_total)}</div>
          </div>
          <div className="kpi">
            <div className="label">المتبقي</div>
            <div className="value owing">{num(booking.effective_remaining)}</div>
          </div>
          <div className="kpi">
            <div className="label">المغادرة</div>
            <div className="value" style={{ fontSize: 18 }}>{day(booking.departure)}</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>بيانات الحجز</h2>
        <BookingForm
          action={saveBooking.bind(null, bookingId)}
          rooms={rooms}
          booking={booking}
          submitLabel="حفظ"
        />
      </div>

      <div className="panel">
        <h2>الدفعات</h2>
        {drift && (
          <div className="banner">
            مجموع الدفعات {num(paymentsSum)} بينما خانة «إجمالي ما تم دفعه»{' '}
            {num(booking.paid)}. الخانة هي ما يقارنه تقرير المطابقة بالشيت، فلم
            تُحدَّث تلقائيًا — عدّلها بنفسك إن كان الفرق مقصودًا.
          </div>
        )}

        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>التاريخ</th>
                <th className="num">المبلغ</th>
                <th>العملة</th>
                <th>الطريقة</th>
                <th>صف الشيت</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td>{day(p.paid_at)}</td>
                  <td className="num">{num(p.amount)}</td>
                  <td>{p.currency}</td>
                  <td>{p.method ?? '—'}</td>
                  <td className="num">{p.sheet_row ?? '—'}</td>
                  <td>
                    <form action={deletePayment.bind(null, bookingId, p.id)}>
                      <button className="ghost" type="submit">حذف</button>
                    </form>
                  </td>
                </tr>
              ))}
              {payments.length === 0 && (
                <tr><td colSpan={6} className="muted">لا توجد دفعات مسجلة.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={addPayment.bind(null, bookingId)} style={{ marginTop: 14 }}>
          <div className="grid">
            <label className="field">
              المبلغ
              <input name="amount" inputMode="decimal" required />
            </label>
            <label className="field">
              العملة
              <select name="currency" defaultValue="EGP">
                <option value="EGP">EGP</option>
                <option value="USD">USD</option>
              </select>
            </label>
            <label className="field">
              الطريقة
              <select name="method" defaultValue="">
                <option value="">—</option>
                {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="field">
              التاريخ
              <input type="datetime-local" name="paid_at" />
            </label>
          </div>
          <p className="muted">
            الدفعة الثانية فأكثر تُدرج سطرًا جديدًا في الشيت أسفل صف الحجز بالمبلغ
            وطريقة الدفع الجديدة. خانات صف الحجز نفسها لا تتغير، و«متعدد» تظهر في
            اللوحة فقط لأن معادلات الشيت تقرأ قيم طريقة الدفع الحقيقية.
          </p>
          <p><button type="submit">إضافة دفعة</button></p>
        </form>
      </div>

      {stays.length > 1 && (
        <div className="panel flush">
          <h2>مراحل الإقامة <span className="count">تغيير غرفة أو سعر</span></h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>الشقة / الغرفة</th>
                  <th>من</th>
                  <th className="num">ليالٍ</th>
                  <th className="num">سعر الليلة</th>
                  <th>ملاحظة</th>
                </tr>
              </thead>
              <tbody>
                {stays.map((s) => (
                  <tr key={s.seq}>
                    <td className="id">{s.seq}</td>
                    <td>{[s.apartment_name, s.room_number].filter(Boolean).join(' / ') || '—'}</td>
                    <td>{day(s.from_date)}</td>
                    <td className="num">{s.open_ended ? 'مفتوحة' : (s.nights ?? '—')}</td>
                    <td className="num">{num(s.nightly_rate)}</td>
                    <td className="faint">{s.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {related.length > 0 && (
        <div className="panel flush">
          <h2>إقامات أخرى لنفس الضيف <span className="count">{related.length}</span></h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>الضيف</th>
                  <th>الوصول</th>
                  <th>المغادرة</th>
                  <th className="num">الإجمالي</th>
                  <th className="num">المتبقي</th>
                </tr>
              </thead>
              <tbody>
                {related.map((r) => (
                  <tr key={r.id}>
                    <td className="id">{r.id}</td>
                    <td><a href={`/bookings/${r.id}`}>{r.guest_name ?? '—'}</a></td>
                    <td>{day(r.arrival)}</td>
                    <td>{day(r.departure)}</td>
                    <td className="num">{num(r.effective_total)}</td>
                    <td className="num">{num(r.effective_remaining)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {audit.length > 0 && (
        <div className="panel">
          <h2>آخر التعديلات</h2>
          <ul className="muted">
            {audit.map((a, i) => (
              <li key={i}>{day(a.changed_at)} — {a.changed_by ?? 'غير معروف'}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
