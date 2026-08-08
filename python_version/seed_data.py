"""Add one sample location and room — edit the sheet directly to replace with real data."""
import gspread
from google.oauth2.service_account import Credentials
import os
from dotenv import load_dotenv

load_dotenv()

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
creds = Credentials.from_service_account_file(os.environ["GOOGLE_CREDENTIALS_JSON"], scopes=SCOPES)
gc = gspread.authorize(creds)
spreadsheet = gc.open_by_key(os.environ["SHEET_ID"])

# Add sample location
ws = spreadsheet.worksheet("Locations")
if len(ws.get_all_records()) == 0:
    ws.append_row(["LOC001", "Main Branch", "Enter your address here"])
    print("Added sample location: LOC001 - Main Branch")

# Add sample room
ws = spreadsheet.worksheet("Rooms")
if len(ws.get_all_records()) == 0:
    ws.append_row(["RM001", "LOC001", "101", "TRUE", ""])
    print("Added sample room: RM001 - Room 101 (available, no photos yet)")

print("\nSample data added. Edit the Google Sheet to add your real locations and rooms.")
