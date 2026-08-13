import { createExpense, deleteExpense, saveExpense } from '../actions';
import { one, q } from '../../lib/db';
import { PAYMENT_METHODS } from '../../components/BookingForm';
import { dateTimeInput, day, num } from '../../lib/fmt';
import { Empty, Tile } from '../../components/ui';

export const dynamic = 'force-dynamic';

const SORTS = {
  id: 'e.id',
  date: 'e.spent_at',
  item: 'e.item',
  apartment: 'e.apartment_name',
  amount: 'e.amount',
};

function link(current, changes) {
  const params = new URLSearchParams();
  const merged = { ...current, ...changes };
  for (const [key, value] of Object.entries(merged)) {
    if (value) params.set(key, String(value));
  }
  const query = params.toString();
  return `/expenses${query ? `?${query}` : ''}`;
}

function SortHeader({ column, label, align, current }) {
  const active = current.sort === column;
  const dir = active && current.dir === 'asc' ? 'desc' : 'asc';
  return (
    <th className={align}>
      <a href={link(current, { sort: column, dir })} aria-sort={active ? 'other' : undefined}>
        {label}<span className="arrow">{active ? (current.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </a>
    </th>
  );
}

export default async function Expenses({ searchParams }) {
  const raw = await searchParams;
  const flags = {
    q: (raw?.q ?? '').trim(),
    apartment: raw?.apartment ?? '',
    method: raw?.method ?? '',
    from: raw?.from ?? '',
    to: raw?.to ?? '',
    sort: SORTS[raw?.sort] ? raw.sort : 'id',
    dir: raw?.dir === 'asc' ? 'asc' : 'desc',
  };
  const editing = raw?.edit ? Number(raw.edit) : null;

  const clauses = [];
  const values = [];
  const p = (value) => { values.push(value); return `$${values.length}`; };
  if (flags.q) {
    const like = p(`%${flags.q}%`);
    clauses.push(`(e.item ilike ${like} or e.notes ilike ${like} or e.responsible ilike ${like})`);
  }
  if (flags.apartment) clauses.push(`e.apartment_name = ${p(flags.apartment)}`);
  if (flags.method) clauses.push(`e.payment_method = ${p(flags.method)}`);
  if (flags.from) clauses.push(`e.spent_at >= ${p(flags.from)}::date`);
  if (flags.to) clauses.push(`e.spent_at < ${p(flags.to)}::date + 1`);
  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';

  // Fetched rather than found in `rows`: node-postgres hands bigint back as a
  // string, so `r.id === editing` is false for every row on the page.
  const [current, rows, apartments, [totals], [filtered]] = await Promise.all([
    editing ? one('select * from expenses where id = $1', [editing]) : null,
    q(`select e.*, a.name as apartment
         from expenses e left join apartments a on a.id = e.apartment_id
         ${where}
        order by ${SORTS[flags.sort]} ${flags.dir} nulls last, e.id ${flags.dir}
        limit 300`, values),
    q('select id, name from apartments where active order by name'),
    q(`select coalesce(sum(amount), 0) as total, count(*)::int as n,
              coalesce(sum(amount) filter
                (where spent_at >= date_trunc('month', current_date)), 0) as this_month
         from expenses`),
    q(`select coalesce(sum(e.amount), 0) as total, count(*)::int as n
         from expenses e ${where}`, values),
  ]);

  const methods = [...new Set([...PAYMENT_METHODS, ...rows.map((r) => r.payment_method)])].filter(Boolean);
  const isFiltered = Boolean(where);

  return (
    <>
      {raw?.saved && (
        <div className="banner good"><span className="ico">✓</span><div>تم الحفظ في Postgres. الشيت لم يتغير.</div></div>
      )}

      <div className="kpis">
        <Tile label="عدد المصروفات" value={totals.n} />
        <Tile label="إجمالي المصروفات" value={num(totals.total)} tone="owing" />
        <Tile label="هذا الشهر" value={num(totals.this_month)} tone="owing" />
        {isFiltered && (
          <Tile label="نتيجة الفلتر" value={num(filtered.total)} sub={`${filtered.n} صف`} />
        )}
      </div>

      <div className="panel">
        <form className="filters" method="get">
          <input type="hidden" name="sort" value={flags.sort} />
          <input type="hidden" name="dir" value={flags.dir} />
          <label className="field">
            بحث
            <input name="q" defaultValue={flags.q} placeholder="بند، ملاحظة، مسئول" />
          </label>
          <label className="field">
            الشقة
            <select name="apartment" defaultValue={flags.apartment}>
              <option value="">الكل</option>
              {apartments.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select>
          </label>
          <label className="field">
            طريقة الدفع
            <select name="method" defaultValue={flags.method}>
              <option value="">الكل</option>
              {methods.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="field">
            من
            <input type="date" name="from" defaultValue={flags.from} />
          </label>
          <label className="field">
            إلى
            <input type="date" name="to" defaultValue={flags.to} />
          </label>
          <div className="actions">
            <button type="submit">تطبيق</button>
            <a className="btn ghost" href="/expenses">مسح</a>
          </div>
        </form>
      </div>

      <div className="panel">
        <h2>{current ? `تعديل مصروف #${current.id}` : 'مصروف جديد'}</h2>
        <form action={current ? saveExpense.bind(null, current.id) : createExpense}>
          <div className="grid">
            <label className="field">
              البند
              <input name="item" defaultValue={current?.item ?? ''} required />
            </label>
            <label className="field">
              المبلغ
              <input name="amount" inputMode="decimal" defaultValue={current?.amount ?? ''} required />
            </label>
            <label className="field">
              الشقة
              <select name="apartment_id" defaultValue={current?.apartment_id ?? ''}>
                <option value="">—</option>
                {apartments.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <label className="field">
              طريقة الدفع
              <select name="payment_method" defaultValue={current?.payment_method ?? ''}>
                <option value="">—</option>
                {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="field">
              اسم المسئول
              <input name="responsible" defaultValue={current?.responsible ?? ''} />
            </label>
            <label className="field">
              الرقم
              <input name="expense_ref" defaultValue={current?.expense_ref ?? ''} />
            </label>
            <label className="field">
              التاريخ
              <input type="datetime-local" name="spent_at" defaultValue={dateTimeInput(current?.spent_at)} />
            </label>
            <label className="field full">
              ملاحظات
              <textarea name="notes" defaultValue={current?.notes ?? ''} />
            </label>
          </div>
          <p className="row">
            <button type="submit">{current ? 'حفظ' : 'إضافة'}</button>
            {current && <a className="btn ghost" href="/expenses">إلغاء</a>}
          </p>
        </form>
      </div>

      <div className="panel flush">
        <h2>المصروفات <span className="count">{rows.length} معروضة</span></h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <SortHeader column="id" label="#" align="num" current={flags} />
                <SortHeader column="date" label="التاريخ" current={flags} />
                <SortHeader column="item" label="البند" current={flags} />
                <SortHeader column="apartment" label="الشقة" current={flags} />
                <SortHeader column="amount" label="المبلغ" align="num" current={flags} />
                <th>الطريقة</th>
                <th>المسئول</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="id">{r.id}</td>
                  <td>{day(r.spent_at)}</td>
                  <td className="wrap-cell">
                    {r.item ?? '—'}
                    {r.notes && <div className="faint" style={{ fontSize: 12 }}>{r.notes}</div>}
                  </td>
                  <td>{r.apartment ?? r.apartment_name ?? '—'}</td>
                  <td className="num">{num(r.amount)}</td>
                  <td className="faint">{r.payment_method ?? '—'}</td>
                  <td className="faint">{r.responsible ?? '—'}</td>
                  <td className="row">
                    <a href={link(flags, { edit: r.id })}>تعديل</a>
                    <form action={deleteExpense.bind(null, r.id)}>
                      <button className="link" type="submit">حذف</button>
                    </form>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={8}><Empty>لا توجد مصروفات بهذه الفلاتر.</Empty></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
