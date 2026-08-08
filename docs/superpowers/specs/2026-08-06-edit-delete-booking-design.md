# Editing and cancelling a saved booking

Design agreed with the user on 2026-08-06. Not yet implemented.

## Entry

`/start` currently routes straight into the booking flow for `BOOKING_USER_IDS`.
It must instead offer a choice for those users:

- `➕ حجز` → existing booking flow
- `✏️ تعديل حجز` → this flow

(The expense-only users and the unknown-user chooser are unchanged.)

## 1. Find the booking — by typed ID

The user types an ID. Match it against **column A (بوكنج ID)** *or* **column B (ID)**.

Column B is safe to key on: `ask_private_id` is a required step with no skip button,
so every saved booking has one. Column A is optional and often blank — it is
accepted as a convenience for Booking.com reservations, not relied upon.

- No match → tell the user and re-ask.
- More than one match → list the matches as buttons (name + apartment + arrival)
  and let the user pick. IDs are not enforced unique anywhere, so this case is real.

The lookup needs the row number, so the read must return enough to identify it —
read `A:J` rather than a single key column, and track the matched row index.

## 2. Choose what to change

Editable set: **money + stay details only.** Identity fields (اسم المقيم, ID,
بوكنج ID, رقم الهاتف, نوع الحجز) are deliberately not editable — they are rarely
wrong and changing them after the fact breaks the link to anything already filed
against that booking.

| Button | Column | Reuses |
|---|---|---|
| اجمالي سعر الحجز | L | `ask_total` text step |
| اجمالي ما تم دفعه | M | `ask_paid` text step **→ then forces طريقة الدفع** |
| طريقة الدفع | O | `PAYMENTS` grid |
| عدد الليالي | I | nights pad + `∞ مفتوح` |
| تاريخ البداية | J | calendar keyboard |
| الشقة / الغرفة | G, H | apartment/room grid |
| ملاحظات | Q | text + skip |

After each edit, return to the field picker so several fields can be changed in one
session, plus a `✅ تم` button to finish and a `❌ إلغاء` to abandon.

### Paid amount is ADDITIVE

Editing **اجمالي ما تم دفعه** adds the entered figure to what is already paid; it
does not replace it. The common case is a guest settling the rest later, so the
receptionist types the new payment, not a recalculated total. The prompt shows the
current amount so this is unambiguous.

Adding twice within one edit session accumulates correctly — the second addition
builds on the first, not on the sheet's original value. The group diff still shows
the **original** sheet figure as the "before", so one line reflects the whole
session (`1200 ← 2000`) rather than each keystroke.

### Paid amount forces a payment method

Per the user: changing **اجمالي ما تم دفعه** must be followed by choosing
**طريقة الدفع**. And since the receipt step already keys off `RECEIPT_PAYMENTS`,
picking انستاباي or فودافون كاش there should offer the receipt upload too — the
whole point is that the new payment has proof.

Column **P (المتبقي) is calculated by the sheet** and must never be written, here
or anywhere else.

## 3. Cancel a booking

`🗑️ إلغاء الحجز` — **keeps the row.** It does *not* delete it.

1. Write `ملغي` into **ملاحظات (Q)** (append to any existing note rather than
   clobbering it).
2. Format the whole row: **black background, white text.**

Deleting the row was explicitly rejected — data stays, row numbers stay stable, and
the booking remains in revenue history.

> ### This needs an HTTP Request node
> The Google Sheets node cannot format cells — there is no operation for it. Cell
> formatting requires `POST /v4/spreadsheets/{id}:batchUpdate` with a `repeatCell`
> request setting `userEnteredFormat.backgroundColor` (black) and
> `textFormat.foregroundColor` (white), with
> `fields: "userEnteredFormat(backgroundColor,textFormat)"`.
>
> This is the **second** justified exception to the built-in-nodes-only rule, after
> *Send Reply* (dynamic keyboards). Both are cases where no built-in node can do the
> job at all.
>
> Note this endpoint is `spreadsheets:batchUpdate` (structural/formatting), **not**
> `values:batchUpdate` (cell values) which the old write path used. Different API.

Require a confirmation step before cancelling — it is destructive-looking to the
user even though it is reversible.

## 4. Group summary — changes only

On finish, post to `GROUP_CHAT_ID` a summary of **only what changed**, not the whole
booking. Shape:

```
✏️ *تعديل حجز*

👤 المقيم: {name}
🆔 ID: {private_id}

💵 المدفوع: 2000 ← 4500
💳 الدفع: كاش ← انستاباي
```

So the Brain must keep the **before** value of every field it edits. Nothing is
posted if the user finishes without changing anything.

For a cancellation the message is instead `🗑️ *إلغاء حجز*` with the guest's name,
ID, apartment and arrival date.

If a receipt was attached during the edit, send it as a photo with the summary as
caption — reuse the existing `Has Receipt?` → *Send Group Photo* branch.

## Implementation notes

- New Brain states, roughly: `EDIT_FIND`, `EDIT_PICK_MATCH`, `EDIT_MENU`,
  `EDIT_TOTAL`, `EDIT_PAID`, `EDIT_PAYMENT`, `EDIT_RECEIPT`, `EDIT_NIGHTS`,
  `EDIT_ARRIVAL`, `EDIT_APT_ROOM`, `EDIT_NOTES`, `EDIT_CANCEL_CONFIRM`.
- The edit write is the **same** Google Sheets `update` node pattern already in use
  (match on `row_number`, map only changed columns) — but the row number comes from
  the lookup, not from `items + 2`. Keep the two paths distinct so an edit can never
  be mistaken for an append.
- `save.flow` gains `'edit'` and `'cancel'` alongside `'booking'` and `'expense'`,
  and *Is Expense?* becomes a proper router rather than a two-way IF.
- Session data must hold `editRow`, `editBefore` and `editAfter`.
