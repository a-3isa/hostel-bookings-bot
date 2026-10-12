"""The model's contract still matches what brain.js accepts.

The enum the model may answer from and the keys brain.js PAYMENTS knows are two
lists in two languages. This pins them together, so adding a payment method in
one place and forgetting the other fails here rather than as a model answer the
Brain quietly refuses.

    python -m pytest booking_bot/test_ai_intent.py
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ai_intent

HERE = os.path.dirname(os.path.abspath(__file__))


def brain_payment_keys():
    with open(os.path.join(HERE, "brain.js"), encoding="utf-8") as fh:
        src = fh.read()
    block = re.search(r"const PAYMENTS = \[(.*?)\];", src, re.S).group(1)
    return re.findall(r"key:\s*'(\w+)'", block)


def test_methods_are_the_brains_payment_keys_minus_unpaid():
    assert ai_intent.METHODS == [k for k in brain_payment_keys() if k != "unpaid"]


def test_the_schema_offers_exactly_those_methods():
    enum = ai_intent.SCHEMA["properties"]["payment"]["properties"]["method"]["enum"]
    assert enum == ai_intent.METHODS


def test_the_schema_has_no_nulls_and_nothing_is_required_but_the_shape():
    # Fields the model leaves out are simply absent; brain.js treats null alike.
    assert "required" not in ai_intent.SCHEMA
    assert "null" not in repr(ai_intent.SCHEMA)


def test_every_stay_kind_the_brain_reads_is_offered():
    kinds = ai_intent.SCHEMA["properties"]["stay"]["properties"]["kind"]["enum"]
    assert kinds == ["extend", "until", "leave"]


def test_the_prompt_names_every_method_and_the_currency_rule():
    for key in ai_intent.METHODS:
        assert f'"{key}"' in ai_intent.PROMPT, key
    assert "currency" in ai_intent.PROMPT


def test_n8n_rendering_is_an_expression_with_two_live_parts():
    text = ai_intent.n8n_prompt()
    assert text.startswith("=")
    assert "<<" not in text
    assert text.count("{{") == 2
    assert "Africa/Cairo" in text
    assert "$('Read Locations')" in text
    # The apartment list is best-effort (spec 5.2): an unexecuted Read Locations
    # must not make the whole extraction throw, as it did on the first live message.
    assert "$('Read Locations').isExecuted" in text


def test_plain_rendering_fills_both_tokens():
    text = ai_intent.render_prompt("2026-10-12", ["انبي 2", "ذاكر حسين"])
    assert "2026-10-12" in text
    assert "انبي 2، ذاكر حسين" in text
    assert "<<" not in text and "{{" not in text
