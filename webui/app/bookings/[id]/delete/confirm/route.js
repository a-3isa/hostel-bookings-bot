import { revalidatePath } from 'next/cache';
import { signedIn } from '../../../../../lib/auth';
import { one, pgPool } from '../../../../../lib/db';
import { checkRow, deleteRow, sheetsConfigured } from '../../../../../lib/sheets';

export const dynamic = 'force-dynamic';
// Sheets round trips plus the database work; the default 10s is tight.
export const maxDuration = 30;

// A plain POST target rather than a server action, deliberately.
//
// A server action that deletes the very row its own page renders leaves the
// client router with nothing to reconcile: the action returns its redirect, the
// router tries to refresh a route that now 404s, and the browser sits on a stale
// confirmation page while the booking is already gone. A form posting here gets
// a 303 the browser follows itself, with no router involved.
export async function POST(request, { params }) {
  if (!(await signedIn())) return new Response('Unauthorized', { status: 401 });

  const { id } = await params;
  const bookingId = Number(id);
  const origin = new URL(request.url).origin;
  const back = (reason) =>
    Response.redirect(`${origin}/bookings/${bookingId}/delete?error=${reason}`, 303);

  if (!Number.isInteger(bookingId)) return Response.redirect(`${origin}/bookings`, 303);

  const booking = await one('select id, sheet_row from bookings where id = $1', [bookingId]);
  if (!booking) return Response.redirect(`${origin}/bookings`, 303);

  // `merged_into` has no ON DELETE CASCADE, so a booking still carrying
  // continuation lines would raise a foreign key error. Refuse with a message
  // rather than a 500.
  const followers = await one(
    'select count(*)::int as n from bookings where merged_into = $1', [bookingId],
  );
  if (followers.n > 0) return back('followers');

  // Delete from wherever the booking actually exists. The sheet row is only
  // taken when it can be PROVEN to be this booking: rows shift whenever someone
  // inserts a line, so acting on a stale sheet_row would delete an innocent
  // guest's line. Anything short of proof degrades to a database-only delete,
  // which is always safe — the row stays, and the reconcile reports it.
  const row = booking.sheet_row === null ? null : Number(booking.sheet_row);
  let verdict = { ok: false, reason: row === null ? 'no-row' : 'sheets-config' };

  if (row !== null && sheetsConfigured()) {
    try {
      verdict = await checkRow(row, bookingId);
    } catch (err) {
      console.error('sheet check failed', err);
      verdict = { ok: false, reason: 'sheets-error' };
    }
  }

  // The database work and the sheet call are wrapped together: the transaction
  // commits only after Google has accepted the row deletion, so a failed API
  // call leaves the database exactly as it was.
  const client = await pgPool().connect();
  try {
    await client.query('begin');
    await client.query('delete from bookings where id = $1', [bookingId]);

    if (verdict.ok) {
      // Deleting a sheet row closes the gap, so every row below it moves up by
      // one and every stored sheet_row below it is now off by one. Renumber in
      // two passes through negative values: `sheet_row` is UNIQUE and not
      // deferrable, so a single decrementing UPDATE would collide with a row it
      // has not reached yet.
      for (const table of ['bookings', 'payments']) {
        await client.query(
          `update ${table} set sheet_row = -(sheet_row - 1) where sheet_row > $1`, [row],
        );
        await client.query(
          `update ${table} set sheet_row = -sheet_row where sheet_row < 0`,
        );
      }

      // Inside the transaction on purpose: if Google refuses, the rollback puts
      // the booking back and nothing has happened anywhere.
      await deleteRow(row);
    }

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    console.error('delete failed', err);
    return back('sheets-error');
  } finally {
    client.release();
  }

  revalidatePath('/');
  revalidatePath('/bookings');

  const outcome = verdict.ok
    ? `deleted=both&row=${row}`
    : `deleted=db&why=${verdict.reason}`;
  return Response.redirect(`${origin}/bookings?${outcome}`, 303);
}
