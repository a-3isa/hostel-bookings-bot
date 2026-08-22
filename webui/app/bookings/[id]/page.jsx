import { notFound } from 'next/navigation';
import BookingForm, { PAYMENT_METHODS } from '../../../components/BookingForm';
import { addPayment, deletePayment, saveBooking, setCancelled } from '../../actions';
import { one, q } from '../../../lib/db';
import { day, num } from '../../../lib/fmt';

export const dynamic = 'force-dynamic';
// Publishing a booking with two payment rows is several sequential Google
// round trips. The default limit can kill the function AFTER the database has
// committed and part way through the sheet writes.
export const maxDuration = 30;

// Why a sheet write was refused, in the reader's language. `publishBooking`
// leaves the database correct and the sheet stale, and supabase/mirror.py
// repairs it on its next run — so none of these is data loss. They are all "the
// sheet has not caught up yet, and here is why", which is exactly what nobody
// could see before.
const SHEET_REFUSED = {
  'not-configured': 'الاتصال بجوجل شيت غير مضبوط على الخادم.',
  'no-booking': 'لم يُعثر على الحجز عند الكتابة.',
  'no-expense': 'لم يُعثر على المصروف عند الكتابة.',
  'mixed-currency': 'الحجز مدفوع بأكثر من عملة، والشيت له خانة واحدة للمدفوع.',
  unstamped: 'صف الشيت لا يحمل معرف النظام في العمود U.',
  mismatch: 'العمود U في هذا الصف يشير إلى سجل آخر.',
  'no-row': 'لا يوجد صف في الشيت لهذا السجل.',
  empty: 'الصف المستهدف في الشيت فارغ.',
  error: 'تعذّر الاتصال بجوجل شيت.',
};

function SheetNotice({ reason }) {
  if (!reason) return null;
  return (
    <div className="banner">
      <span className="ico">⚠</span>
      <div>
        تم الحفظ في Postgres، لكن <strong>الشيت لم يتغيّر</strong> —{' '}
        {SHEET_REFUSED[reason] ?? 'سبب غير معروف.'}{' '}
        سيُصحّح ذلك عند تشغيل <code>supabase/mirror.py</code>.
      </div>
    </div>
  );
}


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

  // Payments are grouped by currency before anything is compared to
  // `bookings.paid`.
  //
  // The old check summed every payment into one number and held it against the
  // paid cell. For a booking paid 650 كاش and 40 دولار that sum is 690, which is
  // not an amount of anything — there are deliberately no exchange rates in this
  // system — so the banner fired on bookings that were fine and stayed silent on
  // bookings that were not. `paid_label` in schema.sql exists precisely because
  // "650 EGP + 40 USD" is the only honest rendering.
  //
  // So: a single-currency booking is compared exactly as before, and a
  // multi-currency one is not compared at all — it gets the same ⚠ treatment
  // /dashboard and /reports give it, naming what was paid in each currency.
  const byCurrency = new Map();
  for (const p of payments) {
    const cur = (p.currency ?? 'EGP').trim() || 'EGP';
    byCurrency.set(cur, (byCurrency.get(cur) ?? 0) + Number(p.amount || 0));
  }
  const currencies = [...byCurrency.keys()].sort();
  const mixedCurrency = currencies.length > 1;
  const paidLabel = currencies
    .map((cur) => `${num(byCurrency.get(cur))} ${cur}`)
    .join(' + ');

  const paymentsSum = mixedCurrency ? null : (byCurrency.get(currencies[0]) ?? 0);
  const drift = !mixedCurrency && payments.length > 0
    && Math.abs(paymentsSum - Number(booking.paid || 0)) > 0.005;

  return (
    <>
      <p className="muted"><a href="/bookings">← كل الحجوزات</a></p>

      {flags?.saved && (
        <div className="banner good">
          <span className="ico">✓</span>
          <div>تم الحفظ في Postgres وكُتب إلى الشيت.</div>
        </div>
      )}
      <SheetNotice reason={flags?.sheet} />
      {flags?.error === 'amount' && (
        <div className="banner bad"><span className="ico">⚠</span><div>المبلغ غير صالح.</div></div>
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
        {mixedCurrency && (
          <div className="banner bad">
            <span className="ico">⚠</span>
            <div>
              هذا الحجز مدفوع بأكثر من عملة: <strong>{paidLabel}</strong>. خانة
              «إجمالي ما تم دفعه» تحمل {num(booking.paid)} وهي جمع بين عملتين، أي
              رقم بلا وحدة — ولا توجد أسعار صرف في هذا النظام عن قصد، فلا يُقارن
              هنا بشيء. الصحيح هو التفصيل أعلاه.
            </div>
          </div>
        )}
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
            دفعة بطريقة يحملها الحجز بالفعل تُضاف إلى سطرها ويكبر مبلغه. طريقة
            جديدة تفتح سطرًا بنفسجيًا أسفل صف الحجز بمبلغها وطريقتها، ويبقى
            «اجمالي سعر الحجز» كاملًا في صف الحجز بينما يُترك فارغًا في السطر
            الجديد. «متعدد» تظهر في اللوحة فقط لأن معادلات الشيت تقرأ قيم طريقة
            الدفع الحقيقية.
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
