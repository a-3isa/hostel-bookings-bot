import BookingsTable from '../../components/BookingsTable';
import { q } from '../../lib/db';
import { PER_PAGE, STATUSES, buildWhere, orderBy, parseParams, withParams } from '../../lib/filters';
import { num } from '../../lib/fmt';

export const dynamic = 'force-dynamic';

// Why a delete touched the database only. Each one is a case where deleting a
// sheet row could have hit the wrong line.
const DB_ONLY = {
  'no-row': 'هذا الحجز ليس له صف في الشيت',
  unstamped: 'صف الشيت لا يحمل معرف النظام في العمود U',
  mismatch: 'العمود U في ذلك الصف يشير إلى حجز آخر',
  'sheets-config': 'الاتصال بجوجل شيت غير مضبوط على الخادم',
  'sheets-error': 'تعذر الوصول إلى جوجل شيت',
};

export default async function BookingsPage({ searchParams }) {
  const raw = await searchParams;
  const filters = parseParams(raw);
  const where = buildWhere(filters);

  // count(*) over () rides along with the page of rows, so the pager knows the
  // total without a second scan.
  const params = [...where.params, filters.per, (filters.page - 1) * filters.per];
  const rows = await q(
    `select b.id, b.guest_ref, b.sheet_row, b.guest_name, b.phone, b.apartment_name, b.room_number,
            b.arrival, b.departure, b.open_ended, b.effective_nights, b.effective_total,
            b.paid, b.effective_remaining, b.payment_method, b.cancelled_at, b.merged_into,
            (select count(*) from payments p where p.booking_id = b.id) as payments_n,
            count(*) over () as total_rows,
            sum(b.effective_remaining) over () as page_remaining,
            sum(b.paid) over () as page_paid
       from bookings_live b
       ${where.sql}
       ${orderBy(filters)}
      limit $${where.params.length + 1} offset $${where.params.length + 2}`,
    params,
  );

  const [facets, options] = await Promise.all([
    q(`select
         count(*) filter (where merged_into is null) as all_n,
         count(*) filter (where cancelled_at is null and arrival <= current_date
                            and (departure is null or departure > current_date)) as staying,
         count(*) filter (where cancelled_at is null and arrival > current_date) as upcoming,
         count(*) filter (where cancelled_at is null and effective_remaining > 0
                            and merged_into is null) as owing,
         count(*) filter (where cancelled_at is null and open_ended) as open_n,
         count(*) filter (where cancelled_at is not null) as cancelled
       from bookings_live`),
    q(`select
         (select array_agg(distinct apartment_name order by apartment_name)
            from bookings where apartment_name is not null) as apartments,
         (select array_agg(distinct payment_method order by payment_method)
            from bookings where payment_method is not null) as methods,
         (select array_agg(distinct booking_type order by booking_type)
            from bookings where booking_type is not null) as types`),
  ]);

  const counts = facets[0];
  const opts = options[0];
  const total = rows.length ? Number(rows[0].total_rows) : 0;
  const pages = Math.max(1, Math.ceil(total / filters.per));
  const chips = [
    ['all', 'الكل', counts.all_n],
    ['staying', 'مقيم الآن', counts.staying],
    ['upcoming', 'قادم', counts.upcoming],
    ['owing', 'عليه متبقي', counts.owing],
    ['open', 'إقامة مفتوحة', counts.open_n],
    ['cancelled', 'ملغي', counts.cancelled],
  ];

  return (
    <>
      {raw?.deleted === 'both' && (
        <div className="banner good">
          <span className="ico">✓</span>
          <div>
            تم حذف الحجز من قاعدة البيانات ومن الشيت (الصف {raw.row})، وأُعيد ترقيم
            صفوف الشيت المخزّنة للحجوزات أسفله.
          </div>
        </div>
      )}
      {raw?.deleted === 'db' && (
        <div className="banner">
          <span className="ico">ℹ</span>
          <div>
            تم حذف الحجز من قاعدة البيانات فقط — {DB_ONLY[raw.why] ?? 'تعذر التحقق من صف الشيت'}.
            لم يُمس أي صف في الشيت.
          </div>
        </div>
      )}

      <div className="chips">
        {chips.map(([value, label, n]) => (
          <a
            key={value}
            className="chip"
            aria-current={filters.status === value ? 'true' : undefined}
            href={withParams(filters, { status: value === 'all' ? '' : value, page: '' })}
          >
            {label}<span className="n">{n}</span>
          </a>
        ))}
      </div>

      <div className="panel">
        <form className="filters" method="get">
          {/* The sort lives in the URL, so it has to survive a filter submit. */}
          <input type="hidden" name="sort" value={filters.sort} />
          <input type="hidden" name="dir" value={filters.dir} />
          <input type="hidden" name="status" value={filters.status} />

          <label className="field">
            بحث
            <input name="q" defaultValue={filters.q} placeholder="اسم، تليفون، ID، ملاحظة" />
          </label>
          <label className="field">
            الشقة
            <select name="apartment" defaultValue={filters.apartment}>
              <option value="">الكل</option>
              {(opts.apartments ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="field">
            طريقة الدفع
            <select name="method" defaultValue={filters.method}>
              <option value="">الكل</option>
              {(opts.methods ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="field">
            نوع الحجز
            <select name="type" defaultValue={filters.type}>
              <option value="">الكل</option>
              {(opts.types ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="field">
            وصول من
            <input type="date" name="from" defaultValue={filters.from} />
          </label>
          <label className="field">
            وصول إلى
            <input type="date" name="to" defaultValue={filters.to} />
          </label>
          <label className="field">
            متبقي لا يقل عن
            <input name="min_remaining" inputMode="decimal" defaultValue={filters.minRemaining} />
          </label>
          <label className="field">
            السطور
            <select name="lines" defaultValue={filters.lines}>
              <option value="main">الحجوزات فقط</option>
              <option value="all">كل سطور الشيت</option>
            </select>
          </label>
          <label className="field">
            لكل صفحة
            <select name="per" defaultValue={String(filters.per)}>
              {PER_PAGE.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <div className="actions">
            <button type="submit">تطبيق</button>
            <a className="btn ghost" href="/bookings">مسح</a>
          </div>
        </form>
      </div>

      <div className="panel flush">
        <div className="pager" style={{ borderBottom: '1px solid var(--line)' }}>
          <strong style={{ color: 'var(--ink)' }}>{total}</strong> نتيجة
          {rows.length > 0 && (
            <span className="faint">
              · متبقي في هذه الصفحة {num(rows[0].page_remaining)} · مدفوع {num(rows[0].page_paid)}
            </span>
          )}
          <span className="spacer" />
          <a className="btn ghost sm" href={`/bookings/export${withParams(filters, { page: '' })}`}>
            تصدير CSV
          </a>
          <a className="btn sm" href="/bookings/new">حجز جديد</a>
        </div>

        <BookingsTable rows={rows} filters={filters} />

        {pages > 1 && (
          <div className="pager" style={{ borderTop: '1px solid var(--line)' }}>
            <a
              className="btn ghost sm"
              href={withParams(filters, { page: String(Math.max(1, filters.page - 1)) })}
              aria-disabled={filters.page === 1}
            >
              السابق
            </a>
            <span>صفحة {filters.page} من {pages}</span>
            <a
              className="btn ghost sm"
              href={withParams(filters, { page: String(Math.min(pages, filters.page + 1)) })}
              aria-disabled={filters.page === pages}
            >
              التالي
            </a>
          </div>
        )}
      </div>

      <p className="muted">
        الترتيب الافتراضي بعمود ID (العمود B في الشيت) تنازليًا، ورقميًا لا نصيًا
        حتى لا يأتي 10 بين 1 و2. الصفوف بلا ID تأتي في الآخر. اضغط أي عنوان عمود
        لتغيير الترتيب.
      </p>
    </>
  );
}
