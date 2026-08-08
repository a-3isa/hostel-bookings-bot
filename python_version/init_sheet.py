"""One-time script to create all 4 sheet tabs with correct headers and seed Config data."""
import gspread
from google.oauth2.service_account import Credentials
import os
from dotenv import load_dotenv

load_dotenv()

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
creds = Credentials.from_service_account_file(os.environ["GOOGLE_CREDENTIALS_JSON"], scopes=SCOPES)
gc = gspread.authorize(creds)
spreadsheet = gc.open_by_key(os.environ["SHEET_ID"])

existing = {ws.title for ws in spreadsheet.worksheets()}

def get_or_create(title, rows=100, cols=20):
    if title in existing:
        print(f"  Sheet '{title}' already exists — skipping create")
        return spreadsheet.worksheet(title)
    ws = spreadsheet.add_worksheet(title=title, rows=rows, cols=cols)
    print(f"  Created sheet '{title}'")
    return ws

print("Setting up Locations sheet...")
ws = get_or_create("Locations")
if ws.row_values(1) == []:
    ws.append_row(["location_id", "name", "address"])
    print("  Headers written")

print("Setting up Rooms sheet...")
ws = get_or_create("Rooms")
if ws.row_values(1) == []:
    ws.append_row(["room_id", "location_id", "room_number", "is_available", "photo_file_ids"])
    print("  Headers written")

print("Setting up Bookings sheet...")
ws = get_or_create("Bookings")
if ws.row_values(1) == []:
    ws.append_row([
        "booking_ref", "room_id", "room_number", "location_id", "location_name",
        "check_in", "check_out", "arrival_time", "guest_name", "phone",
        "telegram_id", "created_at"
    ])
    print("  Headers written")

print("Setting up Config sheet...")
ws = get_or_create("Config")
if ws.row_values(1) == []:
    ws.append_row(["key", "value"])
    ws.append_row(["host_phone", ""])
    ws.append_row(["host_chat_id", "-5137206602"])
    ws.append_row(["booking_counter", "0"])
    ws.append_row(["rules", "No smoking. Check-in after 14:00. Check-out by 11:00. Any damage will be charged."])
    print("  Config seeded")
else:
    # Update host_chat_id if config already exists
    records = ws.get_all_records()
    for i, row in enumerate(records, start=2):
        if row.get("key") == "host_chat_id":
            header = ws.row_values(1)
            col = header.index("value") + 1
            ws.update_cell(i, col, "-5137206602")
            print("  Updated host_chat_id")
            break

# Remove default "Sheet1" if present
for ws in spreadsheet.worksheets():
    if ws.title == "Sheet1":
        spreadsheet.del_worksheet(ws)
        print("Removed default 'Sheet1'")

print("\nDone! Sheet structure is ready.")
print(f"Open your sheet: https://docs.google.com/spreadsheets/d/{os.environ['SHEET_ID']}/edit")
