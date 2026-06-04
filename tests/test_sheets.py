import os
os.environ.setdefault("BOT_TOKEN", "test")
os.environ.setdefault("SHEET_ID", "test")
os.environ.setdefault("GOOGLE_CREDENTIALS_JSON", "test.json")
os.environ.setdefault("ADMIN_IDS", "")

import pytest
from unittest.mock import MagicMock, patch
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


@patch("sheets._worksheet")
def test_increment_booking_counter_raises_if_key_missing(mock_ws):
    ws = MagicMock()
    ws.find.return_value = None
    mock_ws.return_value = ws
    with pytest.raises(ValueError, match="booking_counter"):
        sheets.increment_booking_counter()
