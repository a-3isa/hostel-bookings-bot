import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

// A direct Sheets v4 client: a signed JWT and four fetch calls.
//
// This used to be the `googleapis` package. That pulled 92 transitive packages
// for the three endpoints in use here, two of them deprecated at install time
// (fetch-blob -> node-domexception, rimraf -> glob@10). Service-account auth is
// an RS256 JWT exchanged for a token, which node:crypto does natively.

export const BOOKINGS_TAB = 'إدخال الحجوزات';

// Column U (معرف النظام) holds the booking's database id, stamped there by the
// bot. It is what makes writing to a row safe: row numbers shift when anyone
// inserts a line, that id does not.
const ID_COLUMN = 'U';
const NAME_COLUMN = 'C';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

// `SHEET_ID` in the bot's .env points at an older spreadsheet ("booking_bot")
// that has none of the Arabic tabs; the live one the database mirrors is the one
// `supabase/backfill.py` names. So BOOKINGS_SHEET_ID wins when both are set, and
// every call verifies the tab exists — a wrong id fails loudly instead of
// writing into the wrong document.
function spreadsheetId() {
  return process.env.BOOKINGS_SHEET_ID || process.env.SHEET_ID;
}

export function sheetsConfigured() {
  return Boolean(process.env.GOOGLE_CREDENTIALS_JSON && spreadsheetId());
}

// The bot's .env points GOOGLE_CREDENTIALS_JSON at a file; on Vercel there is no
// file to point at, so the same variable may instead hold the JSON itself, or
// base64 of it. Accept all three rather than making the two environments differ.
function credentials() {
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!raw) throw new Error('GOOGLE_CREDENTIALS_JSON is not set');

  const value = raw.trim();
  if (value.startsWith('{')) return JSON.parse(value);
  if (value.startsWith('./') || value.startsWith('/') || value.endsWith('.json')) {
    return JSON.parse(readFileSync(value, 'utf8'));
  }
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}

const b64url = (input) => Buffer.from(input).toString('base64url');

let cached = { token: null, expires: 0 };

async function accessToken() {
  // Tokens last an hour; a lambda that handles two requests should not ask twice.
  if (cached.token && Date.now() < cached.expires) return cached.token;

  const creds = credentials();
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: creds.client_email,
    scope: SCOPE,
    aud: creds.token_uri,
    iat: now,
    exp: now + 3600,
  };

  const body = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(body).sign(creds.private_key, 'base64url');

  const res = await fetch(creds.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${body}.${signature}`,
    }),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`Google auth failed: ${json.error_description ?? res.status}`);

  cached = { token: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 };
  return cached.token;
}

async function api(path, init = {}) {
  const res = await fetch(`${API}/${spreadsheetId()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${json.error?.message ?? text}`);
  return json;
}

async function tabId(title = BOOKINGS_TAB) {
  const meta = await api('?fields=sheets(properties(sheetId,title))');
  const tab = meta.sheets?.find((s) => s.properties.title === title);
  if (!tab) {
    throw new Error(
      `التبويب "${title}" غير موجود في هذا الملف — تأكد أن BOOKINGS_SHEET_ID يشير إلى ملف الحجوزات الصحيح.`,
    );
  }
  return tab.properties.sheetId;
}

const cell = (column, row) =>
  `${encodeURIComponent(`${BOOKINGS_TAB}!${column}${row}:${column}${row}`)}`;

// Reads the identity cells of one row: the guest name (C) and the id in U.
export async function readRowIdentity(rowNumber) {
  const data = await api(
    `/values:batchGet?ranges=${cell(NAME_COLUMN, rowNumber)}&ranges=${cell(ID_COLUMN, rowNumber)}`,
  );
  const [nameRange, idRange] = data.valueRanges ?? [];
  return {
    guestName: nameRange?.values?.[0]?.[0] ?? null,
    bookingId: idRange?.values?.[0]?.[0] ?? null,
  };
}

// Refuses unless the row really is the booking we mean. Every reason to refuse
// is a reason a blind write would have landed on someone else's line.
export async function checkRow(rowNumber, bookingId) {
  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    return { ok: false, reason: 'no-row' };
  }
  const found = await readRowIdentity(rowNumber);
  if (found.bookingId === null || found.bookingId === '') {
    return { ok: false, reason: 'unstamped', found };
  }
  if (String(found.bookingId).trim() !== String(bookingId)) {
    return { ok: false, reason: 'mismatch', found };
  }
  return { ok: true, found };
}

// Deletes the row outright, closing the gap — the same thing a person does with
// "delete row" in the UI, and with the same consequence: every row below moves
// up by one. Callers MUST renumber `sheet_row` to match.
export async function deleteRow(rowNumber) {
  await api('/:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: {
            sheetId: await tabId(),
            dimension: 'ROWS',
            // The API is 0-based and end-exclusive; sheet row numbers are 1-based.
            startIndex: rowNumber - 1,
            endIndex: rowNumber,
          },
        },
      }],
    }),
  });
}

// A continuation line used to be inserted from here, when a second payment in a
// different method meant a second row by definition. It does not any more: a
// payment joins the line of its own method and only a method not yet on the
// booking opens a row, which needs every line the booking occupies to decide.
// `supabase/mirror.py` is the one writer that knows them, and it inserts the
// row itself. Nothing in the dashboard writes rows to the bookings tab now.

// ── writing ─────────────────────────────────────────────────────────────────
//
// Added 2026-08-18, when the dashboard stopped being a Postgres-only client.
// Before this, an edit made here reached the sheet only when somebody ran
// `supabase/mirror.py`, and the nine other tabs went on showing the old number
// until they did.
//
// The rules these writes follow are `supabase/mirror.py`'s, ported in
// `lib/mirror.js` — same columns, same money, same allocation. The mirror is
// still the reconciler and still the only thing that repairs a row nobody has
// written correctly; this is the fast path for the row the user just touched.

// A–T are the sheet's own columns; U is the id the bot stamps. E (الجنسية) is
// retired and never written, and K, N, P, R, S and T are fill-down formulas
// that writing — even '' — destroys.
const WRITE_BLOCKS = [
  ['A', 'D', ['booking_ref', 'guest_ref', 'guest_name', 'booking_type']],
  ['F', 'J', ['phone', 'apartment_name', 'room_number', 'nights_cell', 'arrival']],
  ['L', 'M', ['total', 'paid']],
  ['O', 'O', ['payment_method']],
  ['Q', 'Q', ['notes']],
  ['U', 'U', ['booking_id']],
];

// Sent with a leading apostrophe so Sheets keeps them as text: a phone with a
// leading zero, or an id that looks like a number and is not one.
const TEXT_FORCED = new Set(['booking_ref', 'guest_ref', 'phone']);

// The fill a continuation row gets when this opens one. Must match
// LINE_ROW_COLOUR in supabase/mirror.py, or the same row is two colours
// depending on which writer got there first.
export const LINE_ROW_COLOUR = { red: 0.85, green: 0.78, blue: 0.93 };

const forced = (key, value) => {
  const v = value === null || value === undefined ? '' : String(value);
  return TEXT_FORCED.has(key) && v !== '' ? `'${v}` : v;
};

// Writes the columns the bot owns on one row. `payload` is keyed as
// lib/mirror.js builds it; a key it does not carry is written as empty, which
// is what clearing a field in the dashboard has to mean.
export async function writeRow(rowNumber, payload) {
  const data = WRITE_BLOCKS.map(([from, to, keys]) => ({
    range: `${BOOKINGS_TAB}!${from}${rowNumber}:${to}${rowNumber}`,
    values: [keys.map((k) => forced(k, payload[k]))],
  }));

  await api('/values:batchUpdate', {
    method: 'POST',
    // USER_ENTERED, not RAW: عدد الليالي on an open-ended stay is the live
    // formula =TODAY()-J<row> and has to arrive as one.
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
}

// The first row of the bookings tab with no guest name in C — where a booking
// the dashboard created belongs, since it has no row of its own yet.
export async function firstFreeRow() {
  const data = await api(
    `/values/${encodeURIComponent(`${BOOKINGS_TAB}!${NAME_COLUMN}2:${NAME_COLUMN}5000`)}`,
  );
  const names = data.values ?? [];
  let last = 1;
  names.forEach((cells, i) => {
    if (String(cells?.[0] ?? '').trim()) last = i + 2;
  });
  return last + 1;
}

// Opens a row for a continuation line, directly under the booking's block.
//
// `inheritFromBefore` carries down the formatting and the filled-down formulas
// of the row above — K, N, P, R, S and T, which are the sheet's and are never
// written by us. It also carries the booking row's own fill, which is why the
// row is repainted purple straight afterwards: a line is money, not a guest,
// and it should not look like one.
//
// Every row below this moves down by one. The CALLER must renumber sheet_row in
// bookings, payments and booking_lines to match, or the next write puts a
// guest's money on whoever moved into their number.
export async function insertLineRow(atRow) {
  const sheetId = await tabId();
  await api('/:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          insertDimension: {
            // 0-based and end-exclusive, unlike the row numbers everywhere else.
            range: { sheetId, dimension: 'ROWS', startIndex: atRow - 1, endIndex: atRow },
            inheritFromBefore: true,
          },
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: atRow - 1,
              endRowIndex: atRow,
              startColumnIndex: 0,
              endColumnIndex: 21,          // A–U
            },
            cell: { userEnteredFormat: { backgroundColor: LINE_ROW_COLOUR } },
            fields: 'userEnteredFormat.backgroundColor',
          },
        },
      ],
    }),
  });
}

// ── the expenses tab ────────────────────────────────────────────────────────
//
// Wired 2026-08-18. Nothing had ever mirrored expenses: supabase/mirror.py is
// bookings-only, so an expense entered in the dashboard lived in Postgres and
// the مصروفات عامة tab never heard about it.
//
// The identity problem is different here, and worse. A booking row carries its
// database id in column U; an expense row carries nothing of the kind. Column H
// (الرقم) looks like an id and is not one — it is a human reference, the bot has
// never written it, and a stale ٩٩٩٩٩ was once found sitting on somebody else's
// expense because of exactly that. So a row is recognised by what it SAYS: the
// item and the amount this expense had when it was last written. A row that no
// longer matches is refused and left for a person, the same posture the booking
// path takes when column U disagrees.

export const EXPENSES_TAB = 'مصروفات عامة';

// A تاريخ | B البند | C المبلغ | D الشقة | E ملاحظات | F طريقة الدفع |
// G اسم المسئول. H (الرقم) is deliberately absent: it is nobody's to write.
const EXPENSE_KEYS = ['spent_at', 'item', 'amount', 'apartment_name', 'notes',
                      'payment_method', 'responsible'];

const ITEM_COLUMN = 'B';
const AMOUNT_COLUMN = 'C';

const money = (v) => String(v ?? '').replace(/,/g, '').trim();

// What the sheet currently shows in the two cells that identify an expense.
export async function readExpenseIdentity(rowNumber) {
  const range = encodeURIComponent(
    `${EXPENSES_TAB}!${ITEM_COLUMN}${rowNumber}:${AMOUNT_COLUMN}${rowNumber}`);
  const data = await api(`/values/${range}`);
  const [item, amount] = data.values?.[0] ?? [];
  return { item: item ?? null, amount: amount ?? null };
}

// Refuses unless the row still holds the expense we mean. `was` is what the
// database believes is written there — for an edit that is the values BEFORE
// the edit, since the sheet has not been told about the new ones yet.
export async function checkExpenseRow(rowNumber, was) {
  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    return { ok: false, reason: 'no-row' };
  }
  const found = await readExpenseIdentity(rowNumber);
  if (!found.item && !found.amount) return { ok: false, reason: 'empty', found };
  if (String(found.item ?? '').trim() !== String(was.item ?? '').trim()) {
    return { ok: false, reason: 'mismatch', found };
  }
  if (money(found.amount) !== money(was.amount)) {
    return { ok: false, reason: 'mismatch', found };
  }
  return { ok: true, found };
}

export async function writeExpenseRow(rowNumber, payload) {
  await api('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: [{
        range: `${EXPENSES_TAB}!A${rowNumber}:G${rowNumber}`,
        values: [EXPENSE_KEYS.map((k) => {
          const v = payload[k];
          return v === null || v === undefined ? '' : String(v);
        })],
      }],
    }),
  });
}

// The first row of the expenses tab with no البند in B.
export async function firstFreeExpenseRow() {
  const range = encodeURIComponent(`${EXPENSES_TAB}!${ITEM_COLUMN}2:${ITEM_COLUMN}5000`);
  const data = await api(`/values/${range}`);
  const items = data.values ?? [];
  let last = 1;
  items.forEach((cells, i) => {
    if (String(cells?.[0] ?? '').trim()) last = i + 2;
  });
  return last + 1;
}

// Closes the gap, so every row below moves up by one. The CALLER must renumber
// expenses.sheet_row to match.
export async function deleteExpenseRow(rowNumber) {
  await api('/:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: {
            sheetId: await tabId(EXPENSES_TAB),
            dimension: 'ROWS',
            startIndex: rowNumber - 1,
            endIndex: rowNumber,
          },
        },
      }],
    }),
  });
}
