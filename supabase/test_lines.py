"""Which sheet line a payment lands on.

The rule, as the user stated it: a payment in a method the booking already has
is ADDED to that method's line; a method not seen on the booking opens a new
row; and a third payment is checked against every line that exists by then, not
just the first. Getting this wrong is expensive in both directions — a wrong
merge hides money inside someone else's cell, a wrong split inserts a row that
shifts every row beneath it.

    python -m pytest supabase/test_lines.py
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mirror import (block_end, line_key, line_payload, open_line, plan_allocation,
                    primary_payload, shift_rows_down)


def booking(method="كاش", currency="EGP", lines=(), unallocated=(), **extra):
    """A row shaped like the mirror's SELECT, with only what allocation reads."""
    row = {
        "id": 413, "sheet_row": 10, "guest_name": "ضيف",
        "payment_method": method, "primary_currency": currency,
        "lines": list(lines), "unallocated": list(unallocated),
    }
    row.update(extra)
    return row


def payment(pid, amount, method, currency="EGP"):
    return {"id": pid, "amount": amount, "method": method, "currency": currency}


def line(seq, method, sheet_row, amount=0, currency="EGP"):
    return {"id": 900 + seq, "seq": seq, "method": method, "currency": currency,
            "sheet_row": sheet_row, "amount": amount, "payload": None}


# ── the same method joins the line it is already on ──────────────────────────

def test_same_method_as_the_booking_joins_line_one():
    row = booking(method="كاش", unallocated=[payment(1, 500, "كاش")])
    merges, opens, adopted = plan_allocation(row)
    assert merges == [(1, 1)]
    assert opens == []
    assert adopted is None


def test_same_method_as_a_second_line_joins_that_line():
    row = booking(method="كاش",
                  lines=[line(2, "انستاباي", 11, amount=1600)],
                  unallocated=[payment(1, 400, "انستاباي")])
    merges, opens, _ = plan_allocation(row)
    assert merges == [(1, 2)]
    assert opens == []


def test_a_third_payment_checks_every_line():
    """The user's own words: see if its type is already there in the 1st or 2nd."""
    row = booking(method="كاش",
                  lines=[line(2, "انستاباي", 11), line(3, "فودافون كاش", 12)],
                  unallocated=[payment(1, 100, "فودافون كاش")])
    merges, opens, _ = plan_allocation(row)
    assert merges == [(1, 3)]
    assert opens == []


def test_two_payments_of_the_same_new_method_share_one_new_line():
    row = booking(method="كاش", unallocated=[payment(1, 300, "انستاباي"),
                                             payment(2, 200, "انستاباي")])
    merges, opens, _ = plan_allocation(row)
    assert merges == []
    assert len(opens) == 1
    assert opens[0]["seq"] == 2
    assert opens[0]["amount"] == 500          # one row, holding their sum
    assert opens[0]["payment_ids"] == [1, 2]


# ── a method not seen before opens a row ─────────────────────────────────────

def test_a_new_method_opens_the_next_line():
    row = booking(method="كاش", unallocated=[payment(1, 1600, "انستاباي")])
    merges, opens, _ = plan_allocation(row)
    assert merges == []
    assert opens == [{"seq": 2, "method": "انستاباي", "currency": "EGP",
                      "amount": 1600.0, "payment_ids": [1]}]


def test_new_lines_number_after_the_ones_that_exist():
    row = booking(method="كاش", lines=[line(2, "انستاباي", 11)],
                  unallocated=[payment(1, 90, "فودافون كاش")])
    _merges, opens, _ = plan_allocation(row)
    assert opens[0]["seq"] == 3


def test_two_different_new_methods_open_two_lines():
    row = booking(method="كاش", unallocated=[payment(1, 300, "انستاباي"),
                                             payment(2, 200, "فودافون كاش")])
    _merges, opens, _ = plan_allocation(row)
    assert [o["seq"] for o in opens] == [2, 3]
    assert [o["method"] for o in opens] == ["انستاباي", "فودافون كاش"]


# ── currency is part of what makes a line ────────────────────────────────────

def test_the_same_method_in_another_currency_is_another_line():
    """No exchange rates: 1000 كاش جنيه and 50 كاش يورو cannot share a cell."""
    row = booking(method="كاش", currency="EGP",
                  unallocated=[payment(1, 50, "كاش", currency="EUR")])
    merges, opens, _ = plan_allocation(row)
    assert merges == []
    assert opens[0]["currency"] == "EUR"


def test_a_payment_with_no_currency_is_the_default():
    assert line_key("كاش", None) == ("كاش", "EGP")
    assert line_key("كاش", "  ") == ("كاش", "EGP")


def test_a_method_is_compared_without_its_padding():
    row = booking(method="كاش", unallocated=[payment(1, 500, " كاش ")])
    merges, opens, _ = plan_allocation(row)
    assert merges == [(1, 1)]
    assert opens == []


# ── a booking with no method at all ──────────────────────────────────────────

def test_the_first_payment_fills_an_empty_method_cell():
    """Not a second line: an empty طريقة الدفع with a line under it is nonsense."""
    row = booking(method="", unallocated=[payment(1, 700, "انستاباي")])
    merges, opens, adopted = plan_allocation(row)
    assert merges == [(1, 1)]
    assert opens == []
    assert adopted == ("انستاباي", "EGP")


def test_a_later_different_method_still_opens_a_line():
    row = booking(method="", unallocated=[payment(1, 700, "انستاباي"),
                                          payment(2, 300, "كاش")])
    merges, opens, adopted = plan_allocation(row)
    assert merges == [(1, 1)]
    assert adopted == ("انستاباي", "EGP")
    assert [o["method"] for o in opens] == ["كاش"]


# ── nothing to do ────────────────────────────────────────────────────────────

def test_a_booking_with_no_loose_payments_is_left_alone():
    row = booking(method="كاش", lines=[line(2, "انستاباي", 11)])
    assert plan_allocation(row) == ([], [], None)


# ── where the new row goes ───────────────────────────────────────────────────

def test_the_row_goes_under_the_booking_when_it_is_alone():
    assert block_end(booking()) == 10


def test_the_row_goes_under_the_last_line_the_booking_owns():
    row = booking(lines=[line(2, "انستاباي", 11), line(3, "فودافون كاش", 12)])
    assert block_end(row) == 12


def test_a_line_that_owns_no_row_yet_does_not_move_the_block():
    row = booking(lines=[line(2, "انستاباي", None)])
    assert block_end(row) == 10


# ── what the rows then say ───────────────────────────────────────────────────

def money_row(**over):
    row = {"id": 413, "sheet_row": 10, "booking_ref": "", "guest_ref": "",
           "guest_name": "ضيف", "booking_type": "", "phone": "",
           "apartment_name": "", "room_number": "", "arrival": None,
           "nights": 2, "open_ended": False, "total": 2200, "paid": 2200,
           "payment_method": "كاش", "notes": ""}
    row.update(over)
    return row


def test_a_line_shows_what_was_paid_in_its_own_method():
    row = money_row()
    want = line_payload(row, line(2, "انستاباي", 11, amount=1600), 11)
    assert want["total"] == "1600"
    assert want["paid"] == "1600"
    assert want["payment_method"] == "انستاباي"
    assert want["booking_id"] == "413-2"


def test_a_merged_payment_grows_the_cell_it_landed_in():
    """Two انستاباي payments are one line of 1600, not two rows of 800."""
    row = money_row()
    want = line_payload(row, line(2, "انستاباي", 11, amount=800 + 800), 11)
    assert want["total"] == "1600"


def test_the_booking_row_holds_what_the_other_lines_do_not():
    row = money_row()
    want = primary_payload(row, [line(2, "انستاباي", 11, amount=1600)], 10)
    assert want["total"] == "600"
    assert want["paid"] == "600"
    # ...and the lines still sum to the total the database holds.
    assert float(want["paid"]) + 1600 == float(row["paid"])


def test_three_lines_still_sum_back_to_the_booking():
    row = money_row(total=3000, paid=3000)
    lines = [line(2, "انستاباي", 11, amount=1000),
             line(3, "فودافون كاش", 12, amount=500)]
    want = primary_payload(row, lines, 10)
    assert want["paid"] == "1500"


@pytest.mark.parametrize("lines", [[], None])
def test_a_booking_on_one_line_is_untouched_by_the_split(lines):
    row = money_row()
    want = primary_payload(row, lines or [], 10)
    assert want["paid"] == "2200"


# ── inserting the row ────────────────────────────────────────────────────────
#
# Driven through fakes rather than the live sheet: an insert moves every row
# beneath it, and rehearsing that on real bookings is the exact accident this
# code exists to prevent.

class FakeCursor:
    def __init__(self, returns=()):
        self.sql = []
        self._returns = list(returns)

    def execute(self, sql, params=None):
        self.sql.append((" ".join(sql.split()), params))

    def fetchone(self):
        return self._returns.pop(0)


class FakeSheet:
    def __init__(self):
        self.inserted = []

    def insert_rows(self, values, row=1, inherit_from_before=False):
        self.inserted.append((row, inherit_from_before))


def test_the_shift_goes_through_negatives_first():
    """sheet_row is UNIQUE and not deferrable, so +1 in one pass collides."""
    cur = FakeCursor()
    shift_rows_down(cur, 12)
    order = [sql for sql, _ in cur.sql]
    assert len(order) == 6                       # three tables, two passes each
    for table in ("bookings", "payments", "booking_lines"):
        park = f"update {table} set sheet_row = -(sheet_row + 1) where sheet_row >= %s;"
        back = f"update {table} set sheet_row = -sheet_row where sheet_row < 0;"
        assert order.index(park) < order.index(back)


def test_every_table_that_remembers_a_row_is_shifted():
    cur = FakeCursor()
    shift_rows_down(cur, 12)
    shifted = {sql.split()[1] for sql, _ in cur.sql}
    assert shifted == {"bookings", "payments", "booking_lines"}


def test_the_new_row_lands_directly_under_the_block():
    cur = FakeCursor(returns=[(77,)])
    ws = FakeSheet()
    row = booking(lines=[line(2, "انستاباي", 11)])          # block ends at 11
    _line_id, at_row = open_line(cur, ws, row,
                                 {"seq": 3, "method": "فودافون كاش",
                                  "currency": "EGP", "amount": 90,
                                  "payment_ids": [7]})
    assert at_row == 12
    assert ws.inserted == [(12, True)]           # inheritFromBefore, as by hand


def test_the_line_is_recorded_before_its_row_and_claims_it_after_the_shift():
    cur = FakeCursor(returns=[(77,)])
    row = booking()
    open_line(cur, FakeSheet(), row,
              {"seq": 2, "method": "انستاباي", "currency": "EGP",
               "amount": 500, "payment_ids": [7, 8]})
    steps = [sql for sql, _ in cur.sql]
    assert steps[0].startswith("insert into booking_lines")
    assert steps[1].startswith("update payments set line_seq")
    assert steps[-1].startswith("update booking_lines set sheet_row")
    # The line takes its row only after everything below has moved out of it.
    assert any("-(sheet_row + 1)" in s for s in steps[2:-1])
    assert cur.sql[-1][1] == (11, 77)


def test_both_payments_of_a_new_line_are_assigned_together():
    cur = FakeCursor(returns=[(77,)])
    open_line(cur, FakeSheet(), booking(),
              {"seq": 2, "method": "انستاباي", "currency": "EGP",
               "amount": 500, "payment_ids": [7, 8]})
    assign = next(params for sql, params in cur.sql
                  if sql.startswith("update payments set line_seq"))
    assert assign == (2, [7, 8])
