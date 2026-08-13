import { signedIn } from '../../../lib/auth';
import { q } from '../../../lib/db';
import { buildWhere, orderBy, parseParams } from '../../../lib/filters';

export const dynamic = 'force-dynamic';

const HEADERS = [
  ['id', 'ID'],
  ['sheet_row', 'صف الشيت'],
  ['guest_name', 'الضيف'],
  ['phone', 'التليفون'],
  ['guest_ref', 'ID الضيف'],
  ['booking_ref', 'بوكنج ID'],
  ['booking_type', 'نوع الحجز'],
  ['apartment_name', 'الشقة'],
  ['room_number', 'الغرفة'],
  ['arrival', 'الوصول'],
  ['departure', 'المغادرة'],
  ['effective_nights', 'الليالي'],
  ['effective_total', 'الإجمالي'],
  ['paid', 'المدفوع'],
  ['effective_remaining', 'المتبقي'],
  ['payment_method', 'طريقة الدفع'],
  ['cancelled_at', 'ملغي في'],
  ['notes', 'ملاحظات'],
];

function cell(value) {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(request) {
  // The middleware already gates this path, but a route handler that streams the
  // whole table deserves its own check rather than trusting the matcher.
  if (!(await signedIn())) return new Response('Unauthorized', { status: 401 });

  const filters = parseParams(Object.fromEntries(new URL(request.url).searchParams));
  const where = buildWhere(filters);

  const rows = await q(
    `select ${HEADERS.map(([key]) => `b.${key}`).join(', ')}
       from bookings_live b
       ${where.sql}
       ${orderBy(filters)}
      limit 5000`,
    where.params,
  );

  const csv = [
    HEADERS.map(([, label]) => label).join(','),
    ...rows.map((row) => HEADERS.map(([key]) => cell(row[key])).join(',')),
  ].join('\r\n');

  // Excel reads a UTF-8 CSV as the system codepage unless it finds a BOM, which
  // turns every Arabic guest name into mojibake.
  return new Response(`﻿${csv}`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="bookings-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
