# python_version — retired

The original python-telegram-bot implementation. **It is not what runs.** The bot
was migrated to an n8n workflow; see [`../booking_bot/`](../booking_bot/) for the
live system and how to deploy it.

Kept for reference only: the n8n `Brain` code node is a direct port of
`handlers/booking.py` + `strings.py`, so this is often the clearest explanation of
why the state machine is shaped the way it is.

Do not trust it as documentation of current behaviour:

- `config.py` still carries the **old** access lists (`BOOKING_USER_IDS`,
  `EXPENSE_USERNAMES`). The live lists are `ADMIN_USERS` / `CASHIER_USERS` on the
  workflow's Config node, and they differ.
- None of the features added after the cutover exist here — access control, the
  cashier's add-a-payment flow, edit/cancel, receipt photos, or the checkout
  question.
- `bookings-bot.service` on the server is stopped and disabled. Starting it while
  the n8n workflow is active would double-answer every message.
