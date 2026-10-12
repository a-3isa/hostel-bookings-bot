# AI booking edit — Design Spec

**Date:** 2026-10-12
**Status:** Draft for review
**Stack:** n8n workflow (`brain.js` + generated graph), Google Sheets, Supabase mirror, Anthropic API

---

## 1. Goal

An admin taps a new main-menu button and types a change to a saved booking in
free text, in Arabic or English:

> booking with ID 3 paid 400 egp in cash
> حجز 3 دفع 400 كاش
> booking 12 move to room 3, extend 2 nights
> booking 7 left today

The bot works out what is meant, shows the exact changes it would make to the
booking, and writes nothing until the admin taps **Confirm**.

Covered in v1: **payments, room change, extend the stay, leaving.**

Success means: the same change typed in free text and entered through the
existing edit menus produces an identical `out.save`, and a wrong reading by
the model can never reach the sheet without an admin confirming it.

## 2. Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Who uses it | Admins only | Cashiers keep their payment-only flow. |
| Provider | Anthropic, Claude Haiku 5.5 (model id verified when the credential exists; Sonnet is the fallback) | Cheap and fast; extraction is an easy task. |
| Role of the model | **Parses only.** It has no tools and never writes. | A wrong guess is stopped by validation and by the review card. |
| Writes | Existing `commitEdit` / `commitPaymentLine` path | Keeps the group post, the Supabase mirror, the double-tap lock and the row-shift safety. |
| How the booking is identified | By ID in the message | Staff always give the ID. Name/room lookup is a possible later addition. |
| Node | Information Extractor (v1.2) + Anthropic Chat Model sub-node, manual JSON Schema | Needs no tools. An Agent node can replace it later if tools are wanted. |

## 3. Out of scope for v1

Price changes, arrival-date changes, notes, cancelling a booking, cashier access,
finding a booking by guest name or room, voice messages. All stay in the normal
edit menu.

## 4. Graph changes

### 4.1 New nodes

```
… → Needs Expense Number? ─┬→ Read Expense Numbers ─┐
                           └────────────────────────┴→ Needs AI? ─┬→ AI Extract → Brain
                                                                  └────────────→ Brain
                                          Anthropic Chat Model ──ai_languageModel──▶ AI Extract
```

- **Needs AI?** — IF. True when `$('Load Session').first().json.state === 'AI_TEXT'`
  **and** the update carries `message.text`. Button taps never reach the model.
- **AI Extract** — Information Extractor v1.2.
  - `text`: `={{ $('Telegram Trigger').first().json.message.text }}`
  - `schemaType: manual`, `inputSchema` = the schema in §5.
  - `options.systemPromptTemplate`: the extraction rules (§5.2), with today's
    date in Cairo, the apartment names, and the payment-method keys interpolated.
  - Settings: `onError: continueRegularOutput`, `alwaysOutputData: true`,
    `retryOnFail: true`, `maxTries: 2`.
- **Anthropic Chat Model** — `lmChatAnthropic` v1.6, `maxTokensToSample` ≈ 300,
  credential `anthropicApi`.

### 4.2 Existing gates

`AI_TEXT` and `AI_PICK` are added to `BOOKING_STATES` (the turn needs
`Read Bookings For Edit`) and to `LOCATION_STATES` (the turn needs
`Read Locations` for room validation). The lists live in **both**
`build_workflow.py` and `deploy_graph.py`, and both change.

### 4.3 Generator

`Graph.connect()` only emits `main` connections. It gains a connection kind so
the model node can be wired with `ai_languageModel`. `validate_workflow.py` must
stop reporting sub-nodes (which have no inbound `main`) as orphans.

### 4.4 Untouched

`Route Save`, `Build Edit Row`, `Insert Payment Line`, `Build Line Rows`, the
Postgres mirror, the group post, the save lock.

## 5. The model's contract

### 5.1 Output schema

```json
{
  "booking_id": "3",
  "payment": { "amount": 400, "method": "cash" },
  "room":    { "apartment": "انبي 2", "room": "3" },
  "stay":    { "kind": "extend", "nights": 2 },
  "unclear": null
}
```

`payment`, `room` and `stay` are each nullable. `stay.kind` is `extend`
(`nights`), `until` (`date`) or `leave` (`date`, optional). `unclear` is a short
string when the model cannot tell what is being asked.

### 5.2 Prompt rules

- Input is the user's text only, plus: today's date in Cairo, the apartment names
  from the registry (best-effort — if unavailable the list is omitted and Brain's
  strict match plus the picker catches mismatches), and the method keys
  `cash, instapay, airbnb, vcash, eur, usd`.
- `unpaid` is not offered: it is the absence of a payment, and the manual flow
  already refuses it with an amount.
- The method is the **currency** for foreign money. "100 usd cash" is
  `method: "usd"`. "400 egp in cash" is `cash`. This matches how `PAYMENTS`
  treats `eur`/`usd` (amount is in that currency, kept on a line of its own).
- A refund is a negative amount.
- Relative dates ("tomorrow", "the 20th") are resolved to ISO dates using the
  supplied date.
- Never invent a booking ID. If none is stated, return `unclear`.

### 5.3 What the model never sees

Sheet rows, guest names, phone numbers, prices. If staff type a guest name in
their message, it goes with the message — nothing else does.

## 6. Brain changes (`brain.js`)

### 6.1 Entry

- New admin-menu button `choice_ai` (`🤖 تعديل بالذكاء الاصطناعي`), rendered for
  admins only, guarded by `isAdmin` in both dispatch places (the `CHOICE` case
  and the no-state `choice_*` shortcut), like `choice_edit`.
- `startAi()` replies with a prompt and sets state `AI_TEXT`.

### 6.2 `AI_TEXT`

1. Re-check `isAdmin`.
2. Read `$('AI Extract').first().json.output` inside a try/catch (the node is
   unexecuted on other turns). Missing output, an `error` field, or `unclear`
   gives a reply asking the admin to rephrase, or to use the normal edit menu if
   the AI is unavailable. The session stays in `AI_TEXT`; `/cancel` ends it.
3. Validate every field (§6.3).
4. Look the booking up exactly as `EDIT_FIND` does (ASCII-digit-normalised ID):
   no match → not found; several → the existing pick list, state `AI_PICK`, with
   the intent held in `d.aiIntent`.
5. Apply the intent (§6.4) and draw the card.

`AI_PICK` handles `epick_<row>` like `EDIT_PICK`, then runs steps 5 onwards from
the stored intent.

### 6.3 Validation

| Field | Rule |
|---|---|
| `booking_id` | Non-empty after ASCII-digit normalisation. |
| `payment.amount` | Finite, non-zero. Negative allowed (admin refund). |
| `payment.method` | A key in `PAY_METHODS` (never `unpaid`). |
| `room` | Apartment and room both exist in the registry; otherwise open the existing apartment/room picker. |
| `stay.nights` | Integer ≥ 1. |
| `stay.date` | Valid ISO date; `daysBetween(arrival, date)` must not be negative. `leave` without a date means today. |
| Combination | At most one payment, one room change, one stay change. |
| Open-ended stay | Extending a stay whose nights cell is a `=TODAY()-J…` formula is refused rather than overwriting the formula. |

### 6.4 Applying the intent

All through the existing setters, so the result is the same session shape the
manual flow builds (`editRow`, `editOrig`, `editNew`, `paidAdded`, `payMethod`,
`payTarget`, `lineTotal`):

- **Payment.** The money logic currently inline in `case 'EDIT_PAYMENT'`
  (target selection via `paymentTarget`, the below-zero checks for the booking
  row and for a line, the booking-row versus line branch) is extracted into one
  helper used by both `EDIT_PAYMENT` and the AI path. The relabel branch (no
  money) stays in `EDIT_PAYMENT` only. The existing `test_brain.mjs` suite
  (passing today) must stay green through the extraction.
- **Receipt.** `instapay` and `vcash` enter `EDIT_RECEIPT` (the admin may skip),
  then continue.
- **Room.** `editSet` on `اسم الشقة` and `رقم الغرفة`.
- **Stay.** `extend`: `nights = current + n`. `until` / `leave`:
  `daysBetween(arrival, date)`; `d.departure` is set so the card shows the date.
  `تاريخ المغادرة` is a sheet formula and is never written.

### 6.5 The card

The AI path sets `d.aiMode = true`. Two existing behaviours would otherwise send
it to the wrong place:

- `afterEditStep()` ends in `showEditMenu()` (and asks "has the guest left?" after
  a payment). With `aiMode` it goes straight to `showEditConfirm()` instead.
- `showEditConfirm()` prefixes a line echoing the original request and appends
  clash warnings.

Clash detection: after room, nights or arrival change, call
`findConflicts(apartment, room, arrival, nights, isOpen, d.editRow)` using the
effective values (`editOrig` overlaid with `editNew`). `findConflicts` reads
`bookingRows()`, which is only available on turns whose state is in
`BOOKING_STATES`, and the card may be drawn later (after the receipt turn). So the
clashes are computed on the `AI_TEXT` / `AI_PICK` turn and stored as text in
`d.aiClashes`. They are a warning, not a block, exactly as `showConfirm()` treats
them for a new booking: the same `conflict_warning` / `conflict_line` strings, and
the Confirm button is relabelled `btn_confirm_anyway` when there is a clash. The
manual edit flow does not check conflicts at all today, so the AI path is
deliberately stricter.

Confirm (`xedone`) and Cancel (`xecancel`) are the existing `EDIT_CONFIRM`
handlers. Cancel ends the session with `hasSave` unset.

## 7. Failure handling

| Failure | Behaviour |
|---|---|
| AI call fails (timeout, rate limit, no credit, bad key) | Node continues with no output; Brain replies that the AI is unavailable and points to تعديل حجز. Session kept. |
| Model returns invalid or unusable data | §6.3 re-asks. The booking always comes from a real row lookup. |
| Wrong but valid reading | The card shows before/after built by code; nothing is written until Confirm. |
| Double tap on Confirm | Existing `saveLocked` / `waitingForButton`. |
| Sheet row changed between card and Confirm | Same exposure as the manual flow; not changed here. |
| Non-admin reaches `AI_TEXT` | Refused by Brain's `isAdmin` check. |

## 8. Testing

### 8.1 Offline (`test_brain.mjs`)

Add an `AI Extract` double that throws when unexecuted, like the other gated
nodes, and add `AI_TEXT` / `AI_PICK` to the harness's `Read Bookings For Edit`
state list. Cases:

- Payment on the booking's own row; a second method (payment line); `instapay`
  (receipt step, then card); foreign currency (`usd` stays on its own line);
  refund below zero (refused).
- Extend by N; extend an open-ended stay (refused); `until` a date; `leave` with
  and without a date; `leave` before arrival (refused).
- Room change: valid, invalid (picker), and clash warning.
- Payment plus extension in one message.
- Duplicate ID → pick list → applied; unknown ID.
- AI failure → fallback message; cashier refused.
- Cancel writes nothing (`hasSave` unset).
- **Equivalence:** for each supported change, the `out.save` from the AI path
  equals the `out.save` from the manual flow for the same change.

### 8.2 Graph (`test_workflow.py`, `validate_workflow.py`)

The new nodes and gate; the `ai_languageModel` connection; the extended state
lists; sub-nodes not reported as orphans.

### 8.3 Model behaviour

Offline tests mock the model, so they say nothing about how well it reads real
phrasing. A separate eval script sends about 20 sample Arabic and English
messages to the live API and checks the returned JSON. It needs an API key and
real examples of what staff type, so the sample phrases come from the user.

## 9. Rollout

1. The user creates an Anthropic credential in the n8n UI (not possible over MCP).
2. `build_workflow.py` regenerates the JSON; `deploy_graph.py --publish` adds the
   nodes to the live workflow. Diff the live graph first — the README records it
   drifting before.
3. `push_brain.py --publish`.
4. First live pass: go as far as the card and tap Cancel, so nothing is written.

## 10. Risks and open items

- **`addConnection` with AI connection types** over the n8n MCP is unverified.
  If it is refused, fall back to importing the generated JSON.
- **Model id.** `claude-haiku-5-5` must appear in the node's model list once the
  credential exists; otherwise use Sonnet.
- **Apartment names in the prompt** come from `Read Locations`; the best-effort
  fallback in §5.2 covers it being absent.
- **Working tree.** `build_workflow.py`, `deploy_graph.py`, `test_workflow.py`
  and both workflow JSONs already have uncommitted edits that are not part of
  this work. The implementation builds on top of them; the plan must account for
  them before regenerating the JSON.
