# Booking-or-Expense Routing + Expense Flow — Design

**Date:** 2026-06-30
**Status:** Approved

## Goal

Add a second data-entry flow (expenses) and a first-step router that lets the receptionist
choose **booking** or **expense**. One specific Telegram user (`@Seiiffseiif`) skips the
choice and always goes to the expense flow.

## Routing (new first step)

`/start` entry:
- If `update.effective_user.username` (lower-cased) ∈ `EXPENSE_USERNAMES` → go straight to
  the expense flow.
- Else show two buttons: **➕ حجز** (booking) / **💸 مصروف** (expense).
  - حجز → existing booking flow (unchanged), starts at the booking-ID step.
  - مصروف → expense flow.

Routing is by **username**, not numeric id (the user provided `@Seiiffseiif`; Telegram bots
can't resolve a username→id without prior interaction, and username matching needs no
capture step). `EXPENSE_USERNAMES` is a comma-separated env list, default `seiiffseiif`.

## Expense flow

Questions asked, in order:

| # | Field (sheet col) | Input | Notes |
|---|---|---|---|
| 1 | البند (B) | text | item / description |
| 2 | المبلغ (C) | number | numeric validation |
| 3 | الشقة (D) | 6 apartment buttons + **بدون/عام** | بدون writes blank |
| 4 | طريقة الدفع (F) | buttons **كاش** / **انستا باي** | required, no skip |
| 5 | ملاحظات (E) | text + **تخطي** | optional |

Auto / not asked:
- تاريخ (A) = now, `YYYY-MM-DD HH:MM` (written `USER_ENTERED` → real datetime).
- اسم المسئول (G) = Telegram full name; fallback `@username`; fallback numeric id.
- الرقم (H) = blank.

→ confirm summary → on confirm: write row + post to expense group.

## Apartment list (shared with booking)

`ذاكر حسين، احمد فهيم، انبي 3، انبي 2، ابو حديد 11، عبدالله العربي` + **بدون/عام**.

## Sheet write

Target: same spreadsheet `BOOKINGS_SHEET_ID`, tab `مصروفات عامة` (`EXPENSE_TAB`).
The tab is a **plain log — no fill-down formulas** (verified). Append at the true last row:
`row = len(col_values(B/"البند")) + 1`, then write `A{row}:H{row}` in one `USER_ENTERED`
update:

```
A تاريخ        = now "YYYY-MM-DD HH:MM"
B البند        = item
C المبلغ        = amount (number)
D الشقة         = apartment or ""
E ملاحظات       = notes or ""
F طريقة الدفع    = payment
G اسم المسئول    = telegram full name / @username / id
H الرقم         = ""
```

New `sheets.append_expense_row(values_a_to_h)`.

## Group post

Confirmed expense → message to `EXPENSE_GROUP_CHAT_ID` (default `-5072732996`), separate from
the bookings group (`-5001910339` via `GROUP_CHAT_ID`). Best-effort: failure still reports the
expense saved.

## Config additions

```
EXPENSE_TAB            (default "مصروفات عامة")
EXPENSE_GROUP_CHAT_ID  (default "-5072732996")
EXPENSE_USERNAMES      (default "seiiffseiif", comma list, lower-cased)
```

## Conversation changes

Entry point becomes a new `start()` that branches. New states:
`CHOICE, EXP_ITEM, EXP_AMOUNT, EXP_APT, EXP_PAY, EXP_NOTES, EXP_CONFIRM`. Booking states and
handlers are untouched. `allow_reentry=True` retained; `/cancel` fallback shared.

## Out of scope

- Editing/looking up expenses.
- Numeric-id routing / contact-share.
- Per-apartment expense reports (the sheet/Dashboard handles aggregation).
