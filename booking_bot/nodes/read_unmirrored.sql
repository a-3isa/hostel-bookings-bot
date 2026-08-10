-- Bookings the database has and the spreadsheet does not.
--
-- Everything the web UI creates lands here: it writes Postgres directly, so
-- until something appends a row the booking is invisible to the sheet, to the
-- 1,606 formulas in the other nine tabs, and to the daily report.
--
-- Column names are the sheet's own headers, so the Google Sheets node maps them
-- by name; `booking_id` carries the id through for the update that follows and
-- matches no header, so it is ignored on the way in.
--
-- `mirrored_at is null` is the guard against appending the same booking every
-- morning. An append does not report which row it landed on, so the timestamp is
-- the marker rather than sheet_row, and reindex.py learns the real row from
-- column U on its next pass.
--
-- Formulas use INDIRECT("I"&ROW()) rather than the I{row} the bot writes, for
-- the same reason: nothing here knows the row number yet, and ROW() does.
select
  b.id                                             as booking_id,
  coalesce(nullif(b.booking_ref, ''), '')          as "بوكنج ID",
  case when b.guest_ref is null or b.guest_ref = '' then ''
       else '''' || b.guest_ref end                as "ID",
  coalesce(b.guest_name, '')                       as "اسم المقيم",
  coalesce(b.booking_type, '')                     as "نوع الحجز",
  case when b.phone is null or b.phone = '' then ''
       else '''' || b.phone end                    as "رقم الهاتف",
  coalesce(b.apartment_name, '')                   as "اسم الشقة",
  coalesce(b.room_number, '')                      as "رقم الغرفة",
  case when b.open_ended then '=TODAY()-INDIRECT("J"&ROW())'
       else coalesce(b.nights::text, '') end       as "عدد الليالي",
  coalesce(to_char(b.arrival, 'YYYY-MM-DD'), '')   as "تاريخ البداية",
  case when b.open_ended and b.nightly_rate is not null
         then '=' || trim(to_char(b.nightly_rate, 'FM999999999.##'))
              || '*INDIRECT("I"&ROW())'
       else coalesce(trim(to_char(b.total, 'FM999999999.##')), '') end
                                                   as "اجمالي سعر الحجز",
  coalesce(trim(to_char(b.paid, 'FM999999999.##')), '') as "اجمالي ما تم دفعه",
  coalesce(b.payment_method, '')                   as "طريقة الدفع",
  coalesce(b.notes, '')                            as "ملاحظات",
  b.id::text                                       as "معرف النظام"
from bookings b
where b.sheet_row is null
  and b.mirrored_at is null
  and b.cancelled_at is null
  -- The sheet has one paid cell, and "650 EGP + 40 USD" is not a number that
  -- fits in it. Left for a human, listed by mixed_currency_bookings.
  and not exists (
    select 1 from payments p
    where p.booking_id = b.id
    group by p.booking_id having count(distinct p.currency) > 1
  )
order by b.id;
