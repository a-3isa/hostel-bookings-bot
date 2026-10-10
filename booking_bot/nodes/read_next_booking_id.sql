-- The ID the bot offers for the next booking: one past the previous one this
-- month, so nobody has to remember it. Asked for on 2026-10-01.
--
-- The numbering restarts every month. When the bookings tab rolls over, the
-- guests still staying are carried into the new month with their old ID marked
-- `111**` ("the ** means that the booking is from the past month, so now the
-- new month begins and the id should reset"). So only bookings created this
-- calendar month, Cairo time, count, and a starred ID never does. The first
-- booking of a month is offered 1.
--
-- ID is text typed by hand, so only plain counters count: Arabic-Indic digits
-- are folded to ASCII first, the way brain.js reads them, and anything longer
-- than six digits is left out — ID is sometimes a passport or national number,
-- and one of those would push every suggestion into the millions. Cancelled
-- bookings stay in: their number is still spent.
--
-- A suggestion, not an allocation: the receptionist can type another number,
-- and two people starting at once are offered the same one.
select coalesce(max(ref::int), 0) + 1 as next_booking_id
  from (select btrim(translate(guest_ref, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
                                           '01234567890123456789')) as ref
          from bookings
         where created_at >= date_trunc('month', now() at time zone 'Africa/Cairo')
                               at time zone 'Africa/Cairo') b
 where ref ~ '^[0-9]{1,6}$';
