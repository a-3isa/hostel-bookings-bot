# Receptionist Booking-Entry Bot — Design

**Date:** 2026-06-28
**Status:** Approved (pending spec review)

## Goal

Repurpose the Telegram bot from a guest-facing booking flow into a single-purpose
**receptionist data-entry tool**. The receptionist answers a fixed sequence of
questions; the bot writes one row to the Google Sheet `Bookings` tab, matching the
sheet's Arabic column layout, computing several fields automatically.

## Scope

### Removed
- Language picker (always Arabic).
- Main menu / "Check My Booking" flow (`handlers/check_booking.py` unwired).
- Rules step.
- Location / room-availability / photos system.
- Admin room commands (`handlers/admin.py` unwired): `set_available`, `set_unavailable`,
  `add_room`, `remove_room`, `list_rooms`, `upload_photo`.
- `booking_ref` / booking counter / `utils/ref_generator.py` usage.
- Old check-in/check-out date pair.

### Behavior
- `/start` → immediately begins the new-booking conversation. Always Arabic.
- One question per conversation step.

## Field Sequence

Each numbered item is a question asked to the receptionist. Items marked **auto** are
computed, not asked.

| # | Field (sheet column) | Input method | Notes |
|---|---|---|---|
| 1 | `بوكنج ID` | text + "تخطي" (skip) button | optional; may be empty |
| 2 | `ID` (private) | text | manual, required |
| 3 | `اسم المقيم` | text | `validate_name` (allows Arabic) |
| 4 | `نوع الحجز` | **auto `بوكينج` if Booking ID filled (skip question)**; else buttons: `خارجي` / `بوكينج` | |
| 5 | `الجنسية` | buttons (full nationality list) | single select |
| 6 | `رقم الهاتف` | text | `validate_phone`; stored as text (keep leading 0) |
| 7 | `اسم الشقة` | 6 buttons: `ذاكر حسين`، `احمد فهيم`، `انبي 3`، `انبي 2`، `ابو حديد 11`، `عبدالله العربي` | |
| 8 | `رقم الغرفة` | buttons 1–5 | |
| 9 | `عدد الليالي` | buttons 1–9 + "∞ مفتوح"; manual text entry for >9 | infinity → live formula |
| 10 | `تاريخ البداية` | calendar (reuse `_cal_keyboard`, **allow past dates**) | written as real date |
| — | `تاريخ المغادرة` | **auto** | finite → `arrival + nights`; infinity → `=TODAY()` formula |
| 11 | `اجمالي سعر الحجز` | number text | |
| — | `نسبة البرنامج` | **auto** | `بوكينج` → `0.13 × total`; else `0` |
| — | `صافي الدخل` | **auto** | `total − نسبة البرنامج` |
| 12 | `طريقة الدفع` | buttons (full payment list) | single select |
| 13 | `اجمالي ما تم دفعه` | number text | |
| — | `المتبقي` | **auto** | `total − paid` |
| 14 | `ملاحظات` | text + skip button | optional |
| — | `تاريخ الإدخال` | **auto** | today (`YYYY-MM-DD`) |

After the last step: show a confirmation summary → on confirm, write the row.

## Button list values

**نوع الحجز (when Booking ID empty):** `خارجي`, `بوكينج`

**اسم الشقة:** `ذاكر حسين`, `احمد فهيم`, `انبي 3`, `انبي 2`, `ابو حديد 11`, `عبدالله العربي`

**الجنسية:** `أردني`, `أمريكي`, `أوروبي`, `إماراتي`, `بحريني`, `سعودي`, `سوداني`, `سوري`,
`عراقي`, `عماني`, `فلسطيني`, `قطري`, `كويتي`, `لبناني`, `اسباني`, `مصري`, `مغربي`,
`يمني`, `صيني`, `ليبي`, `ماليزي`

**طريقة الدفع:** `كاش`, `انستاباي`, `Airbnb`, `بوكنج`, `فودافون كاش`,
`فودافون كاش علي رقم شاكر`, `علي شاكر`, `غير مدفوع`, `وي باي`, `يورو`, `دولار`

## Computation rules

Given numeric `total`, `paid`, and booking type `btype`:

```
نسبة البرنامج = 0.13 * total   if btype == "بوكينج"   else 0
صافي الدخل    = total - نسبة البرنامج
المتبقي       = total - paid
```

All three written as numbers.

## Nights / departure mechanism

### Finite nights (receptionist typed a number `n`)
- `عدد الليالي` = `n` (integer)
- `تاريخ المغادرة` = `arrival + n days`, written `YYYY-MM-DD`

### Infinity ("∞ مفتوح" button)
Both cells become **live formulas** that recompute daily:
- `عدد الليالي` = `=TODAY()-J{row}`  (J = `تاريخ البداية` column)
- `تاريخ المغادرة` = `=TODAY()`

Because formulas reference the row, the writer must know the row index. Implementation:
1. Append the row (with placeholder/empty values in the two formula cells) using
   `value_input_option="USER_ENTERED"`.
2. Parse the appended row index from the API response (`updatedRange`).
3. Patch the two formula cells (and confirm column letters from the header) with
   `USER_ENTERED`.

Dates are written as `YYYY-MM-DD` strings with `USER_ENTERED`, so Sheets stores them as
real dates — required for `TODAY()-arrival` arithmetic to work.

### Leading-zero text fields

`USER_ENTERED` parses `01011130090` as a number and drops the leading zero. Fields that
are numeric strings but must stay text — `بوكنج ID`, `ID`, `رقم الهاتف`, `رقم الغرفة` —
are prefixed with a leading apostrophe (`_txt` helper). The apostrophe is Sheets' text
marker: hidden in display, preserved on read.

### Sheet header migration (done)

The live `Bookings` tab originally had old English headers (`booking_ref, room_id, …`)
plus 5 old-schema test rows, which is why writes silently produced blank rows. Migration
performed: the old tab was duplicated to `Bookings_old_backup`, then `Bookings` was cleared
and given the 19 Arabic headers (exact strings below).

## Sheets layer

New function `sheets.append_booking_row(row_by_header: dict, formula_cells: dict)`:
- `row_by_header`: dict keyed by exact Arabic header strings → cell values.
- Reads header row, builds the row in column order, appends with `USER_ENTERED`.
- `formula_cells`: optional `{header_name: formula_template}` patched after append using
  the resolved row index (templates may contain `{row}` and resolved column letters).

Exact headers (column order A→S — note `بوكنج ID` spelling and the totals/نسبة order):
```
بوكنج ID, ID, اسم المقيم, نوع الحجز, الجنسية, رقم الهاتف, اسم الشقة, رقم الغرفة,
عدد الليالي, تاريخ البداية, تاريخ المغادرة, اجمالي سعر الحجز, اجمالي ما تم دفعه,
نسبة البرنامج, طريقة الدفع, المتبقي, ملاحظات, تاريخ الإدخال, صافي الدخل
```
Writer maps by header name, so physical column order is irrelevant to the code — but
header strings must match the sheet exactly.

Unused old `sheets.py` helpers (rooms/locations/counter/`append_booking`/`get_booking_by_ref`)
may remain but are no longer wired; remove if trivial.

## Conversation states

`ConversationHandler` states (one per asked field plus auto transitions):
`BOOKING_ID, PRIVATE_ID, NAME, BTYPE, NATIONALITY, PHONE, APARTMENT, ROOM, NIGHTS,
ARRIVAL, TOTAL, PAYMENT, PAID, NOTES, CONFIRM`.

- Text steps use `MessageHandler(filters.TEXT & ~filters.COMMAND, ...)`.
- Button steps use `CallbackQueryHandler` with per-step patterns.
- Skip buttons (`بوكنج ID`, `ملاحظات`) are `CallbackQueryHandler` alongside the text handler.
- `تاريخ البداية` reuses the existing calendar keyboard/nav handlers, with `min_date` set
  far in the past to allow walk-in / back-dated entries.
- Fallbacks: `/cancel`, `/start` reset.

## Validation

- Name: `validate_name` (already supports Arabic letters + spaces, min 3).
- Phone: `validate_phone` (digits, optional leading `+`, min 7).
- Numbers (`total`, `paid`, `nights`): parse as number; reject non-numeric with a retry
  message.

## Strings

`strings.py` reduced to Arabic-only keys for the new flow (prompts, error messages,
button labels, confirmation summary, success/cancel). English table and old guest keys
removed.

## Addendum (2026-06-28) — external target sheet + group post

The bot now writes to a **different** spreadsheet that owns its own formulas:
`BOOKINGS_SHEET_ID` (default `1CiHciOe…84S8`), tab `إدخال الحجوزات` (`BOOKINGS_TAB`).

That tab's columns **B (ID via COUNTA), K (تاريخ المغادرة = J+I), N (نسبة البرنامج via
`Dashboard!B20` = 13.1%), R (تاريخ الإدخال = TODAY()), S (صافي الدخل = L−N)** are fill-down
formulas extending ~170 rows past the real data. Therefore:

- **True last row** is found via `len(col_values(C))` (اسم المقيم — a manual column), not
  `append_row` (which would land in the formula zone). Write at `last+1`.
- The bot writes **only input columns** via `batch_update` of three ranges
  (`A:J`, `L:M`, `O:Q`), leaving formula cells K, N, R, S intact so the sheet recomputes.
  Per request, column **B (ID) is overwritten** with the typed private ID.
- The bot no longer computes نسبة / صافي / تاريخ المغادرة — the sheet does. It still
  computes **المتبقي = total − paid** (column P has no formula). Open-ended stay → column I
  gets `=TODAY()-J{row}`, and the sheet's K formula yields TODAY() automatically.

After a confirmed save, the booking is posted to a Telegram group (`GROUP_CHAT_ID`, default
`-5001910339`). Group post is best-effort: failure shows `saved_no_group` but the row is
already saved.

**Operational prerequisites:**
1. Share the target spreadsheet with the service account
   `host-account@bookingbot-498501.iam.gserviceaccount.com` as **Editor** (currently it has
   read-only access → writes return `403`).
2. Add the bot to the Telegram group with send permission; verify the numeric chat id
   (supergroups need a `-100…` prefix).

## Out of scope

- Editing existing rows.
- Reading/looking up bookings.
- Receptionist Telegram-ID allowlist (not requested).
