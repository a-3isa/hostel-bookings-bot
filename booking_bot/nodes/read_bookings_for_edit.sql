-- Phase 4b: the lookup and the availability check read Postgres, not Sheets.
-- Column aliases reproduce the sheet's headers exactly, so brain.js consumes
-- this the way it consumed the Sheets node and needs no change.
--
-- bookings_live, NOT bookings_model, and the reason matters. The model folds a
-- guest's continuation lines into one booking, which is right for a report and
-- wrong here: this feeds the EDIT path, which writes back to a sheet row by
-- number. Offer مروان as one 2200 row and the next payment lands on line 22
-- while line 23 still holds its 1600 — the sheet would double-count. So this
-- stays line-for-line with the sheet, exactly as the Sheets node was: all 55
-- lines, cancelled ones included, because findConflicts() skips those by their
-- ملغي note and the edit flow can still reach them.
--
-- '=OPEN' is deliberate. An open-ended stay arrived from the FORMULA read as
-- '=TODAY()-J5', and both findConflicts() and showValue() key off that leading
-- '='. Keeping the sentinel keeps that contract; Phase 5 replaces it with the
-- open_ended boolean and deletes the sniffing.
select
  b.sheet_row                                          as row_number,
  coalesce(b.booking_ref, '')                          as "بوكنج ID",
  coalesce(b.guest_ref, '')                            as "ID",
  coalesce(b.guest_name, '')                           as "اسم المقيم",
  coalesce(b.booking_type, '')                         as "نوع الحجز",
  coalesce(b.phone, '')                                as "رقم الهاتف",
  coalesce(b.apartment_name, '')                       as "اسم الشقة",
  coalesce(b.room_number, '')                          as "رقم الغرفة",
  case when b.open_ended then '=OPEN'
       else coalesce(b.effective_nights::text, '') end as "عدد الليالي",
  coalesce(to_char(b.arrival, 'YYYY-MM-DD'), '')       as "تاريخ البداية",
  coalesce(to_char(b.departure, 'YYYY-MM-DD'), '')     as "تاريخ المغادرة",
  coalesce(trim(to_char(b.effective_total, 'FM999999999.##')), '')     as "اجمالي سعر الحجز",
  coalesce(trim(to_char(b.paid, 'FM999999999.##')), '')                as "اجمالي ما تم دفعه",
  coalesce(b.payment_method, '')                       as "طريقة الدفع",
  coalesce(trim(to_char(b.effective_remaining, 'FM999999999.##')), '') as "المتبقي",
  coalesce(b.notes, '')                                as "ملاحظات"
from bookings_live b
order by b.sheet_row;
