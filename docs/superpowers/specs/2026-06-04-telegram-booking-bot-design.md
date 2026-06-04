# Telegram Booking Bot — Design Spec

**Date:** 2026-06-04
**Stack:** Python · python-telegram-bot v20 · gspread · Google Sheets

---

## 1. Overview

A Telegram bot that lets guests browse available apartment rooms across multiple locations, view room photos, enter booking details, and confirm a reservation. All booking data is stored in Google Sheets. The host is notified in a Telegram group on every new confirmed booking. Host admins manage room inventory and availability via bot commands.

---

## 2. User-Facing Conversation Flow

### 2.1 Main Menu

Triggered by `/start` or any message when no conversation is active.

Bot sends: "Welcome! What would you like to do?"
Inline keyboard:
- 📅 New Booking
- 🔍 Check My Booking

`/cancel` is a global fallback command registered on all ConversationHandlers. At any point in any flow, typing `/cancel` ends the conversation and returns the user to the main menu with the message: "Cancelled. Send /start to begin again."

### 2.2 New Booking Path

**Rules Screen**
Bot displays booking rules (fetched from Config sheet, `rules` key).
Inline keyboard: ✅ I Agree — Continue | ❌ I Disagree — Exit
If disagree: conversation ends, bot returns to main menu.

**Step 1 — Pick Location**
Bot reads the Locations sheet and builds an inline keyboard with all location names.
User taps a location.

**Step 2 — Pick Room**
Bot reads the Rooms sheet, filters by `location_id` and `is_available = TRUE`.
Displays available rooms as inline keyboard buttons (room numbers).
If no rooms are available: "Sorry, no rooms available at this location right now."

**Step 3 — View Photos**
Bot sends the room's photos as a media group (up to 10 photos from `photo_file_ids`).
If `photo_file_ids` is empty, bot sends: "No photos available for this room." and proceeds directly to the confirmation buttons.
Inline keyboard: ✅ Yes, continue | ⬅️ Back to rooms
If back: return to Step 2.

**Step 4 — Check-in Date** (text input)
Bot asks: "Enter check-in date (DD/MM/YYYY)"
Validation: must be a valid date, not in the past.
On invalid input: re-ask with error message. Loop until valid.

**Step 5 — Check-out Date** (text input)
Bot asks: "Enter check-out date (DD/MM/YYYY)"
Validation: must be a valid date, strictly after check-in date.
On invalid input: re-ask with error message. Loop until valid.

**Step 6 — Full Name** (text input)
Bot asks: "Enter your full name"
Validation: letters and spaces only, minimum 3 characters.
On invalid input: re-ask with error message. Loop until valid.

**Step 7 — Phone Number** (text input)
Bot asks: "Enter your phone number"
Validation: digits only (optional leading +), minimum 7 digits.
On invalid input: re-ask with error message. Loop until valid.

**Step 8 — Arrival Time** (text input)
Bot asks: "What time will you arrive? (HH:MM, e.g. 14:00)"
Validation: valid 24-hour time format.
On invalid input: re-ask with error message. Loop until valid.

**Step 9 — Confirmation Summary**
Bot displays a summary of all collected data:
- Location name, room number
- Check-in date, check-out date
- Arrival time
- Guest name, phone number

Inline keyboard: ✅ Agree | ✏️ Change something | ❌ Cancel

- **Agree:** proceed to save and confirm.
- **Cancel:** end conversation, return to main menu.
- **Change something:** show Edit Menu.

**Edit Menu**
Inline keyboard listing every editable field:
- 📅 Check-in date
- 📅 Check-out date
- 🕐 Arrival time
- 👤 Name
- 📞 Phone
- 🚪 Room (returns to Step 2)
- 📍 Location (returns to Step 1)

User picks one field → bot re-asks only that field with its validation loop → returns to Step 9 summary.
If the user picks 📍 Location: previously selected location and room are both cleared; flow restarts from Step 1.
If the user picks 🚪 Room: previously selected room is cleared; flow restarts from Step 2 (within the already-selected location).

**Booking Confirmed**
Bot:
1. Increments `booking_counter` in Config sheet.
2. Generates reference: `BK-` + 6-digit zero-padded counter (e.g. `BK-000042`). Supports up to 999,999 bookings.
3. Appends a row to the Bookings sheet.
4. Sets `is_available = FALSE` on the booked room in the Rooms sheet.
5. Sends notification message to the host Telegram group.
6. Replies to user:

```
🎉 Your booking is confirmed!
🔖 Reference: BK-000042
📞 Host: +XX XXX XXXX

📞 Please call the host 1 hour before your arrival time.
```

### 2.3 Check My Booking Path

Bot asks: "Enter your booking reference (e.g. BK-000042)"
Validation: must match format and exist in the Bookings sheet.
On not found: re-ask with error. User can type /cancel to exit.

On found, bot displays:
```
📋 Your Booking
📍 [Location] · 🚪 Room [Number]
📅 [Check-in] → [Check-out]
🕐 Arrival: [time]
👤 [Name] · 📞 [Phone]
🔖 Ref: BK-XXXXXX
📞 Host: +XX XXX XXXX

📞 Please call the host 1 hour before your arrival time.
```

---

## 3. Host Notification Message

Sent to `host_chat_id` (Telegram group) on every confirmed booking:

```
🔔 New Booking Confirmed

🔖 Ref: BK-000042
📍 Location: [Name]
🚪 Room: [Number]
📅 Check-in: DD/MM/YYYY
📅 Check-out: DD/MM/YYYY
🕐 Arrival: HH:MM
👤 Guest: [Full Name]
📞 Phone: [Number]
🤖 Telegram ID: [user_id]
```

---

## 4. Google Sheets Structure

### Sheet 1 — Locations

| Column | Type | Notes |
|---|---|---|
| location_id | string | e.g. LOC001. Primary key. |
| name | string | Shown in inline keyboard. |
| address | string | Informational only. |

### Sheet 2 — Rooms

| Column | Type | Notes |
|---|---|---|
| room_id | string | e.g. RM001. Primary key. |
| location_id | string | Foreign key → Locations. |
| room_number | string | Shown in inline keyboard. |
| is_available | boolean | TRUE/FALSE. Bot sets FALSE on booking. |
| photo_file_ids | string | Comma-separated Telegram file IDs. |

### Sheet 3 — Bookings

| Column | Type | Notes |
|---|---|---|
| booking_ref | string | BK-XXXXXX. Primary key. |
| room_id | string | FK → Rooms. |
| location_id | string | Denormalised for easy reading. |
| check_in | string | DD/MM/YYYY |
| check_out | string | DD/MM/YYYY |
| arrival_time | string | HH:MM |
| guest_name | string | |
| phone | string | |
| telegram_id | integer | Telegram user ID of guest. |
| created_at | string | ISO date when booking was made. |

Append-only — rows are never deleted.

### Sheet 4 — Config

| Key | Default | Notes |
|---|---|---|
| host_phone | | Shown in confirmation and booking detail messages. |
| host_chat_id | | Telegram group/channel ID for host notifications. |
| booking_counter | 0 | Incremented by bot on each confirmed booking. |
| rules | | Full rules text shown in the Rules screen. |

---

## 5. Host Admin Commands

Protected by `ADMIN_IDS` list in `.env`. Silently ignored for non-admins.

| Command | Effect |
|---|---|
| `/set_available <room_id>` | Sets `is_available = TRUE` for that room. |
| `/set_unavailable <room_id>` | Sets `is_available = FALSE` for that room. |
| `/add_room <location_id> <room_number>` | Appends a new row to Rooms sheet (available, no photos). |
| `/remove_room <room_id>` | Removes room row from Rooms sheet. |
| `/list_rooms <location_id>` | Replies with a list of all rooms and their availability status. |
| `/upload_photo` | Reply to a photo message with this command → bot replies with the Telegram `file_id`. |

---

## 6. Photo Management

To add photos for a room:
1. Send any photo to the bot in private chat.
2. Reply to that photo with `/upload_photo`.
3. Bot replies with the `file_id` string.
4. Paste the `file_id` into the `photo_file_ids` column of the Rooms sheet (comma-separate multiple IDs for a gallery).

Telegram `file_id` values are permanent and served from Telegram's CDN — no external hosting needed.

---

## 7. Project File Structure

```
d:\bookings\bot\
├── bot.py                      # Entry point: Application setup, handler registration
├── config.py                   # Loads .env: BOT_TOKEN, SHEET_ID, ADMIN_IDS
├── sheets.py                   # All Google Sheets read/write operations (gspread)
├── handlers/
│   ├── booking.py              # ConversationHandler: new booking flow (Steps 1–9)
│   ├── check_booking.py        # ConversationHandler: check booking by reference
│   └── admin.py                # Admin command handlers (protected by ADMIN_IDS)
├── utils/
│   ├── validators.py           # Date, phone, name, time validation functions
│   └── ref_generator.py        # BK-XXXXXX reference generation
├── .env                        # BOT_TOKEN, SHEET_ID, ADMIN_IDS (not committed)
├── .env.example                # Template with all required keys documented
├── requirements.txt
└── .gitignore
```

---

## 8. Environment Variables (.env)

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `SHEET_ID` | Google Sheets document ID |
| `GOOGLE_CREDENTIALS_JSON` | Path to Google service account JSON file |
| `ADMIN_IDS` | Comma-separated Telegram user IDs with admin access |

---

## 9. Dependencies

```
python-telegram-bot==20.x
gspread==6.x
google-auth==2.x
python-dotenv==1.x
```

---

## 10. Key Design Decisions

- **Availability is a simple boolean:** Rooms are either available or not. The bot sets `is_available = FALSE` on confirmation. The host flips it back via bot command or directly in the sheet after checkout. This avoids date-range overlap complexity while keeping the system predictable.
- **Rules stored in Config sheet:** The host can update booking rules without any code changes.
- **Booking reference counter in Config sheet:** Centralised, human-readable, easily reset or inspected.
- **Bookings sheet is append-only:** Provides a full audit trail of all bookings. Availability state is tracked in the Rooms sheet separately.
- **Telegram file IDs for photos:** No external hosting. Permanent CDN URLs via Telegram. One-time setup via `/upload_photo` admin command.
- **ConversationHandler per flow:** Each distinct user journey (new booking, check booking) is its own ConversationHandler with isolated state. No shared state between flows.
