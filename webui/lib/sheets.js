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

async function tabId() {
  const meta = await api('?fields=sheets(properties(sheetId,title))');
  const tab = meta.sheets?.find((s) => s.properties.title === BOOKINGS_TAB);
  if (!tab) {
    throw new Error(
      `التبويب "${BOOKINGS_TAB}" غير موجود في هذا الملف — تأكد أن BOOKINGS_SHEET_ID يشير إلى ملف الحجوزات الصحيح.`,
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
