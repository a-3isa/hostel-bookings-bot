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
