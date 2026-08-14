# Importing the bot into a fresh n8n, by hand

Written 2026-08-14, for the rebuild after the old instance was destroyed. Use
this when the MCP endpoint cannot be reached — as it cannot today, because
`superfoxxy.dpdns.org` serves a certificate issued by a FortiGate appliance
(`O=Fortinet, CN=F2K61FTK22900232`) that no store on this machine trusts, so
every script call dies at TLS before authenticating.

**Import this file:** [`booking_bot/bookings-bot.full.workflow.json`](../booking_bot/bookings-bot.full.workflow.json)
— 50 nodes, the whole bot. Not `bookings-bot.workflow.json`, which is 33 nodes
and has no Postgres write, no reports and no scheduled mirror. Regenerate the
full one after any change with:

```
python booking_bot/build_workflow.py            # the 33-node base
python booking_bot/deploy_graph.py --offline    # merges the other 17 in
python booking_bot/validate_workflow.py booking_bot/bookings-bot.full.workflow.json
```

## 0. Before anything

The n8n instance must answer on **public HTTPS with a certificate Telegram
accepts**. The Telegram Trigger registers a webhook, and Telegram refuses a
self-signed or middlebox-issued chain — the same problem that blocks the scripts
here would block the webhook.

## 1. Create the three credentials

n8n → **Credentials → New**. Names do not have to match the ones below; the
import carries `REPLACE_ME` ids, so every node asks you to pick one anyway.

| Credential | Used by | What it needs |
|---|---|---|
| Telegram API | 8 nodes | the bot token from BotFather |
| Google Sheets OAuth2 | 10 nodes | the account that owns spreadsheet `1CiHciOeeyRMx9vz5cP0Xlid-jqM_gVjW3sUfore84S8` |
| Postgres | 8 nodes | Supabase, **pooler** connection |

Postgres, from `.env` → `SUPABASE_TRANSACTION_URL`:

```
host      aws-1-eu-west-1.pooler.supabase.com
port      6543
database  postgres
user      postgres.bghkjpqhmnfdylvhkdhz
password  (the one in SUPABASE_TRANSACTION_URL)
SSL       enabled
```

Use the pooler, never the direct host: `SUPABASE_DB_URL` resolves to an
AAAA-only record and is unreachable from an IPv4 network.

## 2. Create the session data table

n8n → **Data Tables → New**, named exactly **`bookings_bot_sessions`**. The
three session nodes address it by that name, so a different one silently breaks
every conversation.

| Column | Type |
|---|---|
| `chat_id` | string |
| `state` | string |
| `data` | string |
| `updated_at` | number |

`data` holds JSON as text, and `updated_at` is `Date.now()` — a number, not a
date.

## 3. Import

**Workflows → Import from File** → `booking_bot/bookings-bot.full.workflow.json`.
It arrives as a draft called *Bookings Bot (Telegram - Google Sheets)* with two
triggers: the Telegram Trigger and *Report Schedule* (08:00 daily).

## 4. Bind the credentials

26 nodes, grouped by what they need. Open each, pick the credential, save.

- **Telegram (8):** Telegram Trigger, Answer Callback, Post Receipt To Group,
  Post To Group, Send Saved, Send Saved No Group, Send Save Error, Send Report
- **Postgres (8):** Read Bookings For Edit, Read Locations, Shadow Write,
  Read Booking Id, Write Snapshot, Read Discrepancies, Read Unmirrored Bookings,
  Mark Mirrored
- **Google Sheets (9):** Read Booking Key, Write Booking Row, Read Expense Key,
  Write Expense Row, Write Edit Row, Read Report Formulas, Read Report Values,
  Write Booking Id, Append Mirror Row
- **Google Sheets on an HTTP Request node (1):** Format Cancelled Row. Set it to
  *Predefined Credential Type* → Google Sheets. This one **must** be done in the
  UI: the API refuses `googleSheetsOAuth2Api` on an `httpRequest` node, which is
  why it was never scripted.

## 5. Fill the two empty Config values

Open **Config**. Every other value is already correct; two are blank because the
repository is committed.

| Key | Value |
|---|---|
| `BOT_TOKEN` | the bot token — the same one the Telegram credential holds |
| `BOOKINGS_SHEET_GID` | `2123885264` |

The gid is the numeric id of the إدخال الحجوزات tab, verified against the live
spreadsheet on 2026-08-14. It is only used to fill a cancelled row black; the
bot works without it.

## 6. Check the workflow timezone

**Workflow → Settings → Timezone → Africa/Cairo.** The file already carries
`settings.timezone`, so this should be right on import — but the schedule fires
in the instance timezone, and a wrong one sends the daily report at the wrong
hour. Worth the ten seconds.

## 7. Activate

Save, then toggle **Active**. The Telegram Trigger registers its webhook on
activation.

If Telegram reports a webhook already in place, clear the old one first:

```
curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

`getWebhookInfo` after activation should show the new n8n URL and
`pending_update_count: 0`.

## 8. Record the id for the scripts

Copy the workflow id out of the browser URL
(`/workflow/<id>`) into a file the scripts read:

```
echo <new-id> > booking_bot/.workflow_id
```

Git-ignored, per-instance. Both `deploy_graph.py` and `push_brain.py` refuse to
run without it, so there is no hard-coded id pointing at the destroyed workflow
any more. Once the network path is fixed, those two scripts take over again and
`--offline` is no longer needed.

## 9. Walk one message through

1. `/start` from an admin (`7941350507`, `1226903540`, `5793725130`,
   `@AbdulrahmanMohamed5`) → the حجز / مصروف / تعديل حجز menu.
2. One booking end to end → a row in إدخال الحجوزات, a copy in Postgres
   `bookings`, and the summary posted to group `-4809181011`.
3. One expense → a row in مصروفات عامة.
4. Next morning at 08:00 → the digest in group `-5057362381`.

## What to expect to go wrong

**The node parameters were written from documentation, not read off a live
instance.** The topology, the node names and every JS body are pinned by
`brain.js` and the test suites, but these four were not verifiable offline and
should be checked first if something misbehaves:

- the three Data Table nodes (Load / Save / Clear Session),
- the *Route Save* Switch,
- the Telegram `sendPhoto` and callback-answer nodes,
- *Format Cancelled Row*, the Sheets-credentialed HTTP node.

`validate_workflow.py` checks structure and the Brain's contract. It cannot
check n8n's field names.
