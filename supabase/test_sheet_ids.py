"""Column U, read as an identity.

Four scripts read this cell — backfill, reindex, mirror and heal_formulas — and
they have to agree about it exactly. They disagreed about column U once before,
when the snapshot read A:T and the n8n node read A:U, and it cost three bugs
that all looked like real differences between the sheet and the database.

    python -m pytest supabase/test_sheet_ids.py
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backfill import continuation_seq, is_open_ended, parse_sheet_id


@pytest.mark.parametrize("raw, expected", [
    ("413", (413, 1)),          # the booking's own line
    ("413-2", (413, 2)),        # its second payment line
    ("413-10", (413, 10)),
    (" 413-3 ", (413, 3)),      # a cell the sheet padded
    ("1", (1, 1)),
])
def test_reads_an_identity(raw, expected):
    assert parse_sheet_id(raw) == expected


@pytest.mark.parametrize("raw", [
    "", "   ", None,
    "413-",                     # half-typed, and not an identity yet
    "-2",
    "413-0",                    # there is no line zero; sequences start at 1
    "413 - 2",                  # spaces inside are someone writing prose
    "413.2",
    "abc",
    "ملغي",                      # a note typed into the wrong column
])
def test_refuses_anything_else(raw):
    assert parse_sheet_id(raw) == (None, None)


def test_a_plain_id_is_line_one():
    """`413` and `413-1` are the same line, so callers can compare sequences."""
    assert parse_sheet_id("413") == parse_sheet_id("413-1")


def test_the_base_is_always_the_booking():
    """A suffix never makes a new id. `413-2` is booking 413, not booking 4132."""
    assert parse_sheet_id("413-2")[0] == parse_sheet_id("413")[0]


# ── A repeated booking id is a LINE, not a second booking ────────────────────
#
# The 2026-08-22 incident. A 1,000 كاش line was added by hand under خالد عاشور,
# and column U was copied down with the row, so two rows carried a bare `1102`.
# reindex re-points a booking to wherever U says it is, so it moved the booking
# onto its own payment line; backfill upserts keyed on sheet_row, so it wrote
# that row's content onto the booking below and every one after it. Ten guests'
# records were overwritten in a single run.

def _row(**over):
    """A sheet row as load_bookings sees it: a list indexed by column."""
    cells = [""] * 21
    for key, idx in (("guest_name", 2), ("apartment", 6), ("room", 7),
                     ("total", 11), ("paid", 12)):
        if key in over:
            cells[idx] = over[key]
    return cells


def test_a_named_row_repeating_an_id_is_a_line():
    """The shape the bot itself writes: the guest's name repeated on the line."""
    seq = continuation_seq(_row(guest_name="خالد عاشور", apartment="انبي 2",
                                room="4", total="1000", paid="1000"),
                           1102, {1102}, {1102: 1})
    assert seq == 2


def test_a_nameless_row_repeating_an_id_is_still_a_line():
    """Row 18, merged by hand with the guest cell left blank."""
    assert continuation_seq(_row(paid="3500"), 16, {16}, {16: 1}) == 2


def test_a_third_line_numbers_after_the_second():
    assert continuation_seq(_row(paid="500"), 21, {21}, {21: 2}) == 3


def test_a_row_whose_id_no_named_row_above_holds_is_not_a_line():
    """Otherwise the first row of a booking would be read as its own line."""
    assert continuation_seq(_row(guest_name="ضيف", paid="100"), 99, set(), {}) is None


def test_a_row_with_no_money_is_not_a_line():
    """A blank row that merely inherited a stamp is not a payment of anything."""
    assert continuation_seq(_row(guest_name="خالد عاشور"), 1102, {1102}, {1102: 1}) is None


def test_an_unstamped_row_is_not_a_line():
    assert continuation_seq(_row(paid="100"), None, {1102}, {1102: 1}) is None


# ── Open-ended means TODAY(), not "any formula" ──────────────────────────────
#
# Row 96 was typed as `= 5+9` on 2026-08-22 — a fourteen-night stay whose count
# somebody worked out in the cell. `startswith("=")` called that open-ended, so
# the nights were stored as NULL and effective_total recomputed the price from
# today − arrival: a 9,800 booking reported as 3,500, and a reconcile
# difference that no amount of re-running could settle.

def test_the_bots_own_open_ended_formula_counts():
    assert is_open_ended("=TODAY()-J96") is True
    assert is_open_ended("=TODAY() - J96") is True
    assert is_open_ended("=today()-J2") is True


def test_arithmetic_in_the_nights_cell_is_not_open_ended():
    assert is_open_ended("= 5+9") is False
    assert is_open_ended("=5+9") is False
    assert is_open_ended("=J96+I96") is False


def test_a_plain_number_is_not_open_ended():
    assert is_open_ended("14") is False
    assert is_open_ended("") is False
    assert is_open_ended(None) is False
