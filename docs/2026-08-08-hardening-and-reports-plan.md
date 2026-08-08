# Hardening + reports — implementation plan (2026-08-08)

Scope agreed with the user: risks #2, #3, #4 from the review; Tier 1 features 1–3
(availability, daily digest, debt report) but not search; Tier 2 features 1–2
(dynamic apartments/rooms, undo).

## Facts established before designing

Read live from the spreadsheet, not assumed:

- **`الإتاحة` is already an apartment/room registry.** `A5:B` holds one row per
  (apartment, room): 6 apartments with **5, 5, 4, 4, 4, 4** rooms. No new tab is
  needed and nothing has to be written to the sheet.
- **`brain.js` hardcodes `ROOMS_PER_APARTMENT = 5` for all six**, so the bot
  currently offers a room 5 that does not exist in انبي 3, انبي 2, ابو حديد 11 and
  عبدالله العربي. Tier 2 #1 is a bug fix, not just flexibility.
- `ابو حديد 7` has its own tab but does **not** appear in `الإتاحة`, so it is
  treated as inactive and is not offered. If that is wrong, adding a row to
  `الإتاحة` is now all it takes.
- `جرد الشقق` is a linens/supplies inventory, not a room registry. Not used here.
- Writes are `update` matched on a client-computed `row_number` — the concurrency
  race (#1) is real but is **out of scope for this change**.

## 1. Risk #4 — stable callback data

`callback_data` currently carries positions into module-level arrays (`pay_0`,
`ar_2_3`). Reordering a list silently changes what an in-flight tap means.

Two different problems, two different fixes:

- **Fixed lists** (payments, expense payments, booking type) get **literal stable
  keys**: `pay_cash`, `pay_instapay`, `epay_vcash`, `bt_external`. A key is bound
  to a value forever; reordering the display list cannot change a meaning.
- **The apartment/room grid is dynamic**, so no global key exists. It uses a
  **session-scoped index**: the exact list offered is stored in the session when
  the keyboard is built, and the callback indexes into *that*. A sheet edit
  mid-conversation cannot shift it.

Legacy `pay_<n>` / `ar_<i>_<n>` forms are still accepted on input so that any
conversation in flight at deploy time survives.

## 2. Tier 2 #1 — apartments and rooms from the sheet

New Sheets node **Read Locations** (`الإتاحة!A5:B200`), gated by the existing
`Needs Bookings?` pattern so it costs an API call only on the turns that build an
apartment keyboard. `brain.js` reduces the pairs to an ordered
`[{ apartment, rooms: [...] }]` registry.

If the read fails or returns nothing, the previous hardcoded list is used as a
fallback — a Sheets hiccup must not make the bot unable to take a booking.

## 3. Risk #2 — double-tap save

The session is deliberately kept until the write succeeds, so a failed write
leaves the save button usable. That is also what makes a double tap write twice.

Fix: record `savingAt` on the session when a save is emitted, and ignore a second
save tap within **60 s**. After that the user is assumed to be retrying a genuine
failure and it is allowed through. Keeps both properties.

## 4. Risk #3 / Tier 1 #1 — availability conflict

On the turn that builds the booking confirmation, read the bookings tab and look
for a stay in the **same apartment and room** whose date range intersects the one
being entered. Rows whose ملاحظات contains `ملغي` are ignored. An open-ended stay
(nights held as a live formula) counts as running to infinity.

**Warning, not a block.** The conflict is shown in the summary with the
conflicting guest and dates, and the save button changes to an explicit
"احفظ رغم التعارض". A receptionist standing in front of a guest knows things the
sheet does not; refusing the booking outright would be worse than flagging it.

## 5. Tier 2 #2 — undo

`/undo` reverts the **last edit or payment** within **10 minutes**, restoring the
pre-image column by column.

Deliberately **not** offered for new bookings or expenses: those are appends, and
blanking an appended row leaves a gap that would corrupt the `filled + 2` row
calculation for the next write. For a booking entered by mistake the correct tool
is إلغاء الحجز, which marks and colours the row.

The pre-image rides on `save.undo` and is persisted by the *Clear Session* node,
which already runs after a successful write.

## 6. Tier 1 #2/#3 — scheduled reports

One **Schedule Trigger** at **08:00 Africa/Cairo daily** → read the bookings tab →
one code node → send to group **-5057362381** (new Config key
`REPORT_GROUP_CHAT_ID`).

- **Daily digest** (every day): arrivals today, departures today, and open-ended
  stays running longer than 30 days.
- **Debt report** (**Saturdays only**, emitted as a second message from the same
  branch): every booking with المتبقي > 0, guest, room, and the amount, with a
  total.

One trigger and one read serve both, so the graph grows by four nodes rather than
eight.

## Assumptions the user should correct if wrong

1. Availability conflicts warn rather than block.
2. Digest daily at 08:00; debt report Saturdays.
3. Undo covers edits/payments only, 10-minute window.
4. `ابو حديد 7` is inactive because it is absent from `الإتاحة`.

## Outcome

All of the above shipped on 2026-08-08 (`activeVersionId`
`b885f316-92c6-4eaa-a8f8-6e2a53650360`, 40 nodes, 2 triggers). Suites: 305
assertions in `test_brain.mjs`, 20 in `test_reports.mjs`.

Two things did not go to plan and are worth recording:

- **The report branch needs two reads, not one.** The first draft used a single
  evaluated read. That reports an open-ended stay as departing *today*, every
  day, because عدد الليالي is a live `=TODAY()-J` and the sheet derives
  تاريخ المغادرة from it — the same guest would have been announced as leaving
  for months. Switching wholesale to FORMULA does not work either: المتبقي is a
  formula, and so is اجمالي سعر الحجز on nightly-rate rows (`=500*I{row}`). So
  the branch reads the range twice and joins on `row_number`.
- **The schedule fires at 08:00 in the n8n instance's timezone**, not Cairo. The
  workflow has no `settings.timezone` and the MCP surface has no operation to set
  one, so this needs a one-click change in the n8n UI (Workflow settings →
  Timezone → Africa/Cairo). The *content* is unaffected: the node computes "today"
  with an explicit `Africa/Cairo` formatter, so only the delivery hour drifts.
