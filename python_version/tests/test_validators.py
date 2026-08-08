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
