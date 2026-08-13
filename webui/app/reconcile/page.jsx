import { q } from '../../lib/db';
import { day, num } from '../../lib/fmt';
import { Empty } from '../../components/ui';

export const dynamic = 'force-dynamic';

// The views on this page are the whole point of the shadow period: they answer
// "does the database still agree with the sheet?". They exist already and the
// daily job posts them to Telegram; this is the same answer, browsable.
export default async function Reconcile() {
  const [sheetDiffs, paymentDiffs, overlaps, mixed, [meta]] = await Promise.all([
    q('select * from reconcile_bookings order by sheet_row limit 200'),
    q('select * from reconcile_payments order by booking_id limit 200'),
    q('select * from booking_overlaps order by apartment_name, room_number, arrival limit 200'),
    q('select * from mixed_currency_bookings order by id limit 200'),
    q(`select max(captured_at) as snapshot_at, count(*)::int as rows from sheet_snapshot`),
  ]);

  const clean = sheetDiffs.length === 0 && paymentDiffs.length === 0;

  return (
    <>
      <div className={`banner ${clean ? 'good' : 'bad'}`}>
        <span className="ico">{clean ? '✓' : '⚠'}</span>
        <div>
          {clean
            ? 'الشيت وقاعدة البيانات متطابقان في الحجوزات والدفعات.'
            : `${sheetDiffs.length} فرق في الحجوزات و${paymentDiffs.length} في الدفعات.`}
          {meta.snapshot_at && (
            <span className="faint">
              {' '}اللقطة المقارَنة: {meta.rows} صف، التُقطت {day(meta.snapshot_at)}.
            </span>
          )}
        </div>
      </div>

      <p className="muted">
        المقارنة تتم مع آخر لقطة مخزّنة للشيت، وليس مع الشيت مباشرةً. لقطة قديمة
        تعني نتيجة قديمة — شغّل <code>backfill.py --reconcile</code> لتحديثها.
      </p>

      <div className="panel flush">
        <h2>فروق الحجوزات <span className="count">{sheetDiffs.length}</span></h2>
        {sheetDiffs.length === 0 ? <Empty>لا توجد فروق.</Empty> : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>الصف</th>
                  <th>المشكلة</th>
                  <th>الضيف (شيت / DB)</th>
                  <th>الشقة</th>
                  <th>الوصول</th>
                  <th className="num">الإجمالي</th>
                  <th className="num">المدفوع</th>
                </tr>
              </thead>
              <tbody>
                {sheetDiffs.map((r) => (
                  <tr key={r.sheet_row}>
                    <td className="num">{r.sheet_row}</td>
                    <td><span className="tag owing">{r.problem}</span></td>
                    <td>{r.sheet_guest ?? '—'} / {r.db_guest ?? '—'}</td>
                    <td>{r.sheet_apt ?? '—'} / {r.db_apt ?? '—'}</td>
                    <td>{day(r.sheet_arrival)} / {day(r.db_arrival)}</td>
                    <td className="num">{num(r.sheet_total)} / {num(r.db_total)}</td>
                    <td className="num">{num(r.sheet_paid)} / {num(r.db_paid)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel flush">
        <h2>فروق الدفعات <span className="count">{paymentDiffs.length}</span></h2>
        {paymentDiffs.length === 0 ? <Empty>لا توجد فروق.</Empty> : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>الضيف</th>
                  <th>صفوف الشيت</th>
                  <th className="num">مدفوع بالشيت</th>
                  <th className="num">مجموع الدفعات</th>
                  <th className="num">عدد</th>
                </tr>
              </thead>
              <tbody>
                {paymentDiffs.map((r) => (
                  <tr key={r.booking_id}>
                    <td className="id">{r.booking_id}</td>
                    <td><a href={`/bookings/${r.booking_id}`}>{r.guest_name ?? '—'}</a></td>
                    <td className="faint">{String(r.sheet_rows ?? '')}</td>
                    <td className="num">{num(r.sheet_paid)}</td>
                    <td className="num">{num(r.payments_total)}</td>
                    <td className="num">{r.payments_n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel flush">
        <h2>
          تعارض الغرف <span className="count">{overlaps.length}</span>
        </h2>
        {overlaps.length === 0 ? <Empty>لا توجد تعارضات.</Empty> : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>الشقة / الغرفة</th>
                  <th>الضيف الأول</th>
                  <th>المدة</th>
                  <th>الضيف الثاني</th>
                  <th>المدة</th>
                </tr>
              </thead>
              <tbody>
                {overlaps.map((r) => (
                  <tr key={`${r.booking_id}-${r.other_booking_id}`}>
                    <td>{[r.apartment_name, r.room_number].filter(Boolean).join(' / ')}</td>
                    <td><a href={`/bookings/${r.booking_id}`}>{r.guest ?? '—'}</a></td>
                    <td className="faint">{day(r.arrival)} → {r.departure ? day(r.departure) : 'مفتوحة'}</td>
                    <td><a href={`/bookings/${r.other_booking_id}`}>{r.other_guest ?? '—'}</a></td>
                    <td className="faint">
                      {day(r.other_arrival)} → {r.other_departure ? day(r.other_departure) : 'مفتوحة'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ padding: '0 16px 14px' }}>
          التعارض هنا تقرير وليس منعًا: البوت يحذّر ويسمح للموظف بالتجاوز، فقد تكون
          بعض هذه الصفوف مقصودة (تغيير غرفة، أو سطر تابع لنفس الحجز).
        </p>
      </div>

      <div className="panel flush">
        <h2>حجوزات بعملات مختلطة <span className="count">{mixed.length}</span></h2>
        {mixed.length === 0 ? <Empty>لا توجد.</Empty> : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>الضيف</th>
                  <th>الوصول</th>
                  <th>الطرق</th>
                  <th>المدفوع</th>
                </tr>
              </thead>
              <tbody>
                {mixed.map((r) => (
                  <tr key={r.id}>
                    <td className="id">{r.id}</td>
                    <td><a href={`/bookings/${r.id}`}>{r.guest_name ?? '—'}</a></td>
                    <td>{day(r.arrival)}</td>
                    <td className="faint">{String(r.methods ?? '')}</td>
                    <td>{r.paid_label ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
