"""The generated graph still matches what the JS expects.

`validate_workflow.py` checks the file on disk. This checks the generator, and
adds the case that matters most: that the checks themselves still fail when the
contract is broken. A validator that has quietly stopped testing anything passes
just as cleanly as one that works, and the difference only shows up the day
something is actually wrong.

    python -m pytest booking_bot/test_workflow.py
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build_workflow as bw
import validate_workflow as vw


@pytest.fixture(scope="module")
def graph():
    return bw.build()


@pytest.fixture(scope="module")
def nodes(graph):
    return {n["name"]: n for n in graph.nodes}


def test_config_covers_every_key_the_js_reads(nodes):
    """CFG.X with no assignment is undefined, and reaches Telegram as the
    literal string "undefined" — the announcement posts into nothing."""
    have = {a["name"] for a in
            nodes["Config"]["parameters"]["assignments"]["assignments"]}
    missing = vw.cfg_keys_used() - have
    assert not missing, f"Config is missing {sorted(missing)}"


def test_every_save_flow_has_a_route(nodes):
    """Route Save has fallbackOutput 'none', so an unrouted flow is dropped in
    silence: the user taps Save, the sheet never changes, nothing errors."""
    keys = {r["outputKey"] for r in
            nodes["Route Save"]["parameters"]["rules"]["values"]}
    assert vw.brain_flows() == keys


def test_the_brain_reads_only_nodes_that_exist(nodes):
    """$('...') resolves at runtime. A missing one fails when that branch is
    first exercised, which for the edit flow could be days after deploy."""
    for name, node in nodes.items():
        code = node.get("parameters", {}).get("jsCode")
        if not code:
            continue
        for ref in set(vw.NODE_REF.findall(code)):
            assert ref in nodes, f"{name}: $('{ref}') names no node"


def test_no_sheets_append_anywhere(nodes):
    """append writes an empty string into every unmapped column, which is how
    the sheet's formula columns (K, N, P, R, S, T) get destroyed."""
    for name, node in nodes.items():
        if node["type"].endswith("googleSheets"):
            assert node["parameters"].get("operation") not in ("append", "appendOrUpdate"), \
                f"{name} uses append"


def test_every_node_is_reachable_from_the_trigger(graph, nodes):
    seen, queue = set(), ["Telegram Trigger"]
    while queue:
        cur = queue.pop()
        if cur in seen:
            continue
        seen.add(cur)
        for branch in graph.connections.get(cur, {}).get("main", []):
            queue += [l["node"] for l in branch]
    assert set(nodes) == seen, f"unreachable: {sorted(set(nodes) - seen)}"


def test_the_writers_all_have_an_error_output():
    """The Sheets write is the step that actually fails — a revoked token, a
    renamed tab. Without continueErrorOutput the run dies and the user is told
    nothing, which looks exactly like the Save button doing nothing."""
    nodes = {n["name"]: n for n in bw.build().nodes}
    for writer in ("Write Booking Row", "Write Expense Row", "Write Edit Row"):
        assert nodes[writer].get("onError") == "continueErrorOutput"


def test_the_session_is_saved_on_every_turn(graph):
    """Not behind a branch. The Brain defaults sessionState/sessionData to what
    it loaded, so an ignored tap rewrites the same values rather than needing a
    gate that could drop a real one."""
    targets = [l["node"] for br in graph.connections["Brain"]["main"] for l in br]
    assert "Save Session" in targets


def test_the_cancel_format_cannot_touch_another_tab(nodes):
    """The Sheets API addresses a tab by numeric id, and the wrong id does not
    error — it formats that row of a different tab. So the step is gated on the
    gid being filled in, and unset means skip."""
    conds = nodes["Should Format Row?"]["parameters"]["conditions"]
    assert conds["combinator"] == "and"
    leftvals = " ".join(c["leftValue"] for c in conds["conditions"])
    assert "BOOKINGS_SHEET_GID" in leftvals
    assert "formatRow" in leftvals


# ── The checks still bite ────────────────────────────────────────────────────

def test_a_missing_config_key_is_caught(monkeypatch):
    monkeypatch.setattr(vw, "cfg_keys_used", lambda: {"NOT_IN_CONFIG"})
    nodes = {n["name"]: n for n in bw.build().nodes}
    have = {a["name"] for a in
            nodes["Config"]["parameters"]["assignments"]["assignments"]}
    assert vw.cfg_keys_used() - have == {"NOT_IN_CONFIG"}


def test_an_unrouted_flow_is_caught(monkeypatch):
    monkeypatch.setattr(vw, "brain_flows", lambda: {"booking", "refund"})
    nodes = {n["name"]: n for n in bw.build().nodes}
    keys = {r["outputKey"] for r in
            nodes["Route Save"]["parameters"]["rules"]["values"]}
    assert vw.brain_flows() - keys == {"refund"}
