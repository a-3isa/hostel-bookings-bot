"""Load real locations and rooms into Google Sheets."""
import gspread
from google.oauth2.service_account import Credentials
import os
from dotenv import load_dotenv

load_dotenv()

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
creds = Credentials.from_service_account_file(os.environ["GOOGLE_CREDENTIALS_JSON"], scopes=SCOPES)
gc = gspread.authorize(creds)
spreadsheet = gc.open_by_key(os.environ["SHEET_ID"])

LOCATIONS = [
    {"id": "LOC001", "name": "ذاكر حسين",    "rooms": 5},
    {"id": "LOC002", "name": "احمد فهيم",     "rooms": 5},
    {"id": "LOC003", "name": "انبي 3",         "rooms": 4},
    {"id": "LOC004", "name": "انبي 2",         "rooms": 4},
    {"id": "LOC005", "name": "ابو حديد 11",   "rooms": 4},
    {"id": "LOC006", "name": "عبدالله العربي", "rooms": 4},
]

# --- Locations sheet ---
ws_loc = spreadsheet.worksheet("Locations")
ws_loc.clear()
ws_loc.append_row(["location_id", "name", "address"])
for loc in LOCATIONS:
    ws_loc.append_row([loc["id"], loc["name"], ""])
print(f"Added {len(LOCATIONS)} locations.")

# --- Rooms sheet ---
ws_rooms = spreadsheet.worksheet("Rooms")
ws_rooms.clear()
ws_rooms.append_row(["room_id", "location_id", "room_number", "is_available", "photo_file_ids"])

room_counter = 1
for loc in LOCATIONS:
    for i in range(1, loc["rooms"] + 1):
        room_id = f"RM{room_counter:03d}"
        ws_rooms.append_row([room_id, loc["id"], str(i), "TRUE", ""])
        room_counter += 1

total_rooms = room_counter - 1
print(f"Added {total_rooms} rooms across all locations.")
print("\nDone! Your sheet is now populated with real data.")
