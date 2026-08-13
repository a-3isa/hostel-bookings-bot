'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { COOKIE, sessionToken, signedIn } from '../lib/auth';
import { one, pgPool, q, tx } from '../lib/db';
import { checkRow, insertPaymentRow, sheetsConfigured } from '../lib/sheets';
import { bool, integer, number, text } from '../lib/fmt';

// Everything the dashboard writes is marked so it can be told apart later. The
// `source` check constraint only permits bot/backfill/sheet, so provenance goes
// in created_by instead of inventing a fourth source value the database would
// reject.
const WEB = 'لوحة الويب';

async function requireAuth() {
  if (!(await signedIn())) redirect('/login');
}

export async function login(formData) {
  const password = process.env.DASHBOARD_PASSWORD;
  const given = String(formData.get('password') ?? '');
  const next = String(formData.get('next') ?? '/') || '/';

  if (!password || given !== password) {
    redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }

  const jar = await cookies();
  jar.set(COOKIE, sessionToken(password), {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  redirect(next.startsWith('/') ? next : '/');
}

export async function logout() {
  const jar = await cookies();
  jar.delete(COOKIE);
  redirect('/login');
}

// ── bookings ────────────────────────────────────────────────────────────────

// The room select carries a rooms.id. The sheet-shaped text columns are filled
// from the registry so a row stays readable on its own, exactly as the bot
// writes it.
async function roomFields(formData) {
  const roomId = integer(formData, 'room_id');
  if (roomId === null) {
    return {
      room_id: null,
      apartment_name: text(formData, 'apartment_name'),
      room_number: text(formData, 'room_number'),
    };
  }
  const room = await one(
    `select r.id, r.number, a.name as apartment
       from rooms r join apartments a on a.id = r.apartment_id
      where r.id = $1`,
    [roomId],
  );
  return {
    room_id: room ? room.id : null,
    apartment_name: room ? room.apartment : text(formData, 'apartment_name'),
    room_number: room ? room.number : text(formData, 'room_number'),
  };
}

function bookingFields(formData, room) {
  const openEnded = bool(formData, 'open_ended');
  return {
    booking_ref: text(formData, 'booking_ref'),
    guest_ref: text(formData, 'guest_ref'),
    guest_name: text(formData, 'guest_name'),
    booking_type: text(formData, 'booking_type'),
    phone: text(formData, 'phone'),
    room_id: room.room_id,
    apartment_name: room.apartment_name,
    room_number: room.room_number,
    arrival: text(formData, 'arrival'),
    // An open-ended stay has no night count; storing one would make the
    // generated `departure` column invent a checkout that has not happened.
    nights: openEnded ? null : integer(formData, 'nights'),
    open_ended: openEnded,
    nightly_rate: number(formData, 'nightly_rate'),
    total: number(formData, 'total'),
    paid: number(formData, 'paid') ?? 0,
    payment_method: text(formData, 'payment_method'),
    notes: text(formData, 'notes'),
  };
}

export async function createBooking(formData) {
  await requireAuth();
  const room = await roomFields(formData);
  const f = bookingFields(formData, room);

  const created = await one(
    `insert into bookings (booking_ref, guest_ref, guest_name, booking_type, phone,
                           room_id, apartment_name, room_number, arrival, nights,
                           open_ended, nightly_rate, total, paid, payment_method,
                           notes, created_by, source)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'bot')
     returning id`,
    [f.booking_ref, f.guest_ref, f.guest_name, f.booking_type, f.phone,
     f.room_id, f.apartment_name, f.room_number, f.arrival, f.nights,
     f.open_ended, f.nightly_rate, f.total, f.paid, f.payment_method,
     f.notes, WEB],
  );

  revalidatePath('/');
  revalidatePath('/bookings');
  redirect(`/bookings/${created.id}?saved=1`);
}

export async function saveBooking(id, formData) {
  await requireAuth();
  const room = await roomFields(formData);
  const f = bookingFields(formData, room);

  await tx(async (client) => {
    const before = (await client.query('select * from bookings where id = $1', [id])).rows[0];
    if (!before) return;

    const after = (await client.query(
      `update bookings set booking_ref=$2, guest_ref=$3, guest_name=$4, booking_type=$5,
              phone=$6, room_id=$7, apartment_name=$8, room_number=$9, arrival=$10,
              nights=$11, open_ended=$12, nightly_rate=$13, total=$14, paid=$15,
              payment_method=$16, notes=$17, updated_at=now()
        where id=$1 returning *`,
      [id, f.booking_ref, f.guest_ref, f.guest_name, f.booking_type, f.phone,
       f.room_id, f.apartment_name, f.room_number, f.arrival, f.nights,
       f.open_ended, f.nightly_rate, f.total, f.paid, f.payment_method, f.notes],
    )).rows[0];

    // booking_audit is what /undo reads. A web edit is exactly the kind of
    // change someone will want to take back.
    await client.query(
      `insert into booking_audit (booking_id, changed_by, before, after)
       values ($1,$2,$3,$4)`,
      [id, WEB, JSON.stringify(before), JSON.stringify(after)],
    );
  });

  revalidatePath('/');
  revalidatePath('/bookings');
  redirect(`/bookings/${id}?saved=1`);
}

export async function setCancelled(id, cancelled) {
  await requireAuth();
  await tx(async (client) => {
    const before = (await client.query('select * from bookings where id = $1', [id])).rows[0];
    if (!before) return;
    const after = (await client.query(
      `update bookings set cancelled_at = case when $2 then now() else null end,
              updated_at = now()
        where id = $1 returning *`,
      [id, cancelled],
    )).rows[0];
    await client.query(
      `insert into booking_audit (booking_id, changed_by, before, after)
       values ($1,$2,$3,$4)`,
      [id, WEB, JSON.stringify(before), JSON.stringify(after)],
    );
  });

  revalidatePath('/');
  revalidatePath('/bookings');
  redirect(`/bookings/${id}?saved=1`);
}

// Deleting a booking lives in app/bookings/[id]/delete/confirm/route.js, not
// here: see the comment there for why a server action is the wrong tool for it.

// ── payments ────────────────────────────────────────────────────────────────
//
// Deliberately does NOT touch bookings.paid. That column mirrors the sheet's
// cumulative paid cell for one sheet line, and the sheet is still authoritative;
// silently recomputing it from these rows would put the two systems out of step
// without anyone deciding to. The booking page shows both figures side by side
// and says so when they disagree.

// A second payment in a different method is the one thing the sheet cannot hold
// on a single line — one paid cell, one method cell. What people do by hand is
// insert a row underneath carrying the extra amount and its method, and that is
// all this does.
//
// The booking's own method cell (O) is left exactly as it was, in the sheet and
// in the database: formulas on the sheet read those values, and `متعدد` is not
// one of the words they know. It is a dashboard label only — the table derives
// it from the number of payment rows, and the real methods stay where the
// formulas expect them.
//
// The sheet write only happens when column U proves the row is this booking. If
// it cannot, the payment is still recorded in Postgres and the page says the
// sheet was left alone — a wrong row number here would insert a line in the
// middle of someone else's booking.
export async function addPayment(bookingId, formData) {
  await requireAuth();
  const amount = number(formData, 'amount');
  if (amount === null) redirect(`/bookings/${bookingId}?error=amount`);

  const method = text(formData, 'method');
  const currency = text(formData, 'currency');
  const paidAt = text(formData, 'paid_at');

  const booking = await one(
    'select id, sheet_row, guest_name, payment_method from bookings where id = $1',
    [bookingId],
  );
  if (!booking) redirect('/bookings');

  const existing = await one(
    'select count(*)::int as n from payments where booking_id = $1', [bookingId],
  );

  const row = booking.sheet_row === null ? null : Number(booking.sheet_row);
  const wantsRow = existing.n >= 1;
  let verdict = { ok: false, reason: row === null ? 'no-row' : 'sheets-config' };

  if (wantsRow && row !== null && sheetsConfigured()) {
    try {
      verdict = await checkRow(row, bookingId);
    } catch (err) {
      console.error('sheet check failed', err);
      verdict = { ok: false, reason: 'sheets-error' };
    }
  }

  const client = await pgPool().connect();
  let outcome = wantsRow ? `line=${verdict.ok ? 'added' : verdict.reason}` : 'saved=1';
  try {
    await client.query('begin');

    if (!wantsRow || !verdict.ok) {
      // First payment, or no provable row: just record it.
      await client.query(
        `insert into payments (booking_id, amount, method, currency, paid_at, source)
         values ($1,$2,$3,coalesce($4,'EGP'),coalesce($5::timestamptz, now()),'bot')`,
        [bookingId, amount, method, currency, paidAt],
      );
    } else {
      // Inserting a sheet row pushes everything below it DOWN by one. Renumber
      // through negative values first: `sheet_row` is UNIQUE and not deferrable,
      // so a single incrementing UPDATE would collide with a row it has not
      // reached yet.
      for (const table of ['bookings', 'payments']) {
        await client.query(
          `update ${table} set sheet_row = -(sheet_row + 1) where sheet_row > $1`, [row],
        );
        await client.query(`update ${table} set sheet_row = -sheet_row where sheet_row < 0`);
      }

      // The continuation line is a real sheet row, so it is a real `bookings`
      // row too, pointed at its parent. That is the shape the backfill found in
      // the live data and the shape the reconcile compares against.
      const follower = (await client.query(
        `insert into bookings (guest_name, paid, payment_method, sheet_row, merged_into,
                               created_by, source)
         values ($1,$2,$3,$4,$5,$6,'bot') returning id`,
        [booking.guest_name, amount, method, row + 1, bookingId, WEB],
      )).rows[0];

      await client.query(
        `insert into payments (booking_id, amount, method, currency, paid_at, sheet_row, source)
         values ($1,$2,$3,coalesce($4,'EGP'),coalesce($5::timestamptz, now()),$6,'bot')`,
        [bookingId, amount, method, currency, paidAt, row + 1],
      );

      await insertPaymentRow(row, {
        guestName: booking.guest_name,
        amount,
        method,
        bookingId: follower.id,
      });
    }

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    console.error('addPayment failed', err);
    outcome = 'line=sheets-error';
  } finally {
    client.release();
  }

  revalidatePath('/bookings');
  revalidatePath(`/bookings/${bookingId}`);
  redirect(`/bookings/${bookingId}?${outcome}`);
}

export async function deletePayment(bookingId, paymentId) {
  await requireAuth();
  await q('delete from payments where id = $1 and booking_id = $2', [paymentId, bookingId]);
  revalidatePath(`/bookings/${bookingId}`);
  redirect(`/bookings/${bookingId}?saved=1`);
}

// ── expenses ────────────────────────────────────────────────────────────────

function expenseFields(formData) {
  return {
    expense_ref: text(formData, 'expense_ref'),
    item: text(formData, 'item'),
    amount: number(formData, 'amount'),
    apartment_id: integer(formData, 'apartment_id'),
    notes: text(formData, 'notes'),
    payment_method: text(formData, 'payment_method'),
    responsible: text(formData, 'responsible'),
    spent_at: text(formData, 'spent_at'),
  };
}

export async function createExpense(formData) {
  await requireAuth();
  const f = expenseFields(formData);

  const apartment = f.apartment_id
    ? await one('select name from apartments where id = $1', [f.apartment_id])
    : null;

  await q(
    `insert into expenses (expense_ref, item, amount, apartment_id, apartment_name,
                           notes, payment_method, responsible, spent_at, source)
     values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::timestamptz, now()),'bot')`,
    [f.expense_ref, f.item, f.amount, f.apartment_id, apartment?.name ?? null,
     f.notes, f.payment_method, f.responsible ?? WEB, f.spent_at],
  );

  revalidatePath('/expenses');
  redirect('/expenses?saved=1');
}

export async function saveExpense(id, formData) {
  await requireAuth();
  const f = expenseFields(formData);

  const apartment = f.apartment_id
    ? await one('select name from apartments where id = $1', [f.apartment_id])
    : null;

  await q(
    `update expenses set expense_ref=$2, item=$3, amount=$4, apartment_id=$5,
            apartment_name=$6, notes=$7, payment_method=$8, responsible=$9,
            spent_at=coalesce($10::timestamptz, spent_at)
      where id=$1`,
    [id, f.expense_ref, f.item, f.amount, f.apartment_id, apartment?.name ?? null,
     f.notes, f.payment_method, f.responsible, f.spent_at],
  );

  revalidatePath('/expenses');
  redirect('/expenses?saved=1');
}

export async function deleteExpense(id) {
  await requireAuth();
  await q('delete from expenses where id = $1', [id]);
  revalidatePath('/expenses');
  redirect('/expenses?saved=1');
}
