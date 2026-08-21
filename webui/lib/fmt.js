const money = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function num(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? money.format(n) : String(value);
}

// yyyy-mm-dd from a Date's own calendar parts. NOT via toISOString(), which
// converts to UTC first.
//
// `arrival`, `departure` and `from_date` are Postgres `date` columns: no time
// and no zone. node-postgres parses a bare `2026-08-15` into a JS Date at LOCAL
// midnight, so under `TZ=Africa/Cairo` toISOString() gives back 2026-08-14 —
// the page displays the wrong day, the edit form pre-fills the wrong day, and
// saving writes that shift into the database and out to column J of the sheet,
// where `=TODAY()-J<row>` turns it into a night of billing.
//
// Vercel pins TZ=UTC, so this only ever bit `next dev` — which is exactly the
// setup that talks to the LIVE sheet from Egypt.
//
// `lib/mirror.js` has the same rule as `dateOnly()`, for the value it sends to
// Sheets; the two must agree, and `supabase/mirror.py` gets it for free from
// `datetime.date.isoformat()`.
export function calendarDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function day(value) {
  if (!value) return '—';
  return calendarDate(value) ?? String(value);
}

// A <input type="date"> wants yyyy-mm-dd and nothing else.
export function dateInput(value) {
  if (!value) return '';
  return calendarDate(value) ?? '';
}

// The one helper that deliberately stays on UTC.
//
// It formats `expenses.spent_at`, a timestamptz, into the datetime-local input
// whose value is cast straight back with `$n::timestamptz` — and the sheet's
// التاريخ column is written by `mirror.stamp()`, which is UTC on purpose and
// verified against the live tab. Reading in local and writing in UTC would move
// every expense by the offset on each save.
export function dateTimeInput(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16);
}

// Form fields come back as '' for "left blank", which is not the same as 0 and
// not the same as "unchanged". Everything below turns '' into null so the
// database stores an absence rather than a zero.
export function text(form, field) {
  const raw = form.get(field);
  if (raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed === '' ? null : trimmed;
}

export function number(form, field) {
  const raw = text(form, field);
  if (raw === null) return null;
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function integer(form, field) {
  const n = number(form, field);
  return n === null ? null : Math.trunc(n);
}

export function bool(form, field) {
  return form.get(field) === 'on' || form.get(field) === 'true';
}
