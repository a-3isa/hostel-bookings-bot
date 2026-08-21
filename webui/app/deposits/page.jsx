import { createDeposit, deleteDeposit } from '../actions';
import { q } from '../../lib/db';
import { PAYMENT_METHODS } from '../../components/BookingForm';
import { day, num } from '../../lib/fmt';
import { Empty, Tile } from '../../components/ui';

export const dynamic = 'force-dynamic';

// The methods a balance can sit in. «غير مدفوع» is on the booking keyboard
// because a booking can be unpaid; it is not a place money can be, so it is not
// offered as either side of a deposit.
const METHODS = PAYMENT_METHODS.filter((m) => m !== 'غير مدفوع');

// A deposit never crosses currencies — there are no exchange rates anywhere in
// this system, so كاش EGP becomes انستاباي EGP and nothing else.
const CURRENCIES = ['EGP', 'USD', 'EUR'];

const ERRORS = {
  amount: 'المبلغ مطلوب ويجب أن يكون أكبر من صفر.',
  method: 'اختر طريقة المصدر وطريقة الوجهة.',
  same: 'لا يمكن الإيداع من طريقة إلى نفسها — الإيداع ينقل المال بين رصيدين مختلفين.',
};

export default async function Deposits({ searchParams }) {
  const raw = await searchParams;

  let rows;
  let totals;
  try {
    [rows, [totals]] = await Promise.all([
      q(`select id, amount, from_method, to_method, currency, occurred_at,
                note, created_by
           from deposits
          order by occurred_at desc, id desc
          limit 300`),
      q(`select count(*)::int as n,
                coalesce(sum(amount) filter (where currency = 'EGP'), 0) as egp,
                count(*) filter (where currency <> 'EGP')::int as foreign_n,
                max(occurred_at) as last_at
           from deposits`),
    ]);
  } catch (err) {
    const missing = /relation "?deposits"?/i.test(String(err.message));
    return (
      <div className="banner bad">
        <span className="ico">⚠</span>
        <div>
          <strong>
            {missing ? 'جدول الإيداعات غير موجود بعد.' : 'تعذر الاتصال بقاعدة البيانات.'}
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

  const error = ERRORS[raw?.error];

  return (
    <>
      {raw?.saved && (
        <div className="banner good">
          <span className="ico">✓</span>
          <div>
            تم الحفظ في Postgres. الإيداع لا يُكتب في الشيت — تبويب الحجوزات لا
            يعرف هذه الحركة، وأثرها يظهر في{' '}
            <a href="/dashboard">رصيد طرق الدفع</a>.
          </div>
        </div>
      )}
      {error && (
        <div className="banner bad"><span className="ico">⚠</span><div>{error}</div></div>
      )}

      <div className="banner">
        <span className="ico">ℹ</span>
        <div>
          الإيداع ينقل المال من رصيد طريقة دفع إلى أخرى — الكاش المحصَّل يُودَع
          فيصير انستاباي. لا يُنشئ مالًا ولا يُلغيه، ولا علاقة له بحجز بعينه، ولا
          يُكتب في الشيت إطلاقًا.
        </div>
      </div>

      <div className="kpis">
        <Tile label="عدد الإيداعات" value={totals.n} />
        <Tile label="إجمالي المودع (جنيه)" value={num(totals.egp)} tone="paid" />
        <Tile
          label="آخر إيداع"
          value={totals.last_at ? day(totals.last_at) : '—'}
          small
          sub={totals.foreign_n > 0 ? `${totals.foreign_n} بعملة أخرى` : undefined}
        />
      </div>

      <div className="panel">
        <h2>إيداع جديد</h2>
        <form action={createDeposit}>
          <div className="grid">
            <label className="field">
              المبلغ
              <input name="amount" inputMode="decimal" required />
            </label>
            <label className="field">
              من طريقة
              <select name="from_method" defaultValue="كاش" required>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="field">
              إلى طريقة
              <select name="to_method" defaultValue="انستاباي" required>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="field">
              العملة
              <select name="currency" defaultValue="EGP">
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            {/* Left blank on purpose: the action falls back to now() in the
                database, which is the right answer far more often than a
                default rendered from the server's UTC clock and read as Cairo
                time by whoever is looking at it. */}
            <label className="field">
              التاريخ
              <input type="datetime-local" name="occurred_at" />
            </label>
            <label className="field full">
              ملاحظات
              <textarea name="note" placeholder="رقم الإيصال، اسم من أودع، أي شيء" />
            </label>
          </div>
          <p className="row">
            <button type="submit">إضافة</button>
          </p>
        </form>
      </div>

      <div className="panel flush">
        <h2>الإيداعات <span className="count">{rows.length} معروضة</span></h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>التاريخ</th>
                <th>من</th>
                <th>إلى</th>
                <th className="num">المبلغ</th>
                <th>العملة</th>
                <th>ملاحظات</th>
                <th>بواسطة</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="id">{r.id}</td>
                  <td>{day(r.occurred_at)}</td>
                  <td>{r.from_method}</td>
                  <td>{r.to_method}</td>
                  <td className="num">{num(r.amount)}</td>
                  <td className="faint">{r.currency}</td>
                  <td className="wrap-cell">{r.note ?? <span className="faint">—</span>}</td>
                  <td className="faint">{r.created_by ?? '—'}</td>
                  <td>
                    <form action={deleteDeposit.bind(null, r.id)}>
                      <button className="link" type="submit">حذف</button>
                    </form>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={9}><Empty>لا توجد إيداعات مسجلة.</Empty></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
