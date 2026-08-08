import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN: str = os.environ["BOT_TOKEN"]
SHEET_ID: str = os.environ["SHEET_ID"]
GOOGLE_CREDENTIALS_JSON: str = os.environ["GOOGLE_CREDENTIALS_JSON"]

# Bookings are appended to this spreadsheet/tab (the sheet owns several formula columns).
BOOKINGS_SHEET_ID: str = os.environ.get(
    "BOOKINGS_SHEET_ID", "1CiHciOeeyRMx9vz5cP0Xlid-jqM_gVjW3sUfore84S8"
)
BOOKINGS_TAB: str = os.environ.get("BOOKINGS_TAB", "إدخال الحجوزات")

# Confirmed bookings are also posted to this Telegram group (bot must be a member).
GROUP_CHAT_ID: str = os.environ.get("GROUP_CHAT_ID", "-5001910339")

# Expenses are appended to this tab (same spreadsheet) and posted to a separate group.
EXPENSE_TAB: str = os.environ.get("EXPENSE_TAB", "مصروفات عامة")
EXPENSE_GROUP_CHAT_ID: str = os.environ.get("EXPENSE_GROUP_CHAT_ID", "-5072732996")

# Telegram user IDs that skip the booking/expense choice → booking flow directly.
BOOKING_USER_IDS: set[int] = {
    int(uid.strip())
    for uid in os.environ.get("BOOKING_USER_IDS", "7941350507,5793725130").split(",")
    if uid.strip()
}

# Telegram usernames (lower-cased, no @) that skip the booking/expense choice → expense flow.
EXPENSE_USERNAMES: set[str] = {
    u.strip().lower().lstrip("@")
    for u in os.environ.get("EXPENSE_USERNAMES", "seiiffseiif").split(",")
    if u.strip()
}
ADMIN_IDS: set[int] = {
    int(uid.strip())
    for uid in os.environ.get("ADMIN_IDS", "").split(",")
    if uid.strip()
}
