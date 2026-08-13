const money = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function num(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? money.format(n) : String(value);
}

export function day(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

// A <input type="date"> wants yyyy-mm-dd and nothing else.
export function dateInput(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

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
