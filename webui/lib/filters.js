// Everything the bookings table can be sliced by, in one place, so the page,
// the CSV export and the pager all read the same URL the same way.

// Sorting is a whitelist mapped to SQL, never string interpolation of user
// input.
//
// The default is the sheet's own ID column (B, `guest_ref`), sorted as a NUMBER:
// it holds digits typed by hand, so a plain text sort files 10 between 1 and 2.
// Rows with no ID at all sort last, and b.id breaks ties because guest_ref is
// not unique in this data (5 and 16 each appear twice).
// Values are ARRAYS of expressions, not comma-joined strings: the guest_ref
// expression contains commas of its own, and splitting on them would produce
// fragments of SQL.
export const SORTS = {
  guest_ref: [`nullif(regexp_replace(b.guest_ref, '[^0-9]', '', 'g'), '')::bigint`],
  id: ['b.id'],
  sheet_row: ['b.sheet_row'],
  guest: ['b.guest_name'],
  apartment: ['b.apartment_name'],
  // Room numbers are text but read as numbers, same as guest_ref.
  room: [`nullif(regexp_replace(b.room_number, '[^0-9]', '', 'g'), '')::bigint`],
  arrival: ['b.arrival'],
  departure: ['b.departure'],
  nights: ['b.effective_nights'],
  total: ['b.effective_total'],
  paid: ['b.paid'],
  remaining: ['b.effective_remaining'],
};

export const STATUSES = [
  ['all', 'الكل'],
  ['staying', 'مقيم الآن'],
  ['upcoming', 'قادم'],
  ['departed', 'غادر'],
  ['owing', 'عليه متبقي'],
  ['settled', 'مسدد'],
  ['open', 'إقامة مفتوحة'],
  ['cancelled', 'ملغي'],
];

export const PER_PAGE = [25, 50, 100, 200];

export function parseParams(raw = {}) {
  const get = (key) => {
    const value = raw[key];
    const one = Array.isArray(value) ? value[0] : value;
    return one === undefined || one === null || one === '' ? '' : String(one).trim();
  };

  const sort = SORTS[get('sort')] ? get('sort') : 'guest_ref';
  const perRaw = Number(get('per'));
  const per = PER_PAGE.includes(perRaw) ? perRaw : 50;
  const page = Math.max(1, Number(get('page')) || 1);

  return {
    q: get('q'),
    status: STATUSES.some(([k]) => k === get('status')) ? get('status') : 'all',
    apartment: get('apartment'),
    method: get('method'),
    type: get('type'),
    from: get('from'),
    to: get('to'),
    minRemaining: get('min_remaining'),
    // Continuation lines are real sheet rows but not real bookings, so the
    // default view hides them and the total money stops being double counted.
    lines: get('lines') === 'all' ? 'all' : 'main',
    sort,
    dir: get('dir') === 'asc' ? 'asc' : 'desc',
    per,
    page,
  };
}

// Turns the parsed filters into a WHERE clause plus its parameters. Returns the
// parameter array so callers can keep appending (limit/offset) after it.
export function buildWhere(f) {
  const clauses = [];
  const params = [];
  const p = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (f.lines === 'main') clauses.push('b.merged_into is null');

  switch (f.status) {
    case 'staying':
      clauses.push(`b.cancelled_at is null and b.arrival <= current_date
                    and (b.departure is null or b.departure > current_date)`);
      break;
    case 'upcoming':
      clauses.push('b.cancelled_at is null and b.arrival > current_date');
      break;
    case 'departed':
      clauses.push('b.cancelled_at is null and b.departure <= current_date');
      break;
    case 'owing':
      clauses.push('b.cancelled_at is null and b.effective_remaining > 0');
      break;
    case 'settled':
      clauses.push('b.cancelled_at is null and b.effective_remaining <= 0');
      break;
    case 'open':
      clauses.push('b.cancelled_at is null and b.open_ended');
      break;
    case 'cancelled':
      clauses.push('b.cancelled_at is not null');
      break;
    default:
      break;
  }

  if (f.q) {
    const like = p(`%${f.q}%`);
    clauses.push(`(b.guest_name ilike ${like} or b.phone ilike ${like}
                   or b.guest_ref ilike ${like} or b.booking_ref ilike ${like}
                   or b.apartment_name ilike ${like} or b.notes ilike ${like}
                   or b.id::text = ${p(f.q)} or b.sheet_row::text = ${p(f.q)})`);
  }

  if (f.apartment) clauses.push(`b.apartment_name = ${p(f.apartment)}`);
  if (f.method) clauses.push(`b.payment_method = ${p(f.method)}`);
  if (f.type) clauses.push(`b.booking_type = ${p(f.type)}`);
  if (f.from) clauses.push(`b.arrival >= ${p(f.from)}::date`);
  if (f.to) clauses.push(`b.arrival <= ${p(f.to)}::date`);
  if (f.minRemaining) clauses.push(`b.effective_remaining >= ${p(f.minRemaining)}::numeric`);

  return {
    sql: clauses.length ? `where ${clauses.join(' and ')}` : '',
    params,
  };
}

export function orderBy(f) {
  const direction = f.dir === 'asc' ? 'asc' : 'desc';
  const column = SORTS[f.sort]
    .map((part) => `${part} ${direction} nulls last`)
    .join(', ');
  // b.id is the tiebreak so pagination never shows the same row twice.
  return `order by ${column}, b.id ${direction}`;
}

// Rebuilds the query string with one or two values changed — what every sort
// header, pager link and filter chip is made of.
export function withParams(current, changes) {
  const params = new URLSearchParams();
  const base = {
    q: current.q,
    status: current.status === 'all' ? '' : current.status,
    apartment: current.apartment,
    method: current.method,
    type: current.type,
    from: current.from,
    to: current.to,
    min_remaining: current.minRemaining,
    lines: current.lines === 'main' ? '' : current.lines,
    sort: current.sort === 'guest_ref' ? '' : current.sort,
    dir: current.dir === 'desc' ? '' : current.dir,
    per: current.per === 50 ? '' : String(current.per),
    page: current.page === 1 ? '' : String(current.page),
    ...changes,
  };

  for (const [key, value] of Object.entries(base)) {
    if (value !== '' && value !== undefined && value !== null) params.set(key, String(value));
  }

  const query = params.toString();
  return query ? `?${query}` : '';
}
