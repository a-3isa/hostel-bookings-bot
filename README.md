# hostel-bookings-bot

A Telegram bot that runs bookings and expenses for the hostel. Staff use it in
Arabic. It writes to a Google Sheet, which is the source of truth, and copies
the data into a Supabase Postgres database that a small web dashboard reads.

```
Telegram ──► n8n workflow (brain.js) ──► Google Sheet   (authoritative)
                     │                         ▲
                     └──► Supabase Postgres ◄──┘ daily reconcile / mirror
                                  ▲
                                  └── webui (Next.js dashboard)
```

## What's in the repo

| Folder | What it is | Status |
|---|---|---|
| [`booking_bot/`](booking_bot/) | The n8n workflow: `brain.js` is the conversation state machine, `nodes/` holds the other Code and Postgres nodes, and `build_workflow.py` generates the importable graph. | **Live** |
| [`supabase/`](supabase/) | Postgres schema, migrations, the sheet backfill, and the mirror and reconcile scripts. | Mirror of the sheet |
| [`webui/`](webui/) | A Next.js 15 dashboard for bookings, expenses, deposits, reports and reconcile. It connects to Postgres directly. | Deployed on Vercel |
| [`python_version/`](python_version/) | The original python-telegram-bot implementation. | **Retired.** Kept for reference only |
| [`docs/`](docs/) | Plans and the running handoff log (`HANDOFF.md`). | — |

Each folder has its own README with the details.

## What the bot does

- **Admins** get the full menu: new booking (حجز), expense (مصروف), and edit
  booking (تعديل حجز).
- **Cashiers** get expense (مصروف) and add a payment (إضافة مبلغ مدفوع). Adding a
  payment shows what the booking has paid against its price, asks for a receipt
  for انستاباي and فودافون كاش, and saves nothing until the review card is
  confirmed.
- **Admins** also get 🤖 تعديل بالذكاء الاصطناعي: type a change to a booking in
  plain words, see exactly what would change, and confirm. The model only reads
  the text; the same code path as the edit menu writes it.
- Every booking is posted to the group chat. The bot suggests the next booking
  ID, and the numbering restarts each Cairo calendar month.
- In column P (المتبقي) the bot writes the sheet's own formula, not a number,
  so the remaining balance keeps tracking price minus paid.
- Morning reports cover occupancy, free rooms and debt grouped by apartment.

Access is controlled by `ADMIN_USERS` and `CASHIER_USERS` on the workflow's
Config node. `brain.js` carries the same lists as defaults.

## Working on the bot

Edit the source in `booking_bot/`. Never edit the graph in the n8n editor: the
graph is generated from this repo, and changes made in the editor are lost on
the next build.

```bash
node booking_bot/test_brain.mjs          # state machine, offline
node booking_bot/test_reports.mjs        # report builders, offline
python booking_bot/build_workflow.py     # regenerate the workflow JSON
python booking_bot/validate_workflow.py  # check connections in the JSON

python booking_bot/push_brain.py --check    # can we reach the live n8n?
python booking_bot/push_brain.py --publish  # deploy brain.js + access lists
python booking_bot/deploy_graph.py --publish
```

[`booking_bot/README.md`](booking_bot/README.md) covers deployment, rebuilding
into a fresh n8n instance, and the manual import path.

## Web dashboard

```bash
cd webui
npm install
npm run dev
```

It needs the Supabase pooler connection string. See
[`webui/README.md`](webui/README.md) for the environment variables. **Edits made
in the dashboard go to Postgres only.** They show up as differences in the
daily reconcile until the same change is made in the sheet.

## Secrets

These files are gitignored and must never be committed: `.env`,
`service_account.json`, and `backups/`. Backups contain the bot token and guest
names and phone numbers. `.env.example` lists the variables the retired Python
bot used. The n8n workflow keeps its own settings on its Config node.
