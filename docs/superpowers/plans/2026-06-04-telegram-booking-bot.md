# Telegram Booking Bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Python Telegram bot that guides guests through apartment room bookings via inline keyboards, stores reservations in Google Sheets, and notifies the host group on every confirmed booking.

**Architecture:** Three ConversationHandlers (new booking, check booking) plus admin commands, all registered on a single `Application`. Business logic lives in `validators.py`, `ref_generator.py`, and `sheets.py` so handlers stay thin. Google Sheets is the sole data store, accessed through a `sheets.py` façade.

**Tech Stack:** Python 3.11+, python-telegram-bot 20.x, gspread 6.x, google-auth 2.x, python-dotenv 1.x, pytest 8.x, pytest-asyncio 0.23.x

---

## File Map

```
d:\bookings\bot\
├── bot.py                      # Application setup + handler registration
├── config.py                   # Reads .env into typed constants
├── sheets.py                   # All Google Sheets I/O (gspread façade)
├── handlers/
│   ├── __init__.py
│   ├── booking.py              # ConversationHandler: new booking (12 states)
│   ├── check_booking.py        # ConversationHandler: look up by reference
│   └── admin.py                # Admin commands (protected by ADMIN_IDS)
├── utils/
│   ├── __init__.py
│   ├── validators.py           # Pure validation functions
│   └── ref_generator.py        # BK-XXXXXX formatting
├── tests/
│   ├── __init__.py
│   ├── test_validators.py
│   ├── test_ref_generator.py
│   └── test_sheets.py
├── .env                        # Not committed
├── .env.example
├── requirements.txt
└── .gitignore
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `requirements.txt`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `config.py`
- Create: `utils/__init__.py`
- Create: `handlers/__init__.py`
- Create: `tests/__init__.py`

- [ ] **Step 1: Create `requirements.txt`**

```
python-telegram-bot==20.7
gspread==6.1.2
google-auth==2.29.0
python-dotenv==1.0.1
pytest==8.2.2
pytest-asyncio==0.23.7
```

- [ ] **Step 2: Create `.env.example`**

```
BOT_TOKEN=your_telegram_bot_token_from_botfather
SHEET_ID=your_google_sheet_document_id
GOOGLE_CREDENTIALS_JSON=path/to/service_account.json
ADMIN_IDS=123456789,987654321
```

- [ ] **Step 3: Create `.gitignore`**

```
.env
*.json
__pycache__/
.pytest_cache/
*.pyc
.superpowers/
```

- [ ] **Step 4: Create `config.py`**

```python
import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN: str = os.environ["BOT_TOKEN"]
SHEET_ID: str = os.environ["SHEET_ID"]
GOOGLE_CREDENTIALS_JSON: str = os.environ["GOOGLE_CREDENTIALS_JSON"]
ADMIN_IDS: set[int] = {
    int(uid.strip())
    for uid in os.environ.get("ADMIN_IDS", "").split(",")
    if uid.strip()
}
```

- [ ] **Step 5: Create empty package init files**

Create `utils/__init__.py`, `handlers/__init__.py`, and `tests/__init__.py` — all empty files.

- [ ] **Step 6: Install dependencies**

```
pip install -r requirements.txt
```

Expected: All packages install without errors.

- [ ] **Step 7: Commit**

```bash
git init
git add requirements.txt .env.example .gitignore config.py utils/__init__.py handlers/__init__.py tests/__init__.py
git commit -m "feat: project scaffold"
```

---

## Task 2: Input Validators (TDD)

**Files:**
- Create: `tests/test_validators.py`
- Create: `utils/validators.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_validators.py`:

```python
from datetime import date, timedelta
import pytest
from utils.validators import (
    validate_date,
    validate_checkout_date,
    validate_name,
    validate_phone,
    validate_time,
    validate_booking_ref,
)

today = date.today()
tomorrow = today + timedelta(days=1)
yesterday = today - timedelta(days=1)

# validate_date
def test_validate_date_valid():
    result = validate_date(tomorrow.strftime("%d/%m/%Y"))
    assert result == tomorrow

def test_validate_date_today_valid():
    result = validate_date(today.strftime("%d/%m/%Y"))
    assert result == today

def test_validate_date_past_invalid():
    assert validate_date(yesterday.strftime("%d/%m/%Y")) is None

def test_validate_date_wrong_format():
    assert validate_date("2024-07-01") is None

def test_validate_date_nonsense():
    assert validate_date("hello") is None

# validate_checkout_date
def test_validate_checkout_after_checkin():
    d = tomorrow + timedelta(days=2)
    assert validate_checkout_date(d.strftime("%d/%m/%Y"), tomorrow) == d

def test_validate_checkout_same_day_invalid():
    assert validate_checkout_date(tomorrow.strftime("%d/%m/%Y"), tomorrow) is None

def test_validate_checkout_before_checkin_invalid():
    assert validate_checkout_date(today.strftime("%d/%m/%Y"), tomorrow) is None

# validate_name
def test_validate_name_valid():
    assert validate_name("Ahmed Hassan") == "Ahmed Hassan"

def test_validate_name_arabic():
    assert validate_name("أحمد حسن") == "أحمد حسن"

def test_validate_name_too_short():
    assert validate_name("AB") is None

def test_validate_name_numbers():
    assert validate_name("Ahmed123") is None

def test_validate_name_strips_whitespace():
    assert validate_name("  Ahmed  ") == "Ahmed"

# validate_phone
def test_validate_phone_with_plus():
    assert validate_phone("+201234567890") == "+201234567890"

def test_validate_phone_digits_only():
    assert validate_phone("01234567890") == "01234567890"

def test_validate_phone_too_short():
    assert validate_phone("123") is None

def test_validate_phone_letters():
    assert validate_phone("abc1234567") is None

# validate_time
def test_validate_time_valid():
    assert validate_time("14:00") == "14:00"

def test_validate_time_midnight():
    assert validate_time("00:00") == "00:00"

def test_validate_time_invalid_hour():
    assert validate_time("25:00") is None

def test_validate_time_wrong_format():
    assert validate_time("2pm") is None

# validate_booking_ref
def test_validate_booking_ref_valid():
    assert validate_booking_ref("BK-000042") == "BK-000042"

def test_validate_booking_ref_lowercase_normalised():
    assert validate_booking_ref("bk-000042") == "BK-000042"

def test_validate_booking_ref_too_few_digits():
    assert validate_booking_ref("BK-042") is None

def test_validate_booking_ref_missing_prefix():
    assert validate_booking_ref("000042") is None
```

- [ ] **Step 2: Run to verify tests fail**

```
pytest tests/test_validators.py -v
```

Expected: `ImportError` or `ModuleNotFoundError` — `validators.py` does not exist yet.

- [ ] **Step 3: Create `utils/validators.py`**

```python
import re
from datetime import datetime, date


def validate_date(text: str) -> date | None:
    try:
        d = datetime.strptime(text.strip(), "%d/%m/%Y").date()
        if d < date.today():
            return None
        return d
    except ValueError:
        return None


def validate_checkout_date(text: str, check_in: date) -> date | None:
    try:
        d = datetime.strptime(text.strip(), "%d/%m/%Y").date()
        if d <= check_in:
            return None
        return d
    except ValueError:
        return None


def validate_name(text: str) -> str | None:
    cleaned = text.strip()
    if len(cleaned) < 3:
        return None
    if not re.match(r'^[A-Za-z؀-ۿ\s]+$', cleaned):
        return None
    return cleaned


def validate_phone(text: str) -> str | None:
    cleaned = text.strip()
    digits = cleaned[1:] if cleaned.startswith('+') else cleaned
    if not digits.isdigit() or len(digits) < 7:
        return None
    return cleaned


def validate_time(text: str) -> str | None:
    try:
        datetime.strptime(text.strip(), "%H:%M")
        return text.strip()
    except ValueError:
        return None


def validate_booking_ref(text: str) -> str | None:
    cleaned = text.strip().upper()
    if re.match(r'^BK-\d{6}$', cleaned):
        return cleaned
    return None
```

- [ ] **Step 4: Run tests to verify they pass**

```
pytest tests/test_validators.py -v
```

Expected: All tests PASSED.

- [ ] **Step 5: Commit**

```bash
git add utils/validators.py tests/test_validators.py
git commit -m "feat: input validators with tests"
```

---

## Task 3: Booking Reference Generator (TDD)

**Files:**
- Create: `tests/test_ref_generator.py`
- Create: `utils/ref_generator.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_ref_generator.py`:

```python
from utils.ref_generator import format_ref

def test_format_ref_pads_to_six_digits():
    assert format_ref(1) == "BK-000001"

def test_format_ref_preserves_large_number():
    assert format_ref(42) == "BK-000042"

def test_format_ref_max():
    assert format_ref(999999) == "BK-999999"

def test_format_ref_counter_1000():
    assert format_ref(1000) == "BK-001000"
```

- [ ] **Step 2: Run to verify tests fail**

```
pytest tests/test_ref_generator.py -v
```

Expected: `ImportError` — `ref_generator.py` does not exist yet.

- [ ] **Step 3: Create `utils/ref_generator.py`**

```python
def format_ref(counter: int) -> str:
    return f"BK-{counter:06d}"
```

- [ ] **Step 4: Run tests to verify they pass**

```
pytest tests/test_ref_generator.py -v
```

Expected: All 4 tests PASSED.

- [ ] **Step 5: Commit**

```bash
git add utils/ref_generator.py tests/test_ref_generator.py
git commit -m "feat: booking reference generator with tests"
```

---

## Task 4: Google Sheets Client (TDD with Mocks)

**Files:**
- Create: `sheets.py`
- Create: `tests/test_sheets.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_sheets.py`:

```python
from unittest.mock import MagicMock, patch, call
import sheets


def _make_ws(records=None, row_values_1=None):
    ws = MagicMock()
    if records is not None:
        ws.get_all_records.return_value = records
    if row_values_1 is not None:
        ws.row_values.return_value = row_values_1
    return ws


@patch("sheets._worksheet")
def test_get_config_returns_key_value_dict(mock_ws):
    mock_ws.return_value = _make_ws(records=[
        {"key": "host_phone", "value": "+20100"},
        {"key": "booking_counter", "value": "5"},
    ])
    result = sheets.get_config()
    assert result["host_phone"] == "+20100"
    assert result["booking_counter"] == "5"
    mock_ws.assert_called_once_with("Config")


@patch("sheets._worksheet")
def test_get_locations_returns_list(mock_ws):
    mock_ws.return_value = _make_ws(records=[
        {"location_id": "LOC001", "name": "City Centre", "address": "123 St"},
    ])
    result = sheets.get_locations()
    assert len(result) == 1
    assert result[0]["location_id"] == "LOC001"


@patch("sheets._worksheet")
def test_get_available_rooms_filters_correctly(mock_ws):
    mock_ws.return_value = _make_ws(records=[
        {"room_id": "RM001", "location_id": "LOC001", "room_number": "101", "is_available": "TRUE", "photo_file_ids": ""},
        {"room_id": "RM002", "location_id": "LOC001", "room_number": "202", "is_available": "FALSE", "photo_file_ids": ""},
        {"room_id": "RM003", "location_id": "LOC002", "room_number": "101", "is_available": "TRUE", "photo_file_ids": ""},
    ])
    result = sheets.get_available_rooms("LOC001")
    assert len(result) == 1
    assert result[0]["room_id"] == "RM001"


@patch("sheets._worksheet")
def test_get_room_returns_matching_room(mock_ws):
    mock_ws.return_value = _make_ws(records=[
        {"room_id": "RM001", "location_id": "LOC001", "room_number": "101", "is_available": "TRUE", "photo_file_ids": "a,b"},
        {"room_id": "RM002", "location_id": "LOC001", "room_number": "202", "is_available": "FALSE", "photo_file_ids": ""},
    ])
    result = sheets.get_room("RM001")
    assert result["room_number"] == "101"


@patch("sheets._worksheet")
def test_get_room_returns_none_if_not_found(mock_ws):
    mock_ws.return_value = _make_ws(records=[])
    assert sheets.get_room("RM999") is None


@patch("sheets._worksheet")
def test_set_room_availability_true(mock_ws):
    ws = MagicMock()
    ws.find.return_value = MagicMock(row=3)
    ws.row_values.return_value = ["room_id", "location_id", "room_number", "is_available", "photo_file_ids"]
    mock_ws.return_value = ws
    sheets.set_room_availability("RM001", True)
    ws.update_cell.assert_called_once_with(3, 4, "TRUE")


@patch("sheets._worksheet")
def test_set_room_availability_raises_if_not_found(mock_ws):
    ws = MagicMock()
    ws.find.return_value = None
    mock_ws.return_value = ws
    import pytest
    with pytest.raises(ValueError, match="RM999"):
        sheets.set_room_availability("RM999", True)


@patch("sheets._worksheet")
def test_increment_booking_counter(mock_ws):
    ws = MagicMock()
    ws.find.return_value = MagicMock(row=4)
    ws.row_values.return_value = ["key", "value"]
    ws.cell.return_value = MagicMock(value="5")
    mock_ws.return_value = ws
    result = sheets.increment_booking_counter()
    assert result == 6
    ws.update_cell.assert_called_once_with(4, 2, 6)


@patch("sheets._worksheet")
def test_append_booking_uses_header_order(mock_ws):
    ws = MagicMock()
    ws.row_values.return_value = ["booking_ref", "room_id", "guest_name"]
    mock_ws.return_value = ws
    sheets.append_booking({"booking_ref": "BK-000001", "room_id": "RM001", "guest_name": "Ahmed"})
    ws.append_row.assert_called_once_with(["BK-000001", "RM001", "Ahmed"])


@patch("sheets._worksheet")
def test_get_booking_by_ref_found(mock_ws):
    mock_ws.return_value = _make_ws(records=[
        {"booking_ref": "BK-000001", "guest_name": "Ahmed"},
        {"booking_ref": "BK-000002", "guest_name": "Sara"},
    ])
    result = sheets.get_booking_by_ref("BK-000001")
    assert result["guest_name"] == "Ahmed"


@patch("sheets._worksheet")
def test_get_booking_by_ref_not_found(mock_ws):
    mock_ws.return_value = _make_ws(records=[])
    assert sheets.get_booking_by_ref("BK-000099") is None
```

- [ ] **Step 2: Run to verify tests fail**

```
pytest tests/test_sheets.py -v
```

Expected: `ImportError` — `sheets.py` does not exist yet.

- [ ] **Step 3: Create `sheets.py`**

```python
import gspread
from google.oauth2.service_account import Credentials
import config

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


def _worksheet(name: str) -> gspread.Worksheet:
    creds = Credentials.from_service_account_file(config.GOOGLE_CREDENTIALS_JSON, scopes=SCOPES)
    gc = gspread.authorize(creds)
    return gc.open_by_key(config.SHEET_ID).worksheet(name)


def get_config() -> dict:
    ws = _worksheet("Config")
    return {row["key"]: row["value"] for row in ws.get_all_records()}


def get_locations() -> list[dict]:
    return _worksheet("Locations").get_all_records()


def get_available_rooms(location_id: str) -> list[dict]:
    rows = _worksheet("Rooms").get_all_records()
    return [
        r for r in rows
        if r["location_id"] == location_id and str(r["is_available"]).upper() == "TRUE"
    ]


def get_room(room_id: str) -> dict | None:
    rows = _worksheet("Rooms").get_all_records()
    return next((r for r in rows if r["room_id"] == room_id), None)


def set_room_availability(room_id: str, is_available: bool) -> None:
    ws = _worksheet("Rooms")
    cell = ws.find(room_id, in_column=1)
    if cell is None:
        raise ValueError(f"Room {room_id} not found")
    header = ws.row_values(1)
    col = header.index("is_available") + 1
    ws.update_cell(cell.row, col, "TRUE" if is_available else "FALSE")


def increment_booking_counter() -> int:
    ws = _worksheet("Config")
    cell = ws.find("booking_counter", in_column=1)
    header = ws.row_values(1)
    val_col = header.index("value") + 1
    current = int(ws.cell(cell.row, val_col).value or 0)
    new_val = current + 1
    ws.update_cell(cell.row, val_col, new_val)
    return new_val


def append_booking(data: dict) -> None:
    ws = _worksheet("Bookings")
    header = ws.row_values(1)
    ws.append_row([data.get(col, "") for col in header])


def get_booking_by_ref(ref: str) -> dict | None:
    rows = _worksheet("Bookings").get_all_records()
    return next((r for r in rows if r["booking_ref"] == ref), None)


def add_room(location_id: str, room_number: str) -> str:
    ws = _worksheet("Rooms")
    rooms = ws.get_all_records()
    nums = [int(r["room_id"][2:]) for r in rooms if r["room_id"][2:].isdigit()]
    next_num = max(nums) + 1 if nums else 1
    room_id = f"RM{next_num:03d}"
    ws.append_row([room_id, location_id, room_number, "TRUE", ""])
    return room_id


def remove_room(room_id: str) -> None:
    ws = _worksheet("Rooms")
    cell = ws.find(room_id, in_column=1)
    if cell is None:
        raise ValueError(f"Room {room_id} not found")
    ws.delete_rows(cell.row)


def get_rooms_by_location(location_id: str) -> list[dict]:
    rows = _worksheet("Rooms").get_all_records()
    return [r for r in rows if r["location_id"] == location_id]
```

- [ ] **Step 4: Run tests to verify they pass**

```
pytest tests/test_sheets.py -v
```

Expected: All 11 tests PASSED.

- [ ] **Step 5: Commit**

```bash
git add sheets.py tests/test_sheets.py
git commit -m "feat: Google Sheets client with mocked tests"
```

---

## Task 5: New Booking ConversationHandler

**Files:**
- Create: `handlers/booking.py`

No automated tests for the handler functions themselves (they require a running Telegram Application). Manual testing is covered in Task 8.

- [ ] **Step 1: Create `handlers/booking.py`**

```python
from datetime import date as dt_date
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, InputMediaPhoto
from telegram.ext import (
    ContextTypes,
    ConversationHandler,
    CallbackQueryHandler,
    MessageHandler,
    CommandHandler,
    filters,
)
import sheets
from utils.validators import (
    validate_date,
    validate_checkout_date,
    validate_name,
    validate_phone,
    validate_time,
)
from utils.ref_generator import format_ref

(
    RULES, LOCATION, ROOM, PHOTOS,
    CHECK_IN, CHECK_OUT, NAME, PHONE, ARRIVAL,
    CONFIRM, EDIT_MENU, EDIT_FIELD,
) = range(12)


async def show_rules(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    config = sheets.get_config()
    rules_text = config.get("rules", "Please respect the property and other guests.")
    keyboard = [
        [InlineKeyboardButton("✅ I Agree — Continue", callback_data="rules_agree")],
        [InlineKeyboardButton("❌ I Disagree — Exit", callback_data="rules_disagree")],
    ]
    await query.edit_message_text(
        f"📋 *Booking Rules*\n\n{rules_text}\n\nPlease read before proceeding.",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return RULES


async def handle_rules(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    if query.data == "rules_disagree":
        await query.edit_message_text("No problem! Send /start to begin again.")
        return ConversationHandler.END
    return await _show_locations(update, context)


async def _show_locations(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    locations = sheets.get_locations()
    keyboard = [
        [InlineKeyboardButton(f"📍 {loc['name']}", callback_data=f"loc_{loc['location_id']}")]
        for loc in locations
    ]
    text = "🏙️ Choose a location:"
    if update.callback_query:
        await update.callback_query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard))
    else:
        await update.effective_message.reply_text(text, reply_markup=InlineKeyboardMarkup(keyboard))
    return LOCATION


async def handle_location(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    location_id = query.data[4:]
    locations = sheets.get_locations()
    location = next(loc for loc in locations if loc["location_id"] == location_id)
    context.user_data.update({
        "location_id": location_id,
        "location_name": location["name"],
    })
    context.user_data.pop("room_id", None)
    context.user_data.pop("room_number", None)
    context.user_data.pop("photo_file_ids", None)
    return await _show_rooms(update, context)


async def _show_rooms(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    location_id = context.user_data["location_id"]
    rooms = sheets.get_available_rooms(location_id)
    if not rooms:
        keyboard = [[InlineKeyboardButton("⬅️ Back to locations", callback_data="rooms_back")]]
        await update.callback_query.edit_message_text(
            "😔 No rooms available at this location right now.",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
        return ROOM
    keyboard = [
        [InlineKeyboardButton(f"🚪 Room {r['room_number']}", callback_data=f"room_{r['room_id']}")]
        for r in rooms
    ]
    keyboard.append([InlineKeyboardButton("⬅️ Back to locations", callback_data="rooms_back")])
    await update.callback_query.edit_message_text(
        f"🚪 Available rooms at *{context.user_data['location_name']}*:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return ROOM


async def handle_room(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    if query.data == "rooms_back":
        return await _show_locations(update, context)
    room_id = query.data[5:]
    room = sheets.get_room(room_id)
    context.user_data["room_id"] = room_id
    context.user_data["room_number"] = room["room_number"]
    photo_ids = [p.strip() for p in room["photo_file_ids"].split(",") if p.strip()]
    context.user_data["photo_file_ids"] = photo_ids
    return await _show_photos(update, context)


async def _show_photos(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    photo_ids = context.user_data["photo_file_ids"]
    keyboard = [
        [InlineKeyboardButton("✅ Yes, continue", callback_data="photos_yes")],
        [InlineKeyboardButton("⬅️ Back to rooms", callback_data="photos_back")],
    ]
    if photo_ids:
        media = [InputMediaPhoto(pid) for pid in photo_ids[:10]]
        await update.callback_query.message.reply_media_group(media)
        await update.callback_query.message.reply_text(
            "Does this room work for you?",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
    else:
        await update.callback_query.edit_message_text(
            "📷 No photos available for this room.\n\nDoes this room work for you?",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
    return PHOTOS


async def handle_photos(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    if query.data == "photos_back":
        return await _show_rooms(update, context)
    if context.user_data.pop("editing", False):
        return await _show_confirm(update, context)
    await query.message.reply_text("📅 Enter check-in date:\nFormat: DD/MM/YYYY")
    return CHECK_IN


async def handle_check_in(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    result = validate_date(update.message.text)
    if result is None:
        await update.message.reply_text(
            "❌ Invalid date. Must be today or later, format DD/MM/YYYY.\nTry again:"
        )
        return CHECK_IN
    context.user_data["check_in"] = update.message.text.strip()
    context.user_data["check_in_date"] = result
    await update.message.reply_text(
        "📅 Enter check-out date:\nFormat: DD/MM/YYYY (must be after check-in)"
    )
    return CHECK_OUT


async def handle_check_out(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    result = validate_checkout_date(update.message.text, context.user_data["check_in_date"])
    if result is None:
        await update.message.reply_text(
            f"❌ Date must be strictly after check-in ({context.user_data['check_in']}).\nTry again:"
        )
        return CHECK_OUT
    context.user_data["check_out"] = update.message.text.strip()
    await update.message.reply_text("👤 Enter your full name:")
    return NAME


async def handle_name(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    result = validate_name(update.message.text)
    if result is None:
        await update.message.reply_text(
            "❌ Letters and spaces only, minimum 3 characters.\nTry again:"
        )
        return NAME
    context.user_data["guest_name"] = result
    await update.message.reply_text("📞 Enter your phone number:")
    return PHONE


async def handle_phone(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    result = validate_phone(update.message.text)
    if result is None:
        await update.message.reply_text(
            "❌ Digits only (optional leading +), minimum 7 digits.\nTry again:"
        )
        return PHONE
    context.user_data["phone"] = result
    await update.message.reply_text("🕐 What time will you arrive? (HH:MM, e.g. 14:00)")
    return ARRIVAL


async def handle_arrival(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    result = validate_time(update.message.text)
    if result is None:
        await update.message.reply_text(
            "❌ Invalid time. Use HH:MM format (e.g. 14:00).\nTry again:"
        )
        return ARRIVAL
    context.user_data["arrival_time"] = result
    return await _show_confirm(update, context)


async def _show_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    d = context.user_data
    summary = (
        f"📋 *Please review your booking:*\n\n"
        f"📍 {d['location_name']}\n"
        f"🚪 Room {d['room_number']}\n"
        f"📅 {d['check_in']} → {d['check_out']}\n"
        f"🕐 Arrival: {d['arrival_time']}\n"
        f"👤 {d['guest_name']}\n"
        f"📞 {d['phone']}"
    )
    keyboard = [
        [InlineKeyboardButton("✅ Agree", callback_data="confirm_agree")],
        [InlineKeyboardButton("✏️ Change something", callback_data="confirm_change")],
        [InlineKeyboardButton("❌ Cancel", callback_data="confirm_cancel")],
    ]
    await update.effective_message.reply_text(
        summary, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(keyboard)
    )
    return CONFIRM


async def handle_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    if query.data == "confirm_cancel":
        await query.edit_message_text("Booking cancelled. Send /start to begin again.")
        return ConversationHandler.END
    if query.data == "confirm_change":
        return await _show_edit_menu(update, context)

    # confirm_agree — save booking
    counter = sheets.increment_booking_counter()
    ref = format_ref(counter)
    config = sheets.get_config()
    d = context.user_data

    booking_data = {
        "booking_ref": ref,
        "room_id": d["room_id"],
        "room_number": d["room_number"],
        "location_id": d["location_id"],
        "location_name": d["location_name"],
        "check_in": d["check_in"],
        "check_out": d["check_out"],
        "arrival_time": d["arrival_time"],
        "guest_name": d["guest_name"],
        "phone": d["phone"],
        "telegram_id": update.effective_user.id,
        "created_at": str(dt_date.today()),
    }
    sheets.append_booking(booking_data)
    sheets.set_room_availability(d["room_id"], False)

    host_chat_id = config.get("host_chat_id", "")
    if host_chat_id:
        host_msg = (
            f"🔔 *New Booking Confirmed*\n\n"
            f"🔖 Ref: {ref}\n"
            f"📍 Location: {d['location_name']}\n"
            f"🚪 Room: {d['room_number']}\n"
            f"📅 Check-in: {d['check_in']}\n"
            f"📅 Check-out: {d['check_out']}\n"
            f"🕐 Arrival: {d['arrival_time']}\n"
            f"👤 Guest: {d['guest_name']}\n"
            f"📞 Phone: {d['phone']}\n"
            f"🤖 Telegram ID: {update.effective_user.id}"
        )
        await context.bot.send_message(
            chat_id=int(host_chat_id), text=host_msg, parse_mode="Markdown"
        )

    host_phone = config.get("host_phone", "")
    await query.edit_message_text(
        f"🎉 *Your booking is confirmed!*\n"
        f"🔖 Reference: *{ref}*\n"
        f"📞 Host: {host_phone}\n\n"
        f"📞 Please call the host 1 hour before your arrival time.",
        parse_mode="Markdown",
    )
    return ConversationHandler.END


async def _show_edit_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    keyboard = [
        [InlineKeyboardButton("📅 Check-in date",  callback_data="edit_check_in")],
        [InlineKeyboardButton("📅 Check-out date", callback_data="edit_check_out")],
        [InlineKeyboardButton("🕐 Arrival time",   callback_data="edit_arrival")],
        [InlineKeyboardButton("👤 Name",            callback_data="edit_name")],
        [InlineKeyboardButton("📞 Phone",           callback_data="edit_phone")],
        [InlineKeyboardButton("🚪 Room",            callback_data="edit_room")],
        [InlineKeyboardButton("📍 Location",        callback_data="edit_location")],
    ]
    await update.callback_query.edit_message_text(
        "✏️ What would you like to change?",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return EDIT_MENU


async def handle_edit_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    target = query.data[5:]  # strip "edit_"

    if target == "location":
        for key in ("location_id", "location_name", "room_id", "room_number", "photo_file_ids"):
            context.user_data.pop(key, None)
        context.user_data["editing"] = True
        return await _show_locations(update, context)

    if target == "room":
        for key in ("room_id", "room_number", "photo_file_ids"):
            context.user_data.pop(key, None)
        context.user_data["editing"] = True
        return await _show_rooms(update, context)

    prompts = {
        "check_in":  "📅 Enter new check-in date (DD/MM/YYYY):",
        "check_out": f"📅 Enter new check-out date (DD/MM/YYYY, after {context.user_data.get('check_in', 'check-in')}):",
        "name":      "👤 Enter your new full name:",
        "phone":     "📞 Enter your new phone number:",
        "arrival":   "🕐 Enter new arrival time (HH:MM, e.g. 14:00):",
    }
    context.user_data["edit_target"] = target
    await query.message.reply_text(prompts[target])
    return EDIT_FIELD


async def handle_edit_field(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    target = context.user_data["edit_target"]
    text = update.message.text

    validator_map = {
        "check_in":  lambda t: validate_date(t),
        "check_out": lambda t: validate_checkout_date(t, context.user_data.get("check_in_date")),
        "name":      validate_name,
        "phone":     validate_phone,
        "arrival":   validate_time,
    }
    error_map = {
        "check_in":  "❌ Invalid date. Use DD/MM/YYYY and not in the past.",
        "check_out": f"❌ Must be strictly after check-in ({context.user_data.get('check_in', '')}).",
        "name":      "❌ Letters and spaces only, min 3 characters.",
        "phone":     "❌ Digits only (optional leading +), min 7 digits.",
        "arrival":   "❌ Use HH:MM format (e.g. 14:00).",
    }
    field_key_map = {
        "check_in":  "check_in",
        "check_out": "check_out",
        "name":      "guest_name",
        "phone":     "phone",
        "arrival":   "arrival_time",
    }

    result = validator_map[target](text)
    if result is None:
        await update.message.reply_text(f"{error_map[target]}\nTry again:")
        return EDIT_FIELD

    context.user_data[field_key_map[target]] = text.strip()
    if target == "check_in":
        context.user_data["check_in_date"] = result

    context.user_data.pop("edit_target", None)
    return await _show_confirm(update, context)


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await update.effective_message.reply_text("Cancelled. Send /start to begin again.")
    return ConversationHandler.END


def build_booking_handler() -> ConversationHandler:
    return ConversationHandler(
        entry_points=[CallbackQueryHandler(show_rules, pattern="^new_booking$")],
        states={
            RULES:      [CallbackQueryHandler(handle_rules,     pattern="^rules_(agree|disagree)$")],
            LOCATION:   [CallbackQueryHandler(handle_location,  pattern="^loc_")],
            ROOM:       [CallbackQueryHandler(handle_room,      pattern="^room_|^rooms_back$")],
            PHOTOS:     [CallbackQueryHandler(handle_photos,    pattern="^photos_(yes|back)$")],
            CHECK_IN:   [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_check_in)],
            CHECK_OUT:  [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_check_out)],
            NAME:       [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_name)],
            PHONE:      [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_phone)],
            ARRIVAL:    [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_arrival)],
            CONFIRM:    [CallbackQueryHandler(handle_confirm,   pattern="^confirm_(agree|change|cancel)$")],
            EDIT_MENU:  [CallbackQueryHandler(handle_edit_menu, pattern="^edit_")],
            EDIT_FIELD: [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_edit_field)],
        },
        fallbacks=[
            CommandHandler("cancel", cancel),
            CommandHandler("start",  cancel),
        ],
        allow_reentry=True,
    )
```

- [ ] **Step 2: Verify no syntax errors**

```
python -c "from handlers.booking import build_booking_handler; print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add handlers/booking.py
git commit -m "feat: new booking ConversationHandler"
```

---

## Task 6: Check Booking ConversationHandler

**Files:**
- Create: `handlers/check_booking.py`

- [ ] **Step 1: Create `handlers/check_booking.py`**

```python
from telegram import Update
from telegram.ext import (
    ContextTypes,
    ConversationHandler,
    CallbackQueryHandler,
    MessageHandler,
    CommandHandler,
    filters,
)
import sheets
from utils.validators import validate_booking_ref

CHECK_REF = 0


async def start_check(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    await query.message.reply_text(
        "🔍 Please enter your booking reference:\n(e.g. BK-000042)\n\nType /cancel to exit."
    )
    return CHECK_REF


async def handle_ref(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    ref = validate_booking_ref(update.message.text)
    if ref is None:
        await update.message.reply_text(
            "❌ Invalid format. Expected: BK-XXXXXX\nTry again or /cancel:"
        )
        return CHECK_REF

    booking = sheets.get_booking_by_ref(ref)
    if booking is None:
        await update.message.reply_text(
            f"❌ Booking reference {ref} not found.\nTry again or /cancel:"
        )
        return CHECK_REF

    config = sheets.get_config()
    host_phone = config.get("host_phone", "")
    location_display = booking.get("location_name") or booking.get("location_id", "")
    room_display = booking.get("room_number") or booking.get("room_id", "")

    details = (
        f"📋 *Your Booking*\n\n"
        f"📍 {location_display}\n"
        f"🚪 Room {room_display}\n"
        f"📅 {booking['check_in']} → {booking['check_out']}\n"
        f"🕐 Arrival: {booking['arrival_time']}\n"
        f"👤 {booking['guest_name']}\n"
        f"📞 {booking['phone']}\n"
        f"🔖 Ref: {booking['booking_ref']}\n"
        f"📞 Host: {host_phone}\n\n"
        f"📞 Please call the host 1 hour before your arrival time."
    )
    await update.message.reply_text(details, parse_mode="Markdown")
    return ConversationHandler.END


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await update.effective_message.reply_text("Cancelled. Send /start to begin again.")
    return ConversationHandler.END


def build_check_handler() -> ConversationHandler:
    return ConversationHandler(
        entry_points=[CallbackQueryHandler(start_check, pattern="^check_booking$")],
        states={
            CHECK_REF: [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_ref)],
        },
        fallbacks=[
            CommandHandler("cancel", cancel),
            CommandHandler("start",  cancel),
        ],
        allow_reentry=True,
    )
```

- [ ] **Step 2: Verify no syntax errors**

```
python -c "from handlers.check_booking import build_check_handler; print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add handlers/check_booking.py
git commit -m "feat: check booking ConversationHandler"
```

---

## Task 7: Admin Commands Handler

**Files:**
- Create: `handlers/admin.py`

- [ ] **Step 1: Create `handlers/admin.py`**

```python
from functools import wraps
from telegram import Update
from telegram.ext import ContextTypes
import config
import sheets


def admin_only(func):
    @wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        if update.effective_user.id not in config.ADMIN_IDS:
            return
        return await func(update, context)
    return wrapper


@admin_only
async def set_available(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args:
        await update.message.reply_text("Usage: /set_available <room_id>")
        return
    room_id = context.args[0].upper()
    try:
        sheets.set_room_availability(room_id, True)
        await update.message.reply_text(f"✅ {room_id} is now available.")
    except ValueError as e:
        await update.message.reply_text(f"❌ {e}")


@admin_only
async def set_unavailable(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args:
        await update.message.reply_text("Usage: /set_unavailable <room_id>")
        return
    room_id = context.args[0].upper()
    try:
        sheets.set_room_availability(room_id, False)
        await update.message.reply_text(f"✅ {room_id} is now unavailable.")
    except ValueError as e:
        await update.message.reply_text(f"❌ {e}")


@admin_only
async def add_room(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if len(context.args) < 2:
        await update.message.reply_text("Usage: /add_room <location_id> <room_number>")
        return
    location_id, room_number = context.args[0].upper(), context.args[1]
    room_id = sheets.add_room(location_id, room_number)
    await update.message.reply_text(
        f"✅ Room {room_number} added as `{room_id}` at {location_id}.",
        parse_mode="Markdown",
    )


@admin_only
async def remove_room(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args:
        await update.message.reply_text("Usage: /remove_room <room_id>")
        return
    room_id = context.args[0].upper()
    try:
        sheets.remove_room(room_id)
        await update.message.reply_text(f"✅ Room {room_id} removed.")
    except ValueError as e:
        await update.message.reply_text(f"❌ {e}")


@admin_only
async def list_rooms(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args:
        await update.message.reply_text("Usage: /list_rooms <location_id>")
        return
    location_id = context.args[0].upper()
    rooms = sheets.get_rooms_by_location(location_id)
    if not rooms:
        await update.message.reply_text(f"No rooms found for {location_id}.")
        return
    lines = [
        f"🚪 Room {r['room_number']} (`{r['room_id']}`) — "
        f"{'✅ Available' if str(r['is_available']).upper() == 'TRUE' else '❌ Unavailable'}"
        for r in rooms
    ]
    await update.message.reply_text(
        f"Rooms at {location_id}:\n" + "\n".join(lines), parse_mode="Markdown"
    )


@admin_only
async def upload_photo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    replied = update.message.reply_to_message
    if not replied or not replied.photo:
        await update.message.reply_text(
            "Reply to a photo message with /upload_photo to get its file ID."
        )
        return
    file_id = replied.photo[-1].file_id
    await update.message.reply_text(
        f"📋 File ID (paste into the Rooms sheet):\n`{file_id}`",
        parse_mode="Markdown",
    )
```

- [ ] **Step 2: Verify no syntax errors**

```
python -c "from handlers.admin import upload_photo; print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add handlers/admin.py
git commit -m "feat: admin commands handler"
```

---

## Task 8: Main Bot Entry Point and End-to-End Test

**Files:**
- Create: `bot.py`

- [ ] **Step 1: Create `bot.py`**

```python
import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler
import config
from handlers.booking import build_booking_handler
from handlers.check_booking import build_check_handler
from handlers import admin

logging.basicConfig(
    format="%(asctime)s — %(name)s — %(levelname)s — %(message)s",
    level=logging.INFO,
)


async def start(update: Update, context) -> None:
    keyboard = [
        [InlineKeyboardButton("📅 New Booking",      callback_data="new_booking")],
        [InlineKeyboardButton("🔍 Check My Booking", callback_data="check_booking")],
    ]
    await update.effective_message.reply_text(
        "👋 Welcome! What would you like to do?",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )


def main() -> None:
    app = Application.builder().token(config.BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(build_booking_handler())
    app.add_handler(build_check_handler())
    app.add_handler(CommandHandler("set_available",   admin.set_available))
    app.add_handler(CommandHandler("set_unavailable", admin.set_unavailable))
    app.add_handler(CommandHandler("add_room",        admin.add_room))
    app.add_handler(CommandHandler("remove_room",     admin.remove_room))
    app.add_handler(CommandHandler("list_rooms",      admin.list_rooms))
    app.add_handler(CommandHandler("upload_photo",    admin.upload_photo))

    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify import chain has no errors**

```
python -c "import bot; print('OK')"
```

Expected: `OK` (may warn about missing .env — that's fine at import time).

- [ ] **Step 3: Set up Google Sheets**

In your Google Sheet, create 4 tabs with these exact names and headers (Row 1):

**Locations:** `location_id | name | address`

**Rooms:** `room_id | location_id | room_number | is_available | photo_file_ids`

**Bookings:** `booking_ref | room_id | room_number | location_id | location_name | check_in | check_out | arrival_time | guest_name | phone | telegram_id | created_at`

**Config:**
```
key             | value
host_phone      | +XX XXX XXXX
host_chat_id    | -100XXXXXXXXX   (your Telegram group ID)
booking_counter | 0
rules           | No smoking. Check-in after 14:00. Check-out by 11:00. Any damage will be charged.
```

Add at least one row to Locations and at least one row to Rooms (with `is_available = TRUE`).

- [ ] **Step 4: Copy and fill `.env`**

```
cp .env.example .env
```

Edit `.env` with your real values:
```
BOT_TOKEN=...
SHEET_ID=...
GOOGLE_CREDENTIALS_JSON=./service_account.json
ADMIN_IDS=your_telegram_user_id
```

- [ ] **Step 5: Run the bot and verify full booking flow manually**

```
python bot.py
```

Manual test checklist:
1. Send `/start` → see two buttons.
2. Tap "New Booking" → see rules + Agree/Disagree.
3. Tap "I Agree" → see location keyboard.
4. Pick location → see room keyboard.
5. Pick room → see photos (or "no photos") + Yes/Back.
6. Tap "Yes, continue" → enter check-in date (try a bad format first, verify error).
7. Enter check-out date (try a date before check-in, verify error).
8. Enter name, phone, arrival time (test each invalid input).
9. See summary → tap "Change something" → change one field → confirm summary updated.
10. Tap "Agree" → see booking confirmed with reference and host number.
11. Verify row appended in Bookings sheet. Verify `is_available` set to FALSE in Rooms sheet.
12. Send `/start` → tap "Check My Booking" → enter reference → see booking details with host note.
13. Send `/start` → tap "Check My Booking" → enter wrong ref → see error.
14. As admin, run `/list_rooms LOC001` → see room list.
15. As admin, run `/set_available RM001` → verify sheet updated.

- [ ] **Step 6: Run full test suite**

```
pytest tests/ -v
```

Expected: All tests PASSED.

- [ ] **Step 7: Final commit**

```bash
git add bot.py
git commit -m "feat: main entry point — booking bot complete"
```

---

## Google Service Account Setup (one-time)

1. Go to [Google Cloud Console](https://console.cloud.google.com) → Create project.
2. Enable **Google Sheets API**.
3. Create a **Service Account** → download JSON key → save as `service_account.json` in project root.
4. Open your Google Sheet → Share → paste the service account email → give **Editor** access.
