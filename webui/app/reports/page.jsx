import { q } from '../../lib/db';
import { num } from '../../lib/fmt';
import { Empty, Tile } from '../../components/ui';

export const dynamic = 'force-dynamic';

export default async function Reports({ searchParams }) {
  const params = await searchParams;
  const year = /^\d{4}$/.test(params?.year ?? '') ? params.year : null;

  // NULL year means "everything"; the same predicate is spelled once and reused
  // by every query below so the tables can never disagree about the period.
  const args = [year];

  const [byMonth, byApartment, byMethod, topGuests, [totals], years] = await Promise.all([
    q(`select to_char(date_trunc('month', b.arrival), 'YYYY-MM') as label,
              count(*)::int as bookings,
              coalesce(sum(b.effective_nights), 0)::int as nights,
              coalesce(sum(b.effective_total), 0) as revenue,
              coalesce(sum(b.paid), 0) as paid,
              coalesce(sum(b.effective_remaining), 0) as owing
         from bookings_live b
        where b.cancelled_at is null and b.arrival is not null
          and ($1::text is null or to_char(b.arrival, 'YYYY') = $1)
        group by 1 order by 1 desc`, args),
    q(`select coalesce(b.apartment_name, '—') as apartment,
              count(*)::int as bookings,
              coalesce(sum(b.effective_nights), 0)::int as nights,
              coalesce(sum(b.effective_total), 0) as revenue,
              coalesce(sum(b.paid), 0) as paid,
              coalesce(sum(b.effective_remaining), 0) as owing
         from bookings_live b
        where b.cancelled_at is null
          and ($1::text is null or to_char(b.arrival, 'YYYY') = $1)
        group by 1 order by revenue desc`, args),
    q(`select coalesce(payment_method, 'غير محدد') as method,
              count(*)::int as n,
              coalesce(sum(paid), 0) as paid
         from bookings_live
        where cancelled_at is null and ($1::text is null or to_char(arrival, 'YYYY') = $1)
        group by 1 order by paid desc`, args),
    q(`select id, guest_name, apartment_name, effective_total, paid, effective_remaining
         from bookings_live
        where cancelled_at is null and merged_into is null
          and ($1::text is null or to_char(arrival, 'YYYY') = $1)
        order by effective_total desc nulls last limit 10`, args),
    q(`select
         (select coalesce(sum(effective_total), 0) from bookings_live
           where cancelled_at is null and ($1::text is null or to_char(arrival, 'YYYY') = $1)) as revenue,
         (select coalesce(sum(paid), 0) from bookings_live
           where cancelled_at is null and ($1::text is null or to_char(arrival, 'YYYY') = $1)) as paid,
         (select coalesce(sum(amount), 0) from expenses
           where ($1::text is null or to_char(spent_at, 'YYYY') = $1)) as expenses,
         (select coalesce(sum(effective_nights), 0) from bookings_live
           where cancelled_at is null and ($1::text is null or to_char(arrival, 'YYYY') = $1)) as nights`, args),
    q(`select distinct to_char(arrival, 'YYYY') as y from bookings
        where arrival is not null order by y desc`),
  ]);

  const net = Number(totals.paid) - Number(totals.expenses);
  const collectionRate = Number(totals.revenue) > 0
    ? (Number(totals.paid) / Number(totals.revenue)) * 100
    : 0;

  return (
    <>
      <div className="chips">
        <a className="chip" aria-current={!year ? 'true' : undefined} href="/reports">كل الفترات</a>
        {years.map((r) => (
          <a
            key={r.y}
            className="chip"
            aria-current={year === r.y ? 'true' : undefined}
            href={`/reports?year=${r.y}`}
          >
            {r.y}
          </a>
        ))}
      </div>

      <div className="kpis">
        <Tile label="إجمالي قيمة الحجوزات" value={num(totals.revenue)} />
        <Tile label="المحصل" value={num(totals.paid)} tone="paid" progress={collectionRate}
              sub={`نسبة التحصيل ${Math.round(collectionRate)}%`} />
        <Tile label="المصروفات" value={num(totals.expenses)} tone="owing" />
        <Tile label="الصافي (محصل − مصروف)" value={num(net)} tone={net >= 0 ? 'paid' : 'owing'} />
        <Tile label="إجمالي الليالي" value={num(totals.nights)} />
      </div>

      <div className="panel flush">
        <h2>حسب الشهر <span className="count">شهر الوصول</span></h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>الشهر</th>
                <th className="num">حجوزات</th>
                <th className="num">ليالٍ</th>
                <th className="num">القيمة</th>
                <th className="num">المحصل</th>
                <th className="num">المتبقي</th>
              </tr>
            </thead>
            <tbody>
              {byMonth.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className="num">{r.bookings}</td>
                  <td className="num">{r.nights}</td>
                  <td className="num">{num(r.revenue)}</td>
                  <td className="num">{num(r.paid)}</td>
                  <td className="num">
                    {Number(r.owing) > 0
                      ? <span className="tag owing">{num(r.owing)}</span>
                      : <span className="tag clear">0</span>}
                  </td>
                </tr>
              ))}
              {byMonth.length === 0 && <tr><td colSpan={6}><Empty>لا توجد بيانات.</Empty></td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="cols">
        <div className="panel flush">
          <h2>حسب الشقة</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>الشقة</th>
                  <th className="num">حجوزات</th>
                  <th className="num">ليالٍ</th>
                  <th className="num">المحصل</th>
                  <th className="num">المتبقي</th>
                </tr>
              </thead>
              <tbody>
                {byApartment.map((r) => (
                  <tr key={r.apartment}>
                    <td>{r.apartment}</td>
                    <td className="num">{r.bookings}</td>
                    <td className="num">{r.nights}</td>
                    <td className="num">{num(r.paid)}</td>
                    <td className="num">{num(r.owing)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel flush">
          <h2>حسب طريقة الدفع</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>الطريقة</th>
                  <th className="num">عدد</th>
                  <th className="num">المحصل</th>
                </tr>
              </thead>
              <tbody>
                {byMethod.map((r) => (
                  <tr key={r.method}>
                    <td>{r.method}</td>
                    <td className="num">{r.n}</td>
                    <td className="num">{num(r.paid)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="panel flush">
        <h2>أكبر الحجوزات <span className="count">أعلى 10</span></h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>الضيف</th>
                <th>الشقة</th>
                <th className="num">القيمة</th>
                <th className="num">المحصل</th>
                <th className="num">المتبقي</th>
              </tr>
            </thead>
            <tbody>
              {topGuests.map((r) => (
                <tr key={r.id}>
                  <td className="id">{r.id}</td>
                  <td><a href={`/bookings/${r.id}`}>{r.guest_name ?? '—'}</a></td>
                  <td>{r.apartment_name ?? '—'}</td>
                  <td className="num">{num(r.effective_total)}</td>
                  <td className="num">{num(r.paid)}</td>
                  <td className="num">{num(r.effective_remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="muted">
        «القيمة» للإقامات المفتوحة محسوبة حتى اليوم من سعر الليلة، وهي تكبر كل ليلة.
        المصروفات محسوبة على تاريخ الصرف، لا على شهر الوصول.
      </p>
    </>
  );
}
