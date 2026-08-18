// Push one booking to the spreadsheet, right after the dashboard changed it.
//
// Until 2026-08-18 the dashboard wrote Postgres and stopped there, and an edit
// reached the sheet only when somebody ran `supabase/mirror.py` — so the nine
// other tabs and their 1,606 formulas went on showing the old number until they
// did. This closes that gap for the row the user just touched.
//
// It is deliberately NOT a second mirror. It does one booking, it refuses
// anything it is not certain about, and everything it refuses is left exactly
// as it was for `supabase/mirror.py` to sweep up on its next run. The failure
// mode is "the sheet is stale", which is where this started, and never "the
// sheet is wrong".
//
// Three things it will not do:
//
//   * write a row whose column U does not name this booking — see checkRow.
//     That cell is the only thing standing between a write and someone else's
//     line, since row numbers shift whenever anybody inserts a line by hand.
//   * touch a mixed-currency booking. The sheet has one paid cell and
//     "650 EGP + 40 USD" is not a number.
//   * flatten a formula in the two bot-owned columns that can hold one.
//     supabase/mirror.py reads every row a second time with FORMULA rendering
//     and skips any cell starting with `=` (sheet_owned_keys). That is a round
//     trip per save, which this path cannot afford, so it reconstructs the two
//     instead: عدد الليالي on an open stay is rebuilt as =TODAY()-J<row>, and
//     اجمالي سعر الحجز by priceCell when the booking is priced by a nightly
//     rate. K, N, P, R, S and T never appear in WRITE_BLOCKS at all.
//   * throw. A Sheets outage must not fail the save the user just made; the
//     database is the record and the mirror is the retry.

import { one, q, tx } from './db';
import {
  blockEnd, expensePayload, linePayload, planAllocation, primaryPayload,
} from './mirror';
import {
  checkExpenseRow, checkRow, deleteExpenseRow, firstFreeExpenseRow, firstFreeRow,
  insertLineRow, sheetsConfigured, writeExpenseRow, writeRow,
} from './sheets';

// The booking as the mirror needs to see it: its own row, every continuation
// LINE it occupies with that line's money summed, and the payments that have
// not been assigned to a line yet. Same shape as SELECT in supabase/mirror.py.
const SHAPE = `
  select
    b.id, b.sheet_row, b.booking_ref, b.guest_ref, b.guest_name, b.booking_type,
    b.phone, b.apartment_name, b.room_number, b.arrival, b.nights, b.open_ended,
    b.total, b.paid, b.payment_method, b.notes,
    -- The parts the price cell is rebuilt from when the sheet holds a formula
    -- rather than a number. effective_total is what that formula produces
    -- today, which is how priceCell tells "still the formula" from "somebody
    -- typed a price".
    b.nightly_rate, b.total_adjustment, b.effective_total,
    (select count(distinct p.currency) > 1
       from payments p where p.booking_id = b.id) as mixed_currency,
    (select coalesce(jsonb_agg(jsonb_build_object(
              'id', l.id, 'seq', l.line_seq, 'sheet_row', l.sheet_row,
              'amount', sums.amount, 'method', l.method, 'currency', l.currency)
              order by l.line_seq), '[]'::jsonb)
       from booking_lines l
       join lateral (select coalesce(sum(p.amount), 0) as amount
                       from payments p
                      where p.booking_id = l.booking_id
                        and p.line_seq = l.line_seq) sums on true
      where l.booking_id = b.id) as lines,
    (select coalesce(jsonb_agg(jsonb_build_object(
              'id', p.id, 'amount', p.amount, 'method', p.method,
              'currency', p.currency) order by p.paid_at, p.id), '[]'::jsonb)
       from payments p
      where p.booking_id = b.id and p.line_seq is null) as unallocated,
    (select p.currency from payments p
      where p.booking_id = b.id and p.line_seq = 1
      order by p.id limit 1) as primary_currency
  from bookings_live b
  where b.id = $1
`;

// Everything below this row moves down by one, in all three tables that
// remember a row number. Renumbered through negatives first: sheet_row is
// UNIQUE and not deferrable, so a single incrementing UPDATE collides with a
// row it has not reached yet.
async function shiftRowsDown(client, atRow) {
  for (const table of ['bookings', 'payments', 'booking_lines']) {
    await client.query(
      `update ${table} set sheet_row = -(sheet_row + 1) where sheet_row >= $1`, [atRow]);
    await client.query(
      `update ${table} set sheet_row = -sheet_row where sheet_row < 0`);
  }
}

// Gives a new line a row in the sheet and a row in the database, in that order:
// if the insert fails there is no orphan line pointing at a row that does not
// exist. The row lands directly under the booking's block, purple, with the
// formatting and fill-down formulas of the row above.
async function openLine(booking, line) {
  const atRow = blockEnd(booking) + 1;
  await insertLineRow(atRow);
  return tx(async (client) => {
    const created = (await client.query(
      `insert into booking_lines (booking_id, line_seq, method, currency)
       values ($1,$2,$3,$4) returning id`,
      [booking.id, line.seq, line.method || null, line.currency],
    )).rows[0];
    await client.query(
      'update payments set line_seq = $1 where id = any($2)',
      [line.seq, line.payment_ids]);
    await shiftRowsDown(client, atRow);
    await client.query(
      'update booking_lines set sheet_row = $1 where id = $2', [atRow, created.id]);
    return { id: created.id, sheet_row: atRow };
  });
}

// Appends a booking the dashboard created — it has no row of its own yet, which
// is the only way a UI booking becomes visible to the sheet at all.
async function seatBooking(booking) {
  const row = await firstFreeRow();
  await q('update bookings set sheet_row = $1 where id = $2', [row, booking.id]);
  return row;
}

/**
 * Publish one booking. Returns what happened, for the caller to surface:
 *
 *   {published: true}                       the sheet now matches
 *   {published: false, reason: '...'}       left for supabase/mirror.py
 *
 * Never throws.
 */
export async function publishBooking(bookingId) {
  if (!sheetsConfigured()) return { published: false, reason: 'not-configured' };

  try {
    let booking = await one(SHAPE, [bookingId]);
    if (!booking) return { published: false, reason: 'no-booking' };
    if (booking.mixed_currency) return { published: false, reason: 'mixed-currency' };

    // Assign any loose payments before deciding what the rows say — a payment
    // that opens a line changes both the line's row and the booking's own
    // paid cell.
    const { merges, opens, adopted } = planAllocation(booking);

    for (const m of merges) {
      await q('update payments set line_seq = $1 where id = $2', [m.seq, m.payment_id]);
    }
    if (adopted) {
      await q(`update bookings set payment_method = coalesce(nullif(payment_method,''), $2)
                where id = $1`, [booking.id, adopted.method]);
    }

    if (!booking.sheet_row) {
      // A booking with no row cannot have lines yet, so seat it first and let
      // any new line be opened underneath on the next pass through.
      await seatBooking(booking);
      booking = await one(SHAPE, [bookingId]);
    }

    // Rows this call created. They are blank and unstamped by definition, so
    // the identity guard below would refuse them — and it should, for any row
    // it did not just make itself.
    const fresh = new Set();
    for (const line of opens) {
      const created = await openLine(booking, line);
      fresh.add(created.sheet_row);
      booking = await one(SHAPE, [bookingId]);
    }

    // Re-read once more if a merge or an adoption changed the money.
    if (merges.length || adopted) booking = await one(SHAPE, [bookingId]);

    const lines = booking.lines ?? [];
    const guard = await checkRow(booking.sheet_row, booking.id);
    if (!guard.ok) return { published: false, reason: guard.reason, found: guard.found };

    await writeRow(booking.sheet_row,
                   primaryPayload(booking, lines, booking.sheet_row));

    for (const line of lines) {
      if (!line.sheet_row) continue;
      if (!fresh.has(line.sheet_row)) {
        const lineGuard = await checkRow(line.sheet_row, `${booking.id}-${line.seq}`);
        // A line whose stamp does not match is left alone for the same reason
        // a booking's is: the row may be someone else's now.
        if (!lineGuard.ok) continue;
      }
      await writeRow(line.sheet_row, linePayload(booking, line, line.sheet_row));
    }

    return { published: true, rows: 1 + lines.length };
  } catch (err) {
    // The database already has the change. Staying quiet here and letting the
    // mirror catch up is strictly better than failing a save that succeeded.
    console.error('publishBooking failed', bookingId, err);
    return { published: false, reason: 'error', error: String(err.message ?? err) };
  }
}

// ── expenses ────────────────────────────────────────────────────────────────
//
// Same posture as publishBooking: one row, refuse anything uncertain, never
// throw. The difference is how a row is recognised. A booking row names its
// booking in column U; an expense row names nothing, so the guard compares the
// two cells that identify it against what the database believed was written
// there. See checkExpenseRow in lib/sheets.js for why column H is not usable.

const EXPENSE_SHAPE = `
  select e.id, e.sheet_row, e.item, e.amount, e.notes, e.payment_method,
         e.responsible, e.spent_at,
         coalesce(e.apartment_name, a.name) as apartment_name
    from expenses e
    left join apartments a on a.id = e.apartment_id
   where e.id = $1
`;

/**
 * Publish one expense.
 *
 * `was` is what the sheet is expected to still show — for an edit, the item and
 * amount as they were BEFORE it, since the sheet has not been told yet. Omit it
 * for a new expense.
 *
 * Never throws.
 */
export async function publishExpense(expenseId, was = null) {
  if (!sheetsConfigured()) return { published: false, reason: 'not-configured' };

  try {
    const expense = await one(EXPENSE_SHAPE, [expenseId]);
    if (!expense) return { published: false, reason: 'no-expense' };

    let row = expense.sheet_row;
    if (!row) {
      // Never seen by the sheet: it gets the first free row at the bottom. No
      // insert, so nothing below moves and no row number goes stale.
      row = await firstFreeExpenseRow();
      await q('update expenses set sheet_row = $1 where id = $2', [row, expense.id]);
    } else {
      const guard = await checkExpenseRow(row, was ?? expense);
      if (!guard.ok) return { published: false, reason: guard.reason, found: guard.found };
    }

    await writeExpenseRow(row, expensePayload(expense));
    return { published: true, row };
  } catch (err) {
    console.error('publishExpense failed', expenseId, err);
    return { published: false, reason: 'error', error: String(err.message ?? err) };
  }
}

/**
 * Take a deleted expense's row out of the sheet, closing the gap.
 *
 * Called AFTER the database row is gone, with what it held, so the guard still
 * has something to recognise the row by. Every expense below moves up one and
 * `expenses.sheet_row` is renumbered to match — two passes through negatives,
 * because that column is UNIQUE and a single decrement collides with a row it
 * has not reached yet.
 *
 * Never throws. A refusal leaves the row in the sheet, which the next backfill
 * would simply re-import — visible, and better than deleting the wrong line.
 */
export async function retireExpenseRow(row, was) {
  if (!sheetsConfigured()) return { published: false, reason: 'not-configured' };
  if (!row) return { published: false, reason: 'no-row' };

  try {
    const guard = await checkExpenseRow(row, was);
    if (!guard.ok) return { published: false, reason: guard.reason, found: guard.found };

    await tx(async (client) => {
      await client.query(
        'update expenses set sheet_row = -(sheet_row - 1) where sheet_row > $1', [row]);
      await client.query(
        'update expenses set sheet_row = -sheet_row where sheet_row < 0');
      // Inside the transaction: if Google refuses, the rollback puts every row
      // number back and nothing has happened anywhere.
      await deleteExpenseRow(row);
    });
    return { published: true, row };
  } catch (err) {
    console.error('retireExpenseRow failed', row, err);
    return { published: false, reason: 'error', error: String(err.message ?? err) };
  }
}
