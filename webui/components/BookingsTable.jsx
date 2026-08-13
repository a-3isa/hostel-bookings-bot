import BookingRow from './BookingRow';
import RowMenu from './RowMenu';
import { withParams } from '../lib/filters';
import { day, num } from '../lib/fmt';

const COLUMNS = [
  // Column B of the sheet, headed "ID". Not the surrogate key and not unique.
  ['guest_ref', 'ID', 'num'],
  ['guest', 'الضيف', ''],
  ['apartment', 'الشقة', ''],
  ['room', 'الغرفة', 'num'],
  ['arrival', 'الوصول', ''],
  ['departure', 'المغادرة', ''],
  ['nights', 'الليالي', 'num'],
  ['total', 'الإجمالي', 'num'],
  ['paid', 'المدفوع', 'num'],
  ['remaining', 'المتبقي', 'num'],
];

function SortHeader({ column, label, align, filters }) {
  const active = filters.sort === column;
  // Clicking the active column flips direction; a new column starts descending,
  // except the text columns where A→Z is the useful first press.
  const nextDir = active
    ? (filters.dir === 'asc' ? 'desc' : 'asc')
    : (['guest', 'apartment', 'room'].includes(column) ? 'asc' : 'desc');

  return (
    <th className={align}>
      <a
        href={withParams(filters, { sort: column, dir: nextDir, page: '' })}
        aria-sort={active ? (filters.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      >
        {label}
        <span className="arrow">{active ? (filters.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </a>
    </th>
  );
}

export default function BookingsTable({ rows, filters }) {
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            {COLUMNS.map(([key, label, align]) => (
              <SortHeader key={key} column={key} label={label} align={align} filters={filters} />
            ))}
            <th>الدفع</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const staying = r.arrival && new Date(r.arrival) <= new Date()
              && (!r.departure || new Date(r.departure) > new Date())
              && !r.cancelled_at;

            return (
              <BookingRow key={r.id} id={r.id} className={r.cancelled_at ? 'cancelled' : ''}>
                <td className="id">{r.guest_ref ?? '—'}</td>
                <td className="guest">
                  <div className="row" style={{ gap: 6 }}>
                    <span>{r.guest_name ?? '—'}</span>
                    {staying && <span className="tag clear">مقيم</span>}
                    {r.merged_into && <span className="tag">سطر تابع</span>}
                    {r.cancelled_at && <span className="tag owing">ملغي</span>}
                  </div>
                  {/* A phone number inside RTL text gets its groups reordered by the
                      bidi algorithm unless it is explicitly marked LTR. */}
                  {r.phone && (
                    <div className="faint" style={{ fontSize: 12 }} dir="ltr">{r.phone}</div>
                  )}
                </td>
                <td>{r.apartment_name ?? '—'}</td>
                <td className="num">{r.room_number ?? '—'}</td>
                <td>{day(r.arrival)}</td>
                <td>{r.open_ended ? <span className="tag open">مفتوحة</span> : day(r.departure)}</td>
                <td className="num">{r.effective_nights ?? '—'}</td>
                <td className="num">{num(r.effective_total)}</td>
                <td className="num">{num(r.paid)}</td>
                <td className="num">
                  {Number(r.effective_remaining) > 0
                    ? <span className="tag owing">{num(r.effective_remaining)}</span>
                    : <span className="tag clear">مسدد</span>}
                </td>
                <td className="faint">
                  {/* Dashboard label only, derived from the payment count. The
                      sheet keeps the real method in its own cell because
                      formulas there switch on those exact words. */}
                  {Number(r.payments_n) > 1
                    ? (
                      <span className="tag info" title={r.payment_method ?? ''}>
                        متعدد ({r.payments_n})
                      </span>
                    )
                    : (r.payment_method ?? '—')}
                </td>
                <td>
                  <RowMenu
                    id={r.id}
                    name={r.guest_name}
                    guestRef={r.guest_ref}
                    sheetRow={r.sheet_row}
                  />
                </td>
              </BookingRow>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={12}>
                <div className="empty">لا توجد نتائج بهذه الفلاتر.</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
