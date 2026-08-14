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

from backfill import parse_sheet_id


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
