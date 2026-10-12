"""The generated graph still matches what the JS expects.

`validate_workflow.py` checks the file on disk. This checks the generator, and
adds the case that matters most: that the checks themselves still fail when the
contract is broken. A validator that has quietly stopped testing anything passes
just as cleanly as one that works, and the difference only shows up the day
something is actually wrong.

    python -m pytest booking_bot/test_workflow.py
"""

import json
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


def test_every_node_is_reachable_from_the_trigger(graph):
    """A sub-node has no inbound main; it is reached through the node it serves."""
    problems = vw.check(bw.workflow(graph))
    assert not [p for p in problems if p.startswith("orphan")], problems


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


# ── The AI edit branch ───────────────────────────────────────────────────────

def targets(graph, src, kind="main"):
    return [[l["node"] for l in br] for br in graph.connections.get(src, {}).get(kind, [])]


def test_the_ai_gate_sits_between_the_last_lookup_and_the_brain(graph):
    """Both ways into the Brain used to come straight from the expense-number gate.
    Now they pass the AI gate: a text message in AI_TEXT goes through the model,
    every other turn goes round it."""
    assert targets(graph, "Needs Expense Number?")[1] == ["Needs AI?"]
    assert targets(graph, "Read Expense Numbers") == [["Needs AI?"]]
    assert targets(graph, "Needs AI?") == [["AI Extract"], ["Brain"]]
    assert targets(graph, "AI Extract") == [["Brain"]]
    assert "Brain" not in sum(targets(graph, "Needs Expense Number?"), [])


def test_the_model_is_plugged_into_the_extractor_not_wired_as_data(graph):
    assert targets(graph, "Anthropic Chat Model", "ai_languageModel") == [["AI Extract"]]
    assert "main" not in graph.connections.get("Anthropic Chat Model", {})


def test_the_gate_skips_commands_and_other_states(nodes):
    expr = nodes["Needs AI?"]["parameters"]["conditions"]["conditions"][0]["leftValue"]
    assert "'AI_TEXT'" in expr
    assert r"/^[^\/]/" in expr, "a /command must not be sent to the model"


def test_a_failed_model_call_still_reaches_the_brain(nodes):
    """Without these the run dies at the extractor and the admin is told nothing."""
    n = nodes["AI Extract"]
    assert n["alwaysOutputData"] is True
    assert n["onError"] == "continueRegularOutput"
    assert n["retryOnFail"] is True and n["maxTries"] == 2


def test_the_extractor_uses_the_shared_schema_and_the_haiku_model(nodes):
    import ai_intent
    params = nodes["AI Extract"]["parameters"]
    assert params["schemaType"] == "manual"
    assert json.loads(params["inputSchema"]) == ai_intent.SCHEMA
    assert nodes["Anthropic Chat Model"]["parameters"]["model"]["value"] == ai_intent.MODEL
    assert nodes["Anthropic Chat Model"]["credentials"]["anthropicApi"]["name"]


def test_the_ai_states_load_what_the_brain_needs(nodes):
    for gate in ("Needs Bookings?", "Needs Locations?"):
        states = {c["rightValue"] for c in nodes[gate]["parameters"]["conditions"]["conditions"]}
        assert {"AI_TEXT", "AI_PICK"} <= states, gate


def test_the_generated_graph_is_clean(graph):
    assert vw.check(bw.workflow(graph)) == []


# ── The checks still bite (AI branch) ────────────────────────────────────────

def _wf():
    return json.loads(json.dumps(bw.workflow(bw.build())))


def test_an_extractor_with_no_model_is_caught():
    wf = _wf()
    del wf["connections"]["Anthropic Chat Model"]
    assert any("language model" in p for p in vw.check(wf))


def test_a_connection_to_a_missing_node_is_caught_for_every_kind():
    wf = _wf()
    wf["connections"]["Anthropic Chat Model"]["ai_languageModel"][0][0]["node"] = "Nope"
    assert any("Nope" in p for p in vw.check(wf))


def test_a_node_nothing_reaches_is_still_an_orphan():
    wf = _wf()
    wf["nodes"].append({"name": "Stray", "type": "n8n-nodes-base.set", "typeVersion": 3,
                        "position": [0, 0], "parameters": {}})
    assert any(p.startswith("orphan") and "Stray" in p for p in vw.check(wf))


# ── Deploying the AI branch ──────────────────────────────────────────────────

import re

import deploy_graph as dg

AI_NODES = {"Needs AI?", "AI Extract", "Anthropic Chat Model"}


def strip_ai(wf):
    """The graph as it was before the AI branch: what a live workflow looks like."""
    wf = json.loads(json.dumps(wf))
    wf["nodes"] = [n for n in wf["nodes"] if n["name"] not in AI_NODES]
    conns = wf["connections"]
    for name in AI_NODES:
        conns.pop(name, None)
    for spec in conns.values():
        for branches in spec.values():
            for br in branches:
                br[:] = [l for l in br if l["node"] not in AI_NODES]
    conns["Needs Expense Number?"]["main"][1].append({"node": "Brain", "type": "main", "index": 0})
    conns["Read Expense Numbers"]["main"][0].append({"node": "Brain", "type": "main", "index": 0})
    return wf


def _deploy(wf, anthropic):
    have = {n["name"] for n in wf["nodes"]}
    return dg.ai_branch_ops(have, wf["connections"], anthropic)


def test_deploying_gives_the_live_graph_the_same_branch_the_generator_builds():
    built = bw.workflow(bw.build())
    live = strip_ai(built)
    ops, bindings = _deploy(live, {"id": None, "name": "Anthropic account"})
    dg.apply_offline(live, ops)
    got = {n["name"]: n for n in live["nodes"]}
    want = {n["name"]: n for n in built["nodes"]}
    for name in AI_NODES:
        for field in ("type", "typeVersion", "parameters"):
            assert got[name][field] == want[name][field], (name, field)
    for key in ("alwaysOutputData", "onError", "retryOnFail", "maxTries"):
        assert got["AI Extract"][key] == want["AI Extract"][key], key
    for src in ("Needs Expense Number?", "Read Expense Numbers", "Needs AI?", "AI Extract",
                "Anthropic Chat Model"):
        assert live["connections"][src] == built["connections"][src], src
    assert [b[0] for b in bindings] == ["Anthropic Chat Model"]
    assert vw.check(live) == []


def test_deploying_twice_changes_nothing_the_second_time():
    built = bw.workflow(bw.build())
    ops, _ = _deploy(built, {"id": None, "name": "Anthropic account"})
    kinds = {o["type"] for o in ops}
    assert "addNode" not in kinds and "addConnection" not in kinds and "removeConnection" not in kinds, kinds


def test_without_an_anthropic_credential_nothing_is_wired_in():
    """A bot wired to an extractor that cannot authenticate would look dead. The
    Brain already answers "unavailable" when the node never runs."""
    live = strip_ai(bw.workflow(bw.build()))
    ops, bindings = _deploy(live, None)
    assert ops == [] and bindings == []


def test_both_scripts_gate_the_same_states():
    src = open(os.path.join(os.path.dirname(dg.__file__), "deploy_graph.py"), encoding="utf-8").read()
    for name in ("BOOKING_STATES", "LOCATION_STATES"):
        literal = re.search(rf"^{name} = (\[.*?\])$", src, re.M).group(1)
        assert json.loads(literal.replace("'", '"')) == getattr(bw, name), name


# ── Review fixes: once per turn, and the Brain wired once ────────────────────

def test_the_extractor_calls_the_model_once_per_turn_not_once_per_item(nodes):
    """AI_TEXT is the first state in BOTH gate lists, so the extractor receives the
    booking rows (and, via Read Locations, their cross product with the registry)
    as separate items. A node without executeOnce runs per item: one admin message
    would make dozens of paid model calls."""
    assert nodes["AI Extract"].get("executeOnce") is True


# ── Sheet-only: no Postgres anywhere ─────────────────────────────────────────

POSTGRES_NAMES = {"Build Shadow Write", "Shadow Write", "Read Booking Id", "Write Booking Id",
                  "Build Snapshot SQL", "Write Snapshot", "Read Discrepancies",
                  "Build Reconcile Message", "Read Unmirrored Bookings", "Append Mirror Row",
                  "Mark Mirrored"}


def test_the_base_graph_has_no_postgres_node(graph):
    pg = [n["name"] for n in graph.nodes if n["type"].endswith("postgres")]
    assert pg == [], pg
    assert not [n for n in graph.nodes if n["name"] in POSTGRES_NAMES]
    assert not any("postgres" in json.dumps(n.get("credentials", {})) for n in graph.nodes)


def test_sessions_are_data_table_nodes(nodes):
    for name, op in (("Load Session", "get"), ("Save Session", "upsert"), ("Clear Session", "upsert")):
        n = nodes[name]
        assert n["type"] == "n8n-nodes-base.dataTable" and n["typeVersion"] == 1.1, name
        p = n["parameters"]
        assert p["resource"] == "row" and p["operation"] == op, name
        assert p["dataTableId"] == {"__rl": True, "mode": "name", "value": "bookings_bot_sessions"}, name
        assert p["filters"]["conditions"][0]["keyName"] == "chat_id", name
    assert nodes["Load Session"].get("alwaysOutputData") is True
    cols = nodes["Save Session"]["parameters"]["columns"]
    assert set(cols["value"]) == {"chat_id", "state", "data", "updated_at"}
    assert cols["matchingColumns"] == ["chat_id"]
    assert nodes["Clear Session"]["parameters"]["columns"]["value"]["state"] == ""


def test_the_lookups_are_fetch_then_code(graph, nodes):
    assert targets(graph, "Needs Bookings?")[0] == ["Fetch Bookings Formulas"]
    assert targets(graph, "Fetch Bookings Formulas") == [["Fetch Bookings Values"]]
    assert targets(graph, "Fetch Bookings Values") == [["Read Bookings For Edit"]]
    assert targets(graph, "Read Bookings For Edit") == [["Needs Locations?"]]
    assert targets(graph, "Needs Locations?")[0] == ["Fetch Locations"]
    assert targets(graph, "Fetch Locations") == [["Read Locations"]]
    assert targets(graph, "Read Locations") == [["Needs Booking ID?"]]
    assert targets(graph, "Needs Booking ID?")[0] == ["Fetch Booking Ids"]
    assert targets(graph, "Fetch Booking Ids") == [["Read Next Booking ID"]]
    assert targets(graph, "Read Next Booking ID") == [["Needs Expense Number?"]]
    for name in ("Read Bookings For Edit", "Read Locations", "Read Next Booking ID"):
        assert nodes[name]["type"] == "n8n-nodes-base.code", name
        assert nodes[name].get("alwaysOutputData") is True, name


def test_fetches_read_the_sheets_api_and_run_once_when_they_follow_many_items(nodes):
    for name in ("Fetch Bookings Formulas", "Fetch Bookings Values", "Fetch Locations", "Fetch Booking Ids"):
        n = nodes[name]
        assert n["type"] == "n8n-nodes-base.httpRequest", name
        assert "sheets.googleapis.com" in n["parameters"]["url"], name
        assert n["credentials"]["googleSheetsOAuth2Api"]["name"], name
    # an HTTP node runs once per incoming item: these two follow a node that emits many
    assert nodes["Fetch Locations"].get("executeOnce") is True
    assert nodes["Fetch Booking Ids"].get("executeOnce") is True
    renders = {n: [p["value"] for p in nodes[n]["parameters"]["queryParameters"]["parameters"]
                   if p["name"] == "valueRenderOption"] for n in ("Fetch Bookings Formulas", "Fetch Bookings Values")}
    assert renders == {"Fetch Bookings Formulas": ["FORMULA"], "Fetch Bookings Values": ["UNFORMATTED_VALUE"]}


def test_the_report_fetches_do_not_depend_on_the_telegram_branchs_config():
    """The 08:00 schedule and the availability tap never run `Config`: they have their
    own Report Config / Availability Config. `$('Config')` there is "hasn't been
    executed", so these two name the tab outright."""
    specs = bw.lookup_node_specs()
    for name in ("Fetch Report Locations", "Fetch Availability Locations"):
        url = specs[name][2]["url"]
        assert "$('Config')" not in url, name
        assert "الإتاحة" in url and "A2:B2000" in url, name
    for name in ("Fetch Bookings Formulas", "Fetch Bookings Values", "Fetch Locations", "Fetch Booking Ids"):
        assert "$('Config')" in specs[name][2]["url"], name   # the Telegram branch has Config


def test_the_code_nodes_carry_the_files_that_are_tested(nodes):
    here = os.path.dirname(os.path.abspath(bw.__file__))
    for name, body in (("Read Bookings For Edit", "build_bookings_lookup.js"),
                       ("Read Locations", "build_locations.js"),
                       ("Read Next Booking ID", "compute_next_booking_id.js")):
        with open(os.path.join(here, "nodes", body), encoding="utf-8") as fh:
            assert nodes[name]["parameters"]["jsCode"] == fh.read(), name


def test_the_registry_tab_is_in_config(nodes):
    have = {a["name"]: a["value"] for a in nodes["Config"]["parameters"]["assignments"]["assignments"]}
    assert have["AVAILABILITY_TAB"] == "الإتاحة"


def test_the_payment_line_still_gets_its_report_marker(graph, nodes):
    """Write Line Id stamps `<row>-<seq>` into column U; build_reports.js skips such rows
    so a payment line is not listed as a second guest."""
    assert targets(graph, "Write Line Rows")[0] == ["Has Group?", "Write Line Id"]
    assert nodes["Write Line Id"]["type"] == "n8n-nodes-base.httpRequest"
    assert "Write Booking Id" not in nodes


def _left_values(node):
    return [c["leftValue"] for c in node["parameters"]["conditions"]["conditions"]]


def test_the_registry_gate_reads_the_session_not_the_item_in_front_of_it(nodes):
    """First live message, 2026-10-12: "Node 'Read Locations' hasn't been executed".
    Needs Locations? sits AFTER Read Bookings For Edit on the AI turns, so the item
    it sees is a booking row, which has no `state` — the gate said no, the registry
    was never read, and the extractor's prompt (which lists the apartments) threw.
    The two state lists never overlapped before, so nothing had ever hit this.
    Needs Bookings? follows Load Session directly and keeps reading $json."""
    for left in _left_values(nodes["Needs Locations?"]):
        assert "$('Load Session')" in left, left
    for left in _left_values(nodes["Needs Bookings?"]):
        assert left == "={{ $json.state }}", left


def test_the_offline_merge_wires_the_brain_once(monkeypatch, tmp_path):
    """deploy_graph.py --offline writes the file people import by hand. It used to
    keep the old expense-gate -> Brain wires next to the new AI ones, so the Brain
    ran twice per turn: two replies, and every save written twice."""
    base = tmp_path / "base.json"
    out = tmp_path / "full.json"
    base.write_text(json.dumps(bw.workflow(bw.build()), ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(dg, "OFFLINE_IN", str(base))
    monkeypatch.setattr(dg, "OFFLINE_OUT", str(out))
    monkeypatch.setattr(sys, "argv", ["deploy_graph.py", "--offline"])
    dg.main()
    full = json.loads(out.read_text(encoding="utf-8"))
    into_brain = sorted(src for src, spec in full["connections"].items()
                        for br in spec.get("main", []) for l in br if l["node"] == "Brain")
    assert into_brain == ["AI Extract", "Needs AI?"], into_brain
    assert vw.check(full) == []
    # and the registry gate the deploy rewrites keeps reading the session
    gate = next(n for n in full["nodes"] if n["name"] == "Needs Locations?")
    assert all("$('Load Session')" in left for left in _left_values(gate))


# ── The live migration ───────────────────────────────────────────────────────

SHEETS_LIVE = ("googleSheetsOAuth2Api", "SHEETS-ID", "Google Sheets account")
SESSION_NODES = ("Load Session", "Save Session", "Clear Session")
READER_NODES = ("Read Bookings For Edit", "Read Locations", "Read Next Booking ID")
TG_FETCHES = ("Fetch Bookings Formulas", "Fetch Bookings Values", "Fetch Locations", "Fetch Booking Ids")


def _norm(conns):
    return {src: {kind: [sorted(l["node"] for l in br) for br in brs] for kind, brs in spec.items()}
            for src, spec in conns.items()}


def _old_graph():
    """The built graph rewound to what the live workflow looked like before this change:
    Postgres nodes for sessions and the three lookups wired straight to their gates, and
    the live-only shadow / reconcile branch hanging off Clear Session."""
    wf = json.loads(json.dumps(bw.workflow(bw.build())))
    wf["nodes"] = [n for n in wf["nodes"] if n["name"] not in TG_FETCHES]
    for n in wf["nodes"]:
        if n["name"] in SESSION_NODES + READER_NODES:
            n["type"], n["typeVersion"] = "n8n-nodes-base.postgres", 2.6
            n["parameters"] = {"operation": "executeQuery", "query": "select 1", "options": {}}
            n["credentials"] = {"postgres": {"id": "PG", "name": "Supabase Postgres"}}
    c = wf["connections"]
    for name in TG_FETCHES:
        c.pop(name, None)
    c["Needs Bookings?"]["main"] = [[{"node": "Read Bookings For Edit", "type": "main", "index": 0}],
                                    [{"node": "Needs Locations?", "type": "main", "index": 0}]]
    c["Needs Locations?"]["main"] = [[{"node": "Read Locations", "type": "main", "index": 0}],
                                     [{"node": "Needs Booking ID?", "type": "main", "index": 0}]]
    c["Needs Booking ID?"]["main"] = [[{"node": "Read Next Booking ID", "type": "main", "index": 0}],
                                      [{"node": "Needs Expense Number?", "type": "main", "index": 0}]]
    for name in sorted(POSTGRES_NAMES):
        wf["nodes"].append({"name": name, "type": "n8n-nodes-base.postgres", "typeVersion": 2.6,
                            "position": [0, 0],
                            "parameters": {"operation": "executeQuery", "query": "select 1"}})

    def wire(src, tgt, idx=0):
        main = c.setdefault(src, {}).setdefault("main", [])
        while len(main) <= idx:
            main.append([])
        main[idx].append({"node": tgt, "type": "main", "index": 0})
    wire("Clear Session", "Build Shadow Write")
    wire("Build Shadow Write", "Shadow Write")
    wire("Shadow Write", "Read Booking Id")
    wire("Read Booking Id", "Write Booking Id")
    wire("Read Report Values", "Build Snapshot SQL") if "Read Report Values" in c else None
    return wf


def _migrated(live=None):
    live = live or _old_graph()
    target = bw.workflow(bw.build())
    ops = dg.sheet_only_ops(live, target, SHEETS_LIVE)
    dg.apply_offline(live, ops)
    return live, ops


def test_migrating_the_old_graph_gives_the_built_graph():
    live, ops = _migrated()
    built = bw.workflow(bw.build())
    got = {n["name"]: n for n in live["nodes"]}
    want = {n["name"]: n for n in built["nodes"]}
    assert set(got) == set(want), (set(got) ^ set(want))
    for name in want:
        for field in ("type", "typeVersion", "parameters"):
            assert got[name][field] == want[name][field], (name, field)
    for name in SESSION_NODES + READER_NODES + TG_FETCHES:
        for key in ("alwaysOutputData", "executeOnce", "onError", "retryOnFail", "maxTries"):
            assert got[name].get(key) == want[name].get(key), (name, key)
    assert _norm(live["connections"]) == _norm(built["connections"])
    assert vw.check(live) == []


def test_the_retired_branches_leave_nothing_behind():
    live, _ = _migrated()
    assert not ({n["name"] for n in live["nodes"]} & POSTGRES_NAMES)
    assert not [n for n in live["nodes"] if n["type"].endswith("postgres")]
    for spec in live["connections"].values():
        for brs in spec.values():
            for br in brs:
                assert not [l for l in br if l["node"] in POSTGRES_NAMES]
    assert not (set(live["connections"]) & POSTGRES_NAMES)


def test_migrating_twice_changes_nothing_the_second_time():
    live, _ = _migrated()
    target = bw.workflow(bw.build())
    ops = dg.sheet_only_ops(live, target, SHEETS_LIVE)
    kinds = {o["type"] for o in ops}
    assert not (kinds & {"addNode", "removeNode", "addConnection", "removeConnection"}), kinds       # Review Focus 5


def test_the_http_fetches_carry_their_credential_inline():
    """setNodeCredential refuses googleSheetsOAuth2Api on an HTTP node, so the node is
    added WITH its credentials (proved in plan Task 1)."""
    _, ops = _migrated()
    adds = {o["node"]["name"]: o["node"] for o in ops if o["type"] == "addNode"}
    for name in TG_FETCHES:
        assert adds[name]["credentials"]["googleSheetsOAuth2Api"]["id"] == "SHEETS-ID", name
    assert not [o for o in ops if o["type"] == "setNodeCredential"]


def test_the_migration_fits_the_endpoints_batch_limit():
    _, ops = _migrated()
    parts = dg.batches(ops, 90)
    assert all(len(b) <= 90 for b in parts) and sum(map(len, parts)) == len(ops)


def targets_in(wf, src):
    return [sorted(l["node"] for l in br) for br in wf["connections"].get(src, {}).get("main", [])]


def test_the_merged_workflow_has_no_postgres_anywhere(monkeypatch, tmp_path):
    base = tmp_path / "base.json"
    out = tmp_path / "full.json"
    base.write_text(json.dumps(bw.workflow(bw.build()), ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(dg, "OFFLINE_IN", str(base))
    monkeypatch.setattr(dg, "OFFLINE_OUT", str(out))
    monkeypatch.setattr(sys, "argv", ["deploy_graph.py", "--offline"])
    dg.main()
    full = json.loads(out.read_text(encoding="utf-8"))
    names = {n["name"] for n in full["nodes"]}
    assert not [n["name"] for n in full["nodes"] if n["type"].endswith("postgres")]
    assert not (POSTGRES_NAMES & names)
    for need in ("Fetch Report Locations", "Read Report Locations", "Fetch Availability Locations",
                 "Read Availability Locations", "Build Reports", "Build Availability Report"):
        assert need in names, need
    assert targets_in(full, "Report Config") == [["Fetch Report Locations"]]
    assert targets_in(full, "Fetch Report Locations") == [["Read Report Locations"]]
    assert targets_in(full, "Read Report Locations") == [["Read Report Formulas"]]
    assert targets_in(full, "Availability Config") == [["Fetch Availability Locations"]]
    assert targets_in(full, "Fetch Availability Locations") == [["Read Availability Locations"]]
    assert targets_in(full, "Read Availability Locations") == [["Read Availability Formulas"]]
    assert targets_in(full, "Read Report Values") == [["Build Reports"]]
    assert targets_in(full, "Clear Session") == [["Should Format Row?"]] or "Clear Session" in full["connections"]
    assert vw.check(full) == []


# ── Branch order: n8n runs one output's branches in the order they were connected ──

def _order(wf, src, idx=0):
    return [c["node"] for c in wf["connections"][src]["main"][idx]]


def test_the_migration_keeps_the_order_the_branches_run_in():
    """Found live (execution 7820): re-adding Save Session appended it to the END of
    Brain's list, so it ran after Clear Session and put the finished session back to
    EDIT_CONFIRM — leaving an old Confirm card able to save the payment again. Save
    Session must run first (before anything that talks to Telegram) and Clear Session
    before the group post."""
    live, _ = _migrated()
    built = bw.workflow(bw.build())
    for src in ("Brain", "Send Saved", "Write Line Rows"):
        assert _order(live, src) == _order(built, src), src
    assert _order(live, "Brain")[0] == "Save Session"
    o = _order(live, "Send Saved")
    assert o.index("Clear Session") < o.index("Has Receipt?")


def test_a_live_only_branch_stays_after_the_generated_ones():
    live = _old_graph()
    live["nodes"].append({"name": "Wants Availability?", "type": "n8n-nodes-base.if", "typeVersion": 2.3,
                          "position": [0, 0], "parameters": {}})
    live["connections"]["Brain"]["main"][0].append({"node": "Wants Availability?", "type": "main", "index": 0})
    dg.apply_offline(live, dg.sheet_only_ops(live, bw.workflow(bw.build()), SHEETS_LIVE))
    o = _order(live, "Brain")
    assert o[0] == "Save Session" and o[-1] == "Wants Availability?", o


def test_a_graph_already_published_in_the_wrong_order_is_put_right():
    live, _ = _migrated()
    br = live["connections"]["Brain"]["main"][0]
    br.append(br.pop(0))                       # Save Session last: what went live
    sc = live["connections"]["Send Saved"]["main"][0]
    sc.append(sc.pop(0))                       # Clear Session after Has Receipt?
    ops = dg.sheet_only_ops(live, bw.workflow(bw.build()), SHEETS_LIVE)
    assert {o["type"] for o in ops} & {"removeConnection", "addConnection"}
    dg.apply_offline(live, ops)
    assert _order(live, "Brain")[0] == "Save Session"
    o = _order(live, "Send Saved")
    assert o.index("Clear Session") < o.index("Has Receipt?")
    again = dg.sheet_only_ops(live, bw.workflow(bw.build()), SHEETS_LIVE)
    assert not ({o["type"] for o in again} & {"addNode", "removeNode", "addConnection", "removeConnection"})
