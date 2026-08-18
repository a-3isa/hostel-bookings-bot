import { revalidatePath } from 'next/cache';
import { signedIn } from '../../../../../lib/auth';
import { one, pgPool, q } from '../../../../../lib/db';
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

  // EVERY row the booking occupies, not just its own.
  //
  // A booking paid in two methods holds a continuation row as well, and
  // `booking_lines` cascades when the booking goes — so until 2026-08-18 that
  // row was left behind in the sheet with nothing in the database describing
  // it. Delete مروان and his 1,600 انستاباي line stayed on the tab, orphaned,
  // for `reindex.py` to report as an id no booking has.
  const lines = await q(
    `select line_seq, sheet_row from booking_lines
      where booking_id = $1 and sheet_row is not null
      order by line_seq`, [bookingId]);

  const claimed = [
    { row: booking.sheet_row === null ? null : Number(booking.sheet_row),
      stamp: String(bookingId) },
    ...lines.map((l) => ({ row: Number(l.sheet_row),
                           stamp: `${bookingId}-${l.line_seq}` })),
  ];

  // A row is only taken when it can be PROVEN to be the one we mean: rows shift
  // whenever someone inserts a line, so acting on a stale sheet_row would
  // delete an innocent guest's line. Anything short of proof degrades to a
  // database-only delete, which is always safe — the row stays, and the
  // reconcile reports it.
  let verdict = { ok: false, reason: claimed[0].row === null ? 'no-row' : 'sheets-config' };
  const proven = [];

  if (claimed[0].row !== null && sheetsConfigured()) {
    try {
      for (const c of claimed) {
        const check = await checkRow(c.row, c.stamp);
        if (c.stamp === String(bookingId)) verdict = check;
        if (check.ok) proven.push(c.row);
      }
    } catch (err) {
      console.error('sheet check failed', err);
      verdict = { ok: false, reason: 'sheets-error' };
      proven.length = 0;
    }
  }

  // Highest row first. Deleting row 25 moves row 26 up to 25, so a list taken
  // before any of it happened is only safe to act on from the bottom.
  proven.sort((a, b) => b - a);

  // The database work and the sheet call are wrapped together: the transaction
  // commits only after Google has accepted the row deletion, so a failed API
  // call leaves the database exactly as it was.
  const client = await pgPool().connect();
  try {
    await client.query('begin');
    await client.query('delete from bookings where id = $1', [bookingId]);

    // Deleting a sheet row closes the gap, so every row below it moves up by one
    // and every stored sheet_row below it is now off by one. Renumber in two
    // passes through negative values: `sheet_row` is UNIQUE and not deferrable,
    // so a single decrementing UPDATE would collide with a row it has not
    // reached yet.
    //
    // All THREE tables that remember a row number, `booking_lines` included. It
    // was missing until 2026-08-18: delete a booking sitting above a
    // continuation line and that line went on claiming its old row, which by
    // then belonged to somebody else. Nothing was corrupted — the column U
    // check refuses a row whose stamp has changed — but the line stopped being
    // written and only `reindex.py` put it back. The insert side
    // (shiftRowsDown in lib/publish.js) has always covered all three.
    //
    // One pass per row, highest first, so each shift sees the sheet as it is by
    // then. The booking and its lines are already out of these tables — the
    // delete above cascaded — so this only moves everybody else.
    for (const gone of proven) {
      for (const table of ['bookings', 'payments', 'booking_lines']) {
        await client.query(
          `update ${table} set sheet_row = -(sheet_row - 1) where sheet_row > $1`, [gone],
        );
        await client.query(
          `update ${table} set sheet_row = -sheet_row where sheet_row < 0`,
        );
      }

      // Inside the transaction on purpose: if Google refuses, the rollback puts
      // the booking back and nothing has happened anywhere.
      await deleteRow(gone);
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
    ? `deleted=both&row=${proven[proven.length - 1]}&rows=${proven.length}`
    : `deleted=db&why=${verdict.reason}`;
  return Response.redirect(`${origin}/bookings?${outcome}`, 303);
}
