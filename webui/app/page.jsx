import { q } from '../lib/db';
import { NOT_A_LINE } from '../lib/filters';
import { day, num } from '../lib/fmt';
import { Bars, Empty, Meter, Tile } from '../components/ui';

export const dynamic = 'force-dynamic';

export default async function Overview() {
  // The continuation-line rule, spelled once for every query on this page.
  const LINE = NOT_A_LINE();

  let data;
  try {
    data = await Promise.all([
      // Every one of these excludes continuation lines — see NOT_A_LINE in
      // lib/filters.js. «المحصل» and «مقيم الآن» did not, so the same money and
      // the same guest were counted twice the moment a line existed.
      q(`select
           count(*) filter (where cancelled_at is null and ${LINE}) as active,
           count(*) filter (where cancelled_at is null and ${LINE}
                              and arrival <= current_date
                              and (departure is null or departure > current_date)) as staying,
           count(distinct room_id) filter (where cancelled_at is null and ${LINE}
                              and room_id is not null
                              and arrival <= current_date
                              and (departure is null or departure > current_date)) as rooms_busy,
           coalesce(sum(effective_remaining) filter
             (where cancelled_at is null and ${LINE}), 0) as owing,
           coalesce(sum(paid) filter (where cancelled_at is null and ${LINE}), 0) as collected,
           count(*) filter (where cancelled_at is null and ${LINE} and open_ended) as open_stays
         from bookings_live`),
      q('select count(*)::int as rooms, count(distinct apartment_id)::int as apts from rooms where active'),
      q(`select id, guest_name, apartment_name, room_number, arrival, nights, open_ended
           from bookings_live
          where cancelled_at is null and ${LINE} and arrival = current_date
          order by apartment_name, room_number`),
      q(`select id, guest_name, apartment_name, room_number, departure, effective_remaining
           from bookings_live
          where cancelled_at is null and ${LINE} and departure = current_date
          order by apartment_name, room_number`),
      q(`select id, guest_name, apartment_name, room_number, arrival
           from bookings_live
          where cancelled_at is null and ${LINE} and arrival > current_date
            and arrival <= current_date + 7
          order by arrival limit 8`),
      q(`select a.name,
                count(r.id)::int as rooms,
                count(distinct b.room_id)::int as busy
           from apartments a
           join rooms r on r.apartment_id = a.id and r.active
           left join bookings_live b
             on b.room_id = r.id and b.cancelled_at is null and ${NOT_A_LINE('b')}
            and b.arrival <= current_date
            and (b.departure is null or b.departure > current_date)
          where a.active
          group by a.name order by a.name`),
      // Money in is keyed on the month of ARRIVAL, not payment date: the backfill
      // stamped every imported payment with the day it ran, so a paid_at series
      // would pile the whole history into one bar.
      q(`select to_char(date_trunc('month', arrival), 'YYYY-MM') as label,
                coalesce(sum(paid), 0) as paid,
                coalesce(sum(effective_remaining), 0) as owing,
                count(*)::int as n
           from bookings_live
          where arrival is not null and cancelled_at is null and ${LINE}
            and arrival >= date_trunc('month', current_date) - interval '7 months'
          group by 1 order by 1`),
      q(`select to_char(date_trunc('month', spent_at), 'YYYY-MM') as label,
                coalesce(sum(amount), 0) as amount
           from expenses
          where spent_at >= date_trunc('month', current_date) - interval '7 months'
          group by 1 order by 1`),
      // The Dashboard tab's «رصيد طرق الدفع» block, same six columns, computed
      // from Postgres instead of sheet formulas. A FULL JOIN because a method
      // can appear on an expense and on no booking at all, and the sheet still
      // lists it — the balance is what matters, not where it came from.
      q(`with taken as (
           select coalesce(nullif(trim(payment_method), ''), 'غير محدد') as method,
                  count(*)::int as bookings,
                  coalesce(sum(effective_remaining), 0) as owing,
                  coalesce(sum(paid), 0) as paid
             from bookings_live
            where cancelled_at is null and ${LINE}
            group by 1
         ),
         spent as (
           select coalesce(nullif(trim(payment_method), ''), 'غير محدد') as method,
                  coalesce(sum(amount), 0) as expenses
             from expenses
            group by 1
         )
         select coalesce(t.method, s.method) as method,
                coalesce(t.bookings, 0) as bookings,
                coalesce(t.owing, 0) as owing,
                coalesce(t.paid, 0) as paid,
                coalesce(s.expenses, 0) as expenses,
                coalesce(t.paid, 0) - coalesce(s.expenses, 0) as net
           from taken t full join spent s on s.method = t.method
          order by net desc`),
      q(`select
           (select count(*)::int from booking_overlaps) as overlaps,
           (select count(*)::int from reconcile_bookings) as sheet_diffs,
           (select count(*)::int from reconcile_payments) as payment_diffs,
           (select count(*)::int from mixed_currency_bookings) as mixed,
           (select max(captured_at) from sheet_snapshot) as snapshot_at`),
    ]);
  } catch (err) {
    return (
      <div className="banner bad">
        <span className="ico">⚠</span>
        <div>
          <strong>تعذر الاتصال بقاعدة البيانات.</strong>
          <div className="muted" style={{ marginTop: 6 }}>{String(err.message)}</div>
          <div className="muted">
            تأكد أن <code>SUPABASE_TRANSACTION_URL</code> يشير إلى منفذ الـ pooler (6543).
          </div>
        </div>
      </div>
    );
  }

  const [
    [k], [reg], arrivals, departures, upcoming, byApartment, monthsIn, monthsOut,
    byMethod, [alerts],
  ] = data;

  const methodTotals = byMethod.reduce((sum, r) => ({
    bookings: sum.bookings + Number(r.bookings),
    owing: sum.owing + Number(r.owing),
    paid: sum.paid + Number(r.paid),
    expenses: sum.expenses + Number(r.expenses),
    net: sum.net + Number(r.net),
  }), { bookings: 0, owing: 0, paid: 0, expenses: 0, net: 0 });

  const occupancy = reg.rooms > 0 ? (Number(k.rooms_busy) / reg.rooms) * 100 : 0;
  const months = [...new Set([...monthsIn, ...monthsOut].map((r) => r.label))].sort();
  const chart = months.map((label) => ({
    label: label.slice(2),
    a: Number(monthsIn.find((m) => m.label === label)?.paid ?? 0),
    b: Number(monthsOut.find((m) => m.label === label)?.amount ?? 0),
  }));

  const problems = [
    alerts.sheet_diffs > 0 && [`${alerts.sheet_diffs} فرق بين الشيت وقاعدة البيانات`, '/reconcile'],
    alerts.payment_diffs > 0 && [`${alerts.payment_diffs} فرق في الدفعات`, '/reconcile'],
    alerts.overlaps > 0 && [`${alerts.overlaps} تعارض في حجز الغرف`, '/reconcile'],
    alerts.mixed > 0 && [`${alerts.mixed} حجز بعملات مختلطة`, '/reconcile'],
  ].filter(Boolean);

  return (
    <>
      <div className="banner">
        <span className="ico">ℹ</span>
        <div>
          الشيت ما زال هو المرجع. أي تعديل هنا يكتب في Postgres فقط، وسيظهر في تقرير
          المطابقة كفرق حتى يُنقل إلى الشيت.
          {alerts.snapshot_at && (
            <span className="faint"> آخر لقطة للشيت: {day(alerts.snapshot_at)}.</span>
          )}
        </div>
      </div>

      {problems.length > 0 && (
        <div className="banner bad">
          <span className="ico">⚠</span>
          <div className="row" style={{ gap: 8 }}>
            {problems.map(([label, href]) => (
              <a key={label} className="tag owing" href={href}>{label}</a>
            ))}
          </div>
        </div>
      )}

      <div className="kpis">
        <Tile label="حجوزات نشطة" value={k.active} sub={`${k.open_stays} إقامة مفتوحة`} />
        <Tile
          label="الإشغال الآن"
          value={`${Math.round(occupancy)}%`}
          sub={`${k.rooms_busy} من ${reg.rooms} غرفة في ${reg.apts} شقق`}
          progress={occupancy}
        />
        <Tile label="مقيم الآن" value={k.staying} sub={`${arrivals.length} وصول اليوم · ${departures.length} مغادرة`} />
        <Tile label="إجمالي المتبقي" value={num(k.owing)} tone="owing" sub="على الحجوزات غير الملغاة" />
        <Tile label="إجمالي المحصل" value={num(k.collected)} tone="paid" />
      </div>

      <div className="cols">
        <div className="panel">
          <h2>وصول اليوم <span className="count">{arrivals.length}</span></h2>
          {arrivals.length === 0 ? <Empty>لا يوجد وصول اليوم.</Empty> : (
            <ul className="list">
              {arrivals.map((r) => (
                <li key={r.id}>
                  <a href={`/bookings/${r.id}`}>{r.guest_name ?? '—'}</a>
                  <span className="spacer" />
                  <span className="faint">
                    {[r.apartment_name, r.room_number].filter(Boolean).join(' / ') || '—'}
                  </span>
                  {/* effective_nights counts nights already spent, which is 0 on
                      the day of arrival — the booked length is the useful number here. */}
                  <span className="tag">
                    {r.open_ended ? 'مفتوحة' : `${r.nights ?? '—'} ليالٍ`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel">
          <h2>مغادرة اليوم <span className="count">{departures.length}</span></h2>
          {departures.length === 0 ? <Empty>لا توجد مغادرة اليوم.</Empty> : (
            <ul className="list">
              {departures.map((r) => (
                <li key={r.id}>
                  <a href={`/bookings/${r.id}`}>{r.guest_name ?? '—'}</a>
                  <span className="spacer" />
                  <span className="faint">
                    {[r.apartment_name, r.room_number].filter(Boolean).join(' / ') || '—'}
                  </span>
                  {Number(r.effective_remaining) > 0
                    ? <span className="tag owing">متبقي {num(r.effective_remaining)}</span>
                    : <span className="tag clear">مسدد</span>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel">
          <h2>القادم خلال 7 أيام <span className="count">{upcoming.length}</span></h2>
          {upcoming.length === 0 ? <Empty>لا توجد حجوزات قادمة.</Empty> : (
            <ul className="list">
              {upcoming.map((r) => (
                <li key={r.id}>
                  <span className="faint">{day(r.arrival)}</span>
                  <a href={`/bookings/${r.id}`}>{r.guest_name ?? '—'}</a>
                  <span className="spacer" />
                  <span className="faint">
                    {[r.apartment_name, r.room_number].filter(Boolean).join(' / ') || '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel">
          <h2>الإشغال حسب الشقة</h2>
          {byApartment.map((a) => (
            <Meter
              key={a.name}
              label={a.name}
              value={a.busy}
              max={a.rooms}
              caption={`${a.busy}/${a.rooms}`}
            />
          ))}
        </div>
      </div>

      <div className="panel flush">
        <h2>رصيد طرق الدفع <span className="count">المصاريف مطروحة من نفس طريقة الدفع</span></h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>طريقة الدفع</th>
                <th className="num">عدد الحجوزات</th>
                <th className="num">إجمالي المتبقي</th>
                <th className="num">إجمالي المدفوع</th>
                <th className="num">المصاريف</th>
                <th className="num">الصافي</th>
              </tr>
            </thead>
            <tbody>
              {byMethod.map((r) => (
                <tr key={r.method}>
                  <td>{r.method}</td>
                  <td className="num">{r.bookings}</td>
                  <td className="num">
                    {Number(r.owing) > 0
                      ? <span className="tag owing">{num(r.owing)}</span>
                      : <span className="faint">0</span>}
                  </td>
                  <td className="num">{num(r.paid)}</td>
                  <td className="num">{Number(r.expenses) > 0 ? num(r.expenses) : <span className="faint">—</span>}</td>
                  <td className="num"><strong>{num(r.net)}</strong></td>
                </tr>
              ))}
              <tr>
                <td><strong>الإجمالي</strong></td>
                <td className="num"><strong>{methodTotals.bookings}</strong></td>
                <td className="num"><strong>{num(methodTotals.owing)}</strong></td>
                <td className="num"><strong>{num(methodTotals.paid)}</strong></td>
                <td className="num"><strong>{num(methodTotals.expenses)}</strong></td>
                <td className="num"><strong>{num(methodTotals.net)}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ padding: '0 16px 14px' }}>
          محسوبة من قاعدة البيانات، لا منقولة من تبويب Dashboard — فقد تختلف الأرقام
          قليلًا لأن معادلات الشيت تعدّ سطوره هو، بينما هنا تُعدّ الحجوزات غير الملغاة.
        </p>
      </div>

      <div className="panel">
        <h2>محصل مقابل مصروفات <span className="count">حسب شهر الوصول، آخر 8 شهور</span></h2>
        {chart.length === 0 ? <Empty>لا توجد بيانات كافية.</Empty> : <Bars data={chart} />}
      </div>
    </>
  );
}
