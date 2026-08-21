import { q } from '../../lib/db';
import { NOT_A_LINE } from '../../lib/filters';
import { num } from '../../lib/fmt';
import { Empty, Tile } from '../../components/ui';
import { saveDashboardSettings } from '../actions';

export const dynamic = 'force-dynamic';

// The sheet's Dashboard!N formula tests نوع الحجز against a Booking.com sale,
// and three spellings of it have been typed into the tab over time. All three
// count, exactly as the sheet's own IF does.
const BOOKING_TYPES = ['بوكينج', 'بوكنج', 'Booking'];

// Bookings and expenses both carry the apartment as free text, and a handful of
// rows carry nothing at all. Those are not dropped — they hold real money — so
// they land in one clearly-named bucket instead of quietly leaving the totals.
const UNASSIGNED = 'غير محدد';

// A booking whose payments are in more than one currency. `bookings.paid` is a
// sum across them and so means nothing on its own; every figure derived from it
// is marked on the page rather than silently trusted.
const MIXED = `select booking_id from payments
                group by booking_id having count(distinct currency) > 1`;

function Mixed({ n }) {
  if (!n) return null;
  return (
    <span className="tag owing" title="يشمل حجزًا مدفوعًا بأكثر من عملة — الرقم جمع بين عملتين">
      ⚠ {n}
    </span>
  );
}

export default async function Dashboard({ searchParams }) {
  const raw = await searchParams;

  // The continuation-line rule, the same one /, /reports and /bookings use —
  // see NOT_A_LINE in lib/filters.js.
  const LINE = NOT_A_LINE('b');


  let data;
  try {
    data = await Promise.all([
      // ── Block 1: per-apartment P&L ───────────────────────────────────────
      //
      // Column for column with the sheet's own formulas:
      //   إجمالي الدخل            SUMIF(G:G, apt, L:L)
      //   المدفوع                 SUMIF(G:G, apt, M:M)
      //   المتبقي                 SUMIF(G:G, apt, P:P)     P = L − M
      //   عمولة بوكنج             SUMIF(G:G, apt, N:N)     N = IF(booking, L × rate, 0)
      //   المصاريف                SUMIF('مصروفات عامة'!D:D, apt, C:C)
      //   الدخل بدون نسبة بوكنج   C − E
      //   صافي الربح              G − F − I                I = الايجار
      //
      // `effective_total` and `effective_remaining`, not the raw columns: an
      // open-ended stay's L cell is a live formula that grows every night, and
      // the view is what reproduces the number the sheet is showing today.
      q(`with rate as (
           select coalesce((select value from settings
                             where key = 'booking_commission_rate'), 0) as r
         ),
         mixed as (${MIXED}),
         inc as (
           select coalesce(nullif(trim(b.apartment_name), ''), $1) as name,
                  count(*)::int                                    as bookings,
                  coalesce(sum(b.effective_total), 0)              as income,
                  coalesce(sum(b.paid), 0)                         as paid,
                  coalesce(sum(b.effective_remaining), 0)          as remaining,
                  coalesce(sum(case when b.booking_type = any($2::text[])
                                    then coalesce(b.effective_total, 0) * (select r from rate)
                                    else 0 end), 0)                as commission,
                  count(*) filter (where x.booking_id is not null)::int as mixed
             from bookings_live b
             left join mixed x on x.booking_id = b.id
            where b.cancelled_at is null and ${LINE}
            group by 1
         ),
         exp as (
           select coalesce(nullif(trim(e.apartment_name), ''), $1) as name,
                  coalesce(sum(e.amount), 0)                       as expenses
             from expenses e
            group by 1
         ),
         names as (
           select a.id, a.name, a.monthly_rent, true as registered
             from apartments a where a.active
           union all
           select null::bigint, n.name, null::numeric, false
             from (select name from inc union select name from exp) n
            where not exists (select 1 from apartments a
                               where a.active and a.name = n.name)
         )
         select n.id, n.name, n.registered,
                n.monthly_rent                          as rent,
                coalesce(i.bookings, 0)                 as bookings,
                coalesce(i.income, 0)                   as income,
                coalesce(i.paid, 0)                     as paid,
                coalesce(i.remaining, 0)                as remaining,
                coalesce(i.commission, 0)               as commission,
                coalesce(i.mixed, 0)                    as mixed,
                coalesce(x.expenses, 0)                 as expenses,
                coalesce(i.paid, 0) - coalesce(i.commission, 0) as income_ex_commission,
                coalesce(i.paid, 0) - coalesce(i.commission, 0)
                  - coalesce(x.expenses, 0) - coalesce(n.monthly_rent, 0) as profit
           from names n
           left join inc i on i.name = n.name
           left join exp x on x.name = n.name
          order by n.registered desc, n.name`, [UNASSIGNED, BOOKING_TYPES]),

      // ── Block 2: occupancy ────────────────────────────────────────────────
      //
      // Subqueries rather than two joins off one row: joining rooms AND
      // bookings in the same shape multiplies the room rows by the bookings on
      // them, and عدد الغرف comes out as the number of stays instead.
      //
      // `departure >= current_date` — the sheet's block calls a room busy on
      // the day the guest leaves, and an open stay (departure NULL) is busy
      // until it is closed.
      q(`select a.id, a.name,
                (select count(*)::int from rooms r
                  where r.apartment_id = a.id and r.active) as rooms,
                (select count(distinct b.room_id)::int
                   from bookings_live b
                   join rooms r on r.id = b.room_id
                  where r.apartment_id = a.id and r.active
                    and b.cancelled_at is null and ${LINE}
                    and b.arrival <= current_date
                    and (b.departure is null or b.departure >= current_date)) as busy
           from apartments a
          where a.active
          order by a.name`),

      // ── Block 3: payment-method balances, with deposits ───────────────────
      //
      // The raw figure is the sheet's: bookings grouped by طريقة الدفع. The
      // adjustment is what the sheet has never had — a deposit moves money out
      // of one method's balance and into another's, and until now the كاش
      // balance kept counting cash that had already been banked.
      //
      // A FULL JOIN because a method can carry deposits and no bookings at all:
      // the first ever انستاباي deposit lands on a method whose booking side
      // may be empty, and dropping it would lose the money.
      q(`with mixed as (${MIXED}),
         taken as (
           select coalesce(nullif(trim(b.payment_method), ''), $1) as method,
                  count(*)::int                                    as bookings,
                  coalesce(sum(b.effective_remaining), 0)          as remaining,
                  coalesce(sum(b.paid), 0)                         as paid,
                  count(*) filter (where x.booking_id is not null)::int as mixed
             from bookings_live b
             left join mixed x on x.booking_id = b.id
            where b.cancelled_at is null and ${LINE}
            group by 1
         ),
         moved as (
           select to_method   as method, currency,  amount as delta from deposits
           union all
           select from_method as method, currency, -amount as delta from deposits
         ),
         per_currency as (
           select method, currency, sum(delta) as delta from moved group by 1, 2
         ),
         dep as (
           select method,
                  coalesce(sum(delta) filter (where currency = 'EGP'), 0) as egp,
                  jsonb_object_agg(currency, delta)
                    filter (where currency <> 'EGP' and delta <> 0)       as other
             from per_currency
            group by method
         )
         select coalesce(t.method, d.method)  as method,
                coalesce(t.bookings, 0)       as bookings,
                coalesce(t.remaining, 0)      as remaining,
                coalesce(t.paid, 0)           as paid,
                coalesce(t.mixed, 0)          as mixed,
                coalesce(d.egp, 0)            as deposits,
                d.other                       as deposits_other,
                coalesce(t.paid, 0) + coalesce(d.egp, 0) as balance
           from taken t
           full join dep d on d.method = t.method
          order by balance desc`, [UNASSIGNED]),

      // Every booking whose money is denominated in more than one currency,
      // named rather than folded into a total. There are no exchange rates in
      // this system, so «650 EGP + 40 USD» is the only honest answer.
      q(`select v.id, v.guest_name, v.paid_label, v.methods,
                b.apartment_name, b.payment_method
           from mixed_currency_bookings v
           join bookings b on b.id = v.id
          order by v.id`),

      q(`select a.id, a.name, a.monthly_rent
           from apartments a where a.active order by a.name`),

      q(`select coalesce((select value from settings
                           where key = 'booking_commission_rate'), 0) as rate,
                (select count(*)::int from deposits) as deposits_n`),
    ]);
  } catch (err) {
    const missing = /relation "?(settings|deposits)"?|column .*monthly_rent/i
      .test(String(err.message));
    return (
      <div className="banner bad">
        <span className="ico">⚠</span>
        <div>
          <strong>
            {missing
              ? 'الجداول الجديدة غير موجودة بعد في قاعدة البيانات.'
              : 'تعذر الاتصال بقاعدة البيانات.'}
          </strong>
          <div className="muted" style={{ marginTop: 6 }}>{String(err.message)}</div>
          {missing && (
            <div className="muted">
              شغّل الهجرة أولًا:{' '}
              <code>supabase/migrations/20260821_dashboard_settings_and_deposits.sql</code>
            </div>
          )}
        </div>
      </div>
    );
  }

  const [pnl, occupancy, methods, mixedBookings, apartments, [meta]] = data;

  const rate = Number(meta.rate);
  const zero = { bookings: 0, income: 0, paid: 0, remaining: 0, commission: 0,
                 expenses: 0, income_ex_commission: 0, rent: 0, profit: 0, mixed: 0 };
  const pnlTotal = pnl.reduce((s, r) => {
    for (const key of Object.keys(zero)) s[key] += Number(r[key] ?? 0);
    return s;
  }, { ...zero });

  const occTotal = occupancy.reduce(
    (s, r) => ({ rooms: s.rooms + r.rooms, busy: s.busy + r.busy }),
    { rooms: 0, busy: 0 },
  );

  const methodTotal = methods.reduce((s, r) => ({
    bookings: s.bookings + Number(r.bookings),
    remaining: s.remaining + Number(r.remaining),
    paid: s.paid + Number(r.paid),
    deposits: s.deposits + Number(r.deposits),
    balance: s.balance + Number(r.balance),
  }), { bookings: 0, remaining: 0, paid: 0, deposits: 0, balance: 0 });

  const noRent = pnl.filter((r) => r.registered && r.rent === null).map((r) => r.name);
  const unregistered = pnl.filter((r) => !r.registered).map((r) => r.name);

  return (
    <>
      {raw?.saved && (
        <div className="banner good">
          <span className="ico">✓</span>
          <div>تم حفظ الإيجارات ونسبة العمولة في Postgres. الشيت لم يُمس.</div>
        </div>
      )}

      <div className="banner">
        <span className="ico">ℹ</span>
        <div>
          <strong>هذه الصفحة تحسب من Postgres، لا تنقل من تبويب Dashboard —
            وأرقامها تختلف عن الشيت عن قصد في ثلاثة مواضع:</strong>
          <ol style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
            <li>
              <b>Airbnb مكرر في الشيت</b> (السطران O7 و O9) وكلاهما يعدّ نفس
              الحجوزات، فالطريقة الواحدة تُحتسب مرتين. هنا كل طريقة دفع سطر واحد.
            </li>
            <li>
              <b>«لم يتم» مضاف ثلاث مرات</b> (السطور 12 و13 و14) وصف الإجمالي
              يجمع 4:16، فالحجوزات غير المدفوعة تُعدّ ثلاث مرات. الشيت يقول
              <b> 95 حجزًا</b> بينما العدد الحقيقي <b>91</b> — وهو ما تعرضه هذه
              الصفحة.
            </li>
            {/*
              The largest difference of the three, and the one anybody comparing
              the two pages hits first. Verified against live data on
              2026-08-21: restricted to the seven registered apartments this
              page reproduces the sheet's expense total to the piastre
              (33,526.46), so the gap is entirely rows the sheet's SUMIF cannot
              see — not a modelling difference.
            */}
            <li>
              <b>صفوف بلا شقة لا يراها الشيت.</b> كل أرقام تبويب Dashboard مبنية
              على <code>SUMIF</code> باسم الشقة، فأي صف خانة الشقة فيه فارغة
              يسقط من كل الحسابات. اليوم هذا يعني: حجز واحد بلا شقة
              (<b>3,000</b> دخلًا ومدفوعًا)، مصاريف بلا شقة
              (<b>6,961</b>)، وسطر الدفعة المدموج يدويًا في الصف 18
              (<b>3,500</b> فودافون كاش لحسام) الذي تطويه هذه الصفحة داخل حجزه.
              هذه الصفحة تحتسبها كلها وتُظهر ما لا شقة له تحت
              <b> «غير محدد»</b>؛ الشيت يتجاهلها بصمت. مقصورةً على الشقق المسجّلة
              وحدها، أرقام هذه الصفحة تطابق الشيت.
            </li>
          </ol>
          <div className="muted" style={{ marginTop: 6 }}>
            الحجوزات الملغاة مستبعدة من كل الأرقام هنا. الشيت يصفّر سعرها وعدد
            لياليها عند الإلغاء، فالفرق في المال صفر اليوم، والفرق في العدد حجز
            واحد.
          </div>
        </div>
      </div>

      <div className="kpis">
        <Tile label="إجمالي الدخل" value={num(pnlTotal.income)} />
        <Tile label="المدفوع" value={num(pnlTotal.paid)} tone="paid" />
        <Tile label="المتبقي" value={num(pnlTotal.remaining)} tone="owing" />
        <Tile label="عمولة بوكنج" value={num(pnlTotal.commission)}
              sub={`${num(rate * 100)}% على حجوزات بوكينج`} />
        <Tile label="المصاريف" value={num(pnlTotal.expenses)} tone="owing" />
        <Tile label="الايجار" value={num(pnlTotal.rent)} tone="owing" />
        <Tile label="صافي الربح" value={num(pnlTotal.profit)}
              tone={pnlTotal.profit >= 0 ? 'paid' : 'owing'} />
      </div>

      {/* ── Block 1 ─────────────────────────────────────────────────────── */}
      <div className="panel flush">
        <h2>
          الربح والخسارة حسب الشقة
          <span className="count">{pnlTotal.bookings} حجزًا غير ملغى</span>
        </h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>الشقة</th>
                <th className="num">إجمالي الدخل</th>
                <th className="num">المدفوع</th>
                <th className="num">المتبقي</th>
                <th className="num">عمولة بوكنج</th>
                <th className="num">المصاريف</th>
                <th className="num">الدخل بدون نسبة بوكنج</th>
                <th className="num">الايجار</th>
                <th className="num">صافي الربح</th>
              </tr>
            </thead>
            <tbody>
              {pnl.map((r) => (
                <tr key={r.name}>
                  <td>
                    {r.name}
                    {!r.registered && <span className="tag"> خارج السجل</span>}
                  </td>
                  <td className="num">{num(r.income)}</td>
                  <td className="num">
                    {num(r.paid)} <Mixed n={r.mixed} />
                  </td>
                  <td className="num">
                    {Number(r.remaining) !== 0
                      ? <span className="tag owing">{num(r.remaining)}</span>
                      : <span className="faint">0</span>}
                  </td>
                  <td className="num">{num(r.commission)}</td>
                  <td className="num">
                    {Number(r.expenses) > 0 ? num(r.expenses) : <span className="faint">—</span>}
                  </td>
                  <td className="num">{num(r.income_ex_commission)}</td>
                  <td className="num">
                    {r.rent === null
                      ? <span className="faint">—</span>
                      : num(r.rent)}
                  </td>
                  <td className="num">
                    <strong className={Number(r.profit) < 0 ? 'error' : undefined}>
                      {num(r.profit)}
                    </strong>
                  </td>
                </tr>
              ))}
              <tr>
                <td><strong>الإجمالي</strong></td>
                <td className="num"><strong>{num(pnlTotal.income)}</strong></td>
                <td className="num"><strong>{num(pnlTotal.paid)}</strong></td>
                <td className="num"><strong>{num(pnlTotal.remaining)}</strong></td>
                <td className="num"><strong>{num(pnlTotal.commission)}</strong></td>
                <td className="num"><strong>{num(pnlTotal.expenses)}</strong></td>
                <td className="num"><strong>{num(pnlTotal.income_ex_commission)}</strong></td>
                <td className="num"><strong>{num(pnlTotal.rent)}</strong></td>
                <td className="num"><strong>{num(pnlTotal.profit)}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ padding: '0 16px 14px' }}>
          «الدخل بدون نسبة بوكنج» = المدفوع − عمولة بوكنج، و«صافي الربح» = ذلك −
          المصاريف − الايجار، مثل معادلات الشيت حرفًا بحرف. قيمة الإقامات
          المفتوحة محسوبة حتى اليوم من سعر الليلة وتكبر كل ليلة.
          {noRent.length > 0 && (
            <> شقق بلا إيجار مسجل: {noRent.join('، ')} — صافي ربحها ناقص حتى يُدخل.</>
          )}
          {unregistered.length > 0 && (
            <> صفوف بأسماء ليست في سجل الشقق: {unregistered.join('، ')}.</>
          )}
        </p>
      </div>

      {/* ── Block 2 ─────────────────────────────────────────────────────── */}
      <div className="panel flush">
        <h2>
          الإشغال
          <span className="count">{occTotal.busy} من {occTotal.rooms} غرفة الآن</span>
        </h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>الشقة</th>
                <th className="num">عدد الغرف</th>
                <th className="num">مشغول الآن</th>
                <th className="num">المتاح الآن</th>
                <th>الحالة</th>
              </tr>
            </thead>
            <tbody>
              {occupancy.map((r) => {
                const free = r.rooms - r.busy;
                return (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td className="num">{r.rooms}</td>
                    <td className="num">{r.busy}</td>
                    <td className="num">{free}</td>
                    <td>
                      {free > 0
                        ? <span className="tag clear">متاح</span>
                        : <span className="tag owing">مكتمل</span>}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td><strong>الإجمالي</strong></td>
                <td className="num"><strong>{occTotal.rooms}</strong></td>
                <td className="num"><strong>{occTotal.busy}</strong></td>
                <td className="num"><strong>{occTotal.rooms - occTotal.busy}</strong></td>
                <td className="faint">
                  {occTotal.rooms > 0
                    ? `${Math.round((occTotal.busy / occTotal.rooms) * 100)}% إشغال`
                    : '—'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ padding: '0 16px 14px' }}>
          «مشغول الآن» يعدّ الغرف — لا الحجوزات — التي يقع تاريخ اليوم بين وصولها
          ومغادرتها، والملغاة مستبعدة. الإقامة المفتوحة تظل مشغولة حتى تُقفل.
        </p>
      </div>

      {/* ── Block 3 ─────────────────────────────────────────────────────── */}
      <div className="panel flush">
        <h2>
          رصيد طرق الدفع
          <span className="count">
            {meta.deposits_n > 0
              ? `${meta.deposits_n} إيداعًا مُحتسبًا`
              : 'لا إيداعات مسجلة بعد'}
          </span>
        </h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>طريقة الدفع</th>
                <th className="num">عدد الحجوزات</th>
                <th className="num">إجمالي المتبقي</th>
                <th className="num">إجمالي المدفوع (خام)</th>
                <th className="num">تسوية الإيداعات</th>
                <th className="num">الرصيد بعد الإيداعات</th>
              </tr>
            </thead>
            <tbody>
              {methods.map((r) => (
                <tr key={r.method}>
                  <td>{r.method}</td>
                  <td className="num">{r.bookings}</td>
                  <td className="num">
                    {Number(r.remaining) !== 0
                      ? <span className="tag owing">{num(r.remaining)}</span>
                      : <span className="faint">0</span>}
                  </td>
                  <td className="num">
                    {num(r.paid)} <Mixed n={r.mixed} />
                  </td>
                  <td className="num">
                    {Number(r.deposits) === 0
                      ? <span className="faint">—</span>
                      : <span className={Number(r.deposits) > 0 ? 'tag clear' : 'tag info'}>
                          {Number(r.deposits) > 0 ? '+' : '−'}{num(Math.abs(Number(r.deposits)))}
                        </span>}
                    {r.deposits_other && (
                      <div className="faint" style={{ fontSize: 11 }}>
                        {Object.entries(r.deposits_other)
                          .map(([cur, v]) => `${Number(v) > 0 ? '+' : '−'}${num(Math.abs(Number(v)))} ${cur}`)
                          .join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="num"><strong>{num(r.balance)}</strong></td>
                </tr>
              ))}
              <tr>
                <td><strong>الإجمالي</strong></td>
                <td className="num"><strong>{methodTotal.bookings}</strong></td>
                <td className="num"><strong>{num(methodTotal.remaining)}</strong></td>
                <td className="num"><strong>{num(methodTotal.paid)}</strong></td>
                <td className="num"><strong>{num(methodTotal.deposits)}</strong></td>
                <td className="num"><strong>{num(methodTotal.balance)}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ padding: '0 16px 14px' }}>
          «خام» هو رقم الشيت نفسه — مجموع المدفوع على الحجوزات بهذه الطريقة — وهو
          مُبقى كما هو ليظل قابلًا للمقارنة. «تسوية الإيداعات» هي ما خرج من هذه
          الطريقة وما دخل إليها عبر <a href="/deposits">صفحة الإيداعات</a>، والإيداع
          لا يُكتب في الشيت إطلاقًا. مجموع التسوية على كل الطرق صفر: الإيداع ينقل
          المال ولا يخلقه.
        </p>
      </div>

      {/* ── Currency, never folded ──────────────────────────────────────── */}
      <div className="cols">
        <div className="panel flush">
          <h2>
            حجوزات بعملات مختلطة
            <span className="count">{mixedBookings.length}</span>
          </h2>
          {mixedBookings.length === 0 ? (
            <Empty>لا يوجد حجز مدفوع بأكثر من عملة.</Empty>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>الضيف</th>
                    <th>الشقة</th>
                    <th>المدفوع فعليًا</th>
                  </tr>
                </thead>
                <tbody>
                  {mixedBookings.map((r) => (
                    <tr key={r.id}>
                      <td className="id">{r.id}</td>
                      <td><a href={`/bookings/${r.id}`}>{r.guest_name ?? '—'}</a></td>
                      <td>{r.apartment_name ?? '—'}</td>
                      <td>{r.paid_label ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted" style={{ padding: '12px 16px 14px' }}>
            لا توجد أسعار صرف في هذا النظام عن قصد، فلا يُجمع الجنيه مع الدولار.
            عمود «المدفوع» أعلاه يجمعهما لأن الشيت يجمعهما — وكل صف يشمل واحدًا من
            هذه الحجوزات مُعلَّم بـ ⚠.
          </p>
        </div>

        {/* ── The two numbers the sheet kept in cells ────────────────────── */}
        <div className="panel">
          <h2>الإيجارات ونسبة العمولة</h2>
          <form action={saveDashboardSettings}>
            <div className="grid">
              <label className="field">
                نسبة عمولة بوكنج (%)
                <input name="commission_pct" inputMode="decimal"
                       defaultValue={String(Number((rate * 100).toFixed(4)))} />
              </label>
              {apartments.map((a) => (
                <label className="field" key={a.id}>
                  إيجار {a.name}
                  <input name={`rent_${a.id}`} inputMode="decimal"
                         defaultValue={a.monthly_rent ?? ''} />
                </label>
              ))}
            </div>
            <p className="row">
              <button type="submit">حفظ</button>
            </p>
          </form>
          <p className="muted">
            كانت هاتان القيمتان تعيشان في الشيت وحده — النسبة في الخلية
            <code> Dashboard!B20</code> والإيجار في العمود I. صارتا الآن في
            Postgres وتُحرَّران من هنا. الحقل الفارغ يعني «لا إيجار مسجل».
            «ابو حديد 7» ليست في سجل الشقق وإيجارها فارغ في الشيت أصلًا، فلم
            تُضَف.
          </p>
        </div>
      </div>
    </>
  );
}
