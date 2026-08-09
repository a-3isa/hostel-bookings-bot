/**
 * Offline harness for the Phase 3 reconcile nodes.
 *
 *     node booking_bot/test_reconcile.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const snapSrc = readFileSync(join(HERE, 'nodes', 'build_snapshot_sql.js'), 'utf8');
const msgSrc = readFileSync(join(HERE, 'nodes', 'build_reconcile_message.js'), 'utf8');
const snapFn = new Function('$', '$input', snapSrc);
const msgFn = new Function('$', '$input', msgSrc);

const CONFIG = { TIMEZONE: 'Africa/Cairo', REPORT_GROUP_CHAT_ID: '-5057362381' };

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` → ${JSON.stringify(detail)}` : ''}`); }
}
function section(n) { console.log(`\n${n}`); }

const balanced = (t) =>
  (t.match(/(?<!\\)\*/g) || []).length % 2 === 0 &&
  (t.match(/(?<!\\)_/g) || []).length % 2 === 0;

const row = (o) => ({
  'اسم المقيم': 'ضيف', 'اسم الشقة': 'انبي 2', 'رقم الغرفة': '3',
  'تاريخ البداية': '2026-08-01', 'عدد الليالي': 3,
  'اجمالي سعر الحجز': 1200, 'اجمالي ما تم دفعه': 1200,
  'طريقة الدفع': 'كاش', 'ملاحظات': '', ...o,
});

function snapshot(rows) {
  const withNums = rows.map((j, i) => ({ ...j, row_number: i + 2 }));
  const formulaRead = withNums.map(j => ({
    row_number: j.row_number,
    'عدد الليالي': j.__open ? `=TODAY()-J${j.row_number}` : j['عدد الليالي'],
  }));
  const $ = (name) => {
    if (name === 'Read Report Formulas') return { all: () => formulaRead.map(json => ({ json })) };
    return { first: () => ({ json: CONFIG }) };
  };
  const out = snapFn($, { all: () => withNums.map(json => ({ json })) });
  return out.length ? out[0].json : null;
}

function message(discrepancies, checked = 46) {
  const $ = (name) => {
    if (name === 'Build Snapshot SQL') return { first: () => ({ json: { rows: checked } }) };
    return { first: () => ({ json: CONFIG }) };
  };
  const items = discrepancies.length ? discrepancies : [{}];   // n8n hands over an empty item
  return msgFn($, { all: () => items.map(json => ({ json })) })[0].json;
}

section('snapshot');
let s = snapshot([row(), row({ 'اسم المقيم': 'تاني' })]);
check('one statement, wrapped in a transaction',
  s.sql.startsWith('begin;') && s.sql.trim().endsWith('commit;'), s.sql.slice(0, 40));
check('replaces the snapshot wholesale', s.sql.includes('delete from sheet_snapshot'), s.sql);
check('counts the rows it captured', s.rows === 2, s.rows);
check('row numbers are the true sheet rows',
  s.sql.includes('(2, ') && s.sql.includes('(3, '), s.sql);

s = snapshot([row({ 'اسم المقيم': "O'Brien" })]);
check('apostrophes escaped', s.sql.includes("'O''Brien'"), s.sql);

s = snapshot([row({ 'اسم المقيم': '' }), row()]);
check('formula-only tail rows are skipped', s.rows === 1, s.rows);

check('a completely empty read never blanks the snapshot',
  snapshot([row({ 'اسم المقيم': '' })]) === null);

section('message: clean');
let m = message([]);
check('goes to the reports group', m.chat_id === '-5057362381');
check('says so plainly', m.text.startsWith('✅ *مطابقة*'), m.text);
check('reports how many were checked', m.text.includes('46 حجز'), m.text);
check('posts even when clean, so silence means broken', Boolean(m.text));

section('message: differences');
m = message([
  { sheet_row: 5, problem: 'differs', sheet_guest: 'أحمد', db_guest: 'أحمد',
    sheet_apt: 'انبي 2', db_apt: 'انبي 2', sheet_room: '3', db_room: '3',
    sheet_arrival: '2026-08-01', db_arrival: '2026-08-01',
    sheet_nights: 3, db_nights: 3,
    sheet_total: 1500, db_total: 1200, sheet_paid: 500, db_paid: 500 },
  { sheet_row: 9, problem: 'missing in db', sheet_guest: 'سارة' },
  { sheet_row: 12, problem: 'missing in sheet', db_guest: 'خالد' },
]);
check('headline counts both sides', m.text.includes('3 من 46'), m.text);
check('missing-in-db listed', m.text.includes('سارة') && m.text.includes('صف 9'), m.text);
check('missing-in-sheet listed', m.text.includes('خالد') && m.text.includes('صف 12'), m.text);
check('only the field that differs is named',
  m.text.includes('الاجمالي: 1500 ≠ 1200'), m.text);
check('fields that match are not mentioned',
  !m.text.includes('الغرفة') && !m.text.includes('البداية'), m.text);

section('message: markdown cannot be broken by a guest name');
m = message([{ sheet_row: 5, problem: 'missing in db', sheet_guest: 'ضيف_مهم *جدا*' }]);
check('escaped and balanced', balanced(m.text), m.text);

section('message: a flood is truncated, not sent whole');
m = message(Array.from({ length: 40 }, (_, i) =>
  ({ sheet_row: i + 2, problem: 'missing in db', sheet_guest: `ضيف ${i}` })));
check('capped at 20 lines per section',
  (m.text.match(/^• /gm) || []).length <= 20, (m.text.match(/^• /gm) || []).length);
check('says where to see the rest', m.text.includes('reconcile\\_bookings'), m.text);
check('and that literal is escaped too — it broke a real send', balanced(m.text), m.text);

section('message: dates render as dates, not ISO timestamps');
m = message([{ sheet_row: 5, problem: 'differs',
  sheet_guest: 'أ', db_guest: 'أ',
  sheet_arrival: '2026-08-02T21:00:00.000Z', db_arrival: '2026-08-03T21:00:00.000Z' }]);
check('no ISO noise', !m.text.includes('T21:00:00'), m.text);
check('shows plain dates', m.text.includes('2026-08-02 ≠ 2026-08-03'), m.text);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
