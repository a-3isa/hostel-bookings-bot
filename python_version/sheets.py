import re
import time
import gspread
from gspread.utils import rowcol_to_a1
from google.oauth2.service_account import Credentials
import config

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

_gc: gspread.Client | None = None
_gc_created_at: float = 0
_GC_TTL = 1800  # reuse client for 30 minutes, then refresh


def _client() -> gspread.Client:
    global _gc, _gc_created_at
    if _gc is None or (time.time() - _gc_created_at) > _GC_TTL:
        creds = Credentials.from_service_account_file(config.GOOGLE_CREDENTIALS_JSON, scopes=SCOPES)
        _gc = gspread.authorize(creds)
        _gc_created_at = time.time()
    return _gc


_cache: dict = {}
_cache_ts: dict = {}
_CACHE_TTL = 30  # cache locations/rooms for 30 seconds


def _cached(key: str, loader):
    now = time.time()
    if key not in _cache or (now - _cache_ts.get(key, 0)) > _CACHE_TTL:
        _cache[key] = loader()
        _cache_ts[key] = now
    return _cache[key]


def _invalidate(key: str):
    _cache.pop(key, None)
    _cache_ts.pop(key, None)


def _worksheet(name: str) -> gspread.Worksheet:
    return _client().open_by_key(config.SHEET_ID).worksheet(name)


def get_config() -> dict:
    ws = _worksheet("Config")
    return {row["key"]: row["value"] for row in ws.get_all_records()}


def get_locations() -> list[dict]:
    return _cached("locations", lambda: _worksheet("Locations").get_all_records())


def get_available_rooms(location_id: str) -> list[dict]:
    rows = _cached("rooms", lambda: _worksheet("Rooms").get_all_records())
    return [
        r for r in rows
        if r["location_id"] == location_id and str(r["is_available"]).upper() == "TRUE"
    ]


def get_room(room_id: str) -> dict | None:
    rows = _cached("rooms", lambda: _worksheet("Rooms").get_all_records())
    return next((r for r in rows if r["room_id"] == room_id), None)


def set_room_availability(room_id: str, is_available: bool) -> None:
    ws = _worksheet("Rooms")
    cell = ws.find(room_id, in_column=1)
    if cell is None:
        raise ValueError(f"Room {room_id} not found")
    header = ws.row_values(1)
    col = header.index("is_available") + 1
    ws.update_cell(cell.row, col, "TRUE" if is_available else "FALSE")
    _invalidate("rooms")  # force fresh read on next request


def increment_booking_counter() -> int:
    ws = _worksheet("Config")
    cell = ws.find("booking_counter", in_column=1)
    if cell is None:
        raise ValueError("booking_counter key missing from Config sheet")
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


def _col_letter(col_idx: int) -> str:
    return re.sub(r"\d+", "", rowcol_to_a1(1, col_idx))


def append_booking_row(row_by_header: dict, formula_cells: dict | None = None) -> None:
    """Append one booking row keyed by exact Arabic header strings.

    Values are written with USER_ENTERED so ISO dates become real dates and
    numbers stay numeric. `formula_cells` maps a header name to a formula
    template that may reference `{row}` (the appended row index) and
    `{arrival_col}` (column letter of "تاريخ البداية"); each is patched in
    after the row index is known.
    """
    ws = _worksheet("Bookings")
    header = ws.row_values(1)
    row = [row_by_header.get(col, "") for col in header]
    resp = ws.append_row(row, value_input_option="USER_ENTERED")

    if not formula_cells:
        return

    updated_range = resp["updates"]["updatedRange"]  # e.g. "Bookings!A7:S7"
    start_cell = updated_range.split("!")[-1].split(":")[0]
    row_idx = int(re.sub(r"[A-Z]+", "", start_cell))
    arrival_col = _col_letter(header.index("تاريخ البداية") + 1)

    for hdr, template in formula_cells.items():
        col = header.index(hdr) + 1
        formula = template.format(row=row_idx, arrival_col=arrival_col)
        ws.update_cell(row_idx, col, formula)


def append_booking_input(a_to_j: list, l_m: list, o_and_q: list) -> int:
    """Append a booking to the configured bookings tab at the TRUE last data row.

    This tab owns fill-down formulas in several columns (B, K, N, P, R, S) that extend
    far below the real data, so a naive append_row would land in the formula zone.
    Instead we find the last non-empty row of the manual key column C (اسم المقيم)
    and write only the input columns (A–J, L–M, O, Q), leaving the formula columns
    untouched so the sheet recomputes them.

    Formula strings inside `a_to_j` (e.g. the open-ended nights cell) may use `{row}`.
    """
    ws = _client().open_by_key(config.BOOKINGS_SHEET_ID).worksheet(config.BOOKINGS_TAB)
    r = len(ws.col_values(3)) + 1  # column C = اسم المقيم (no formula → true last row)

    def _sub(seq):
        return [v.format(row=r) if isinstance(v, str) and v.startswith("=") else v for v in seq]

    ws.batch_update(
        [
            {"range": f"A{r}:J{r}", "values": [_sub(a_to_j)]},
            {"range": f"L{r}:M{r}", "values": [l_m]},
            {"range": f"O{r}", "values": [[o_and_q[0]]]},
            {"range": f"Q{r}", "values": [[o_and_q[1]]]},
        ],
        value_input_option="USER_ENTERED",
    )
    return r


def append_expense_row(row_a_to_h: list) -> int:
    """Append an expense to the expense tab at the true last row (plain log, no formulas)."""
    ws = _client().open_by_key(config.BOOKINGS_SHEET_ID).worksheet(config.EXPENSE_TAB)
    r = len(ws.col_values(2)) + 1  # column B = البند (manual key column)
    ws.update(range_name=f"A{r}:H{r}", values=[row_a_to_h], value_input_option="USER_ENTERED")
    return r


def get_booking_by_ref(ref: str) -> dict | None:
    rows = _worksheet("Bookings").get_all_records()
    return next((r for r in rows if r["booking_ref"] == ref), None)


def add_room(location_id: str, room_number: str) -> str:
    ws = _worksheet("Rooms")
    rooms = ws.get_all_records()
    nums = [int(r["room_id"][2:]) for r in rooms if r["room_id"][2:].isdigit()]
    next_num = max(nums) + 1 if nums else 1
    room_id = f"RM{next_num:03d}"
    header = ws.row_values(1)
    row_data = {
        "room_id": room_id,
        "location_id": location_id,
        "room_number": room_number,
        "is_available": "TRUE",
        "photo_file_ids": "",
    }
    ws.append_row([row_data.get(col, "") for col in header])
    _invalidate("rooms")
    return room_id


def remove_room(room_id: str) -> None:
    ws = _worksheet("Rooms")
    cell = ws.find(room_id, in_column=1)
    if cell is None:
        raise ValueError(f"Room {room_id} not found")
    ws.delete_rows(cell.row)
    _invalidate("rooms")


def get_rooms_by_location(location_id: str) -> list[dict]:
    rows = _worksheet("Rooms").get_all_records()
    return [r for r in rows if r["location_id"] == location_id]
