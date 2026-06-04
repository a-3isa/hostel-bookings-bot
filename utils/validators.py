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
