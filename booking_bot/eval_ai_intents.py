"""Does the model read real staff phrasing the way brain.js expects?

The offline suite mocks the model, so it cannot tell. This sends each case in
ai_eval_cases.json to the Anthropic API exactly as the n8n node does (a forced
tool call whose input schema is ai_intent.SCHEMA) and compares the answer.

    ANTHROPIC_API_KEY=sk-ant-... python booking_bot/eval_ai_intents.py
    ANTHROPIC_API_KEY=... python booking_bot/eval_ai_intents.py --model claude-sonnet-5-5

Add the phrases your staff really type to ai_eval_cases.json. A case passes when
every key in `want` matches; `null` means "must be absent", and "*" means
"present and non-empty". Keys not named in `want` are not checked.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ai_intent

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
EVAL_TODAY = "2026-10-12"
APARTMENTS = ["ذاكر حسين", "احمد فهيم", "انبي 3", "انبي 2", "ابو حديد 11", "عبدالله العربي"]
URL = "https://api.anthropic.com/v1/messages"


def ask(model, text, key):
    body = {
        "model": model,
        "max_tokens": 300,
        "system": ai_intent.render_prompt(EVAL_TODAY, APARTMENTS),
        "tools": [{"name": "extract", "description": "Record the edit request.",
                   "input_schema": ai_intent.SCHEMA}],
        "tool_choice": {"type": "tool", "name": "extract"},
        "messages": [{"role": "user", "content": text}],
    }
    req = urllib.request.Request(
        URL, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as err:
        sys.exit(f"HTTP {err.code}: {err.read().decode('utf-8', 'replace')[:400]}")
    for block in data.get("content", []):
        if block.get("type") == "tool_use":
            return block["input"]
    return {}


def matches(got, want):
    for k, v in want.items():
        have = got.get(k)
        if v is None:
            if have:
                return False
        elif v == "*":
            if not have:
                return False
        elif isinstance(v, dict):
            if not isinstance(have, dict) or not matches(have, v):
                return False
        elif have != v:
            return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=ai_intent.MODEL)
    args = ap.parse_args()
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("set ANTHROPIC_API_KEY")
    with open(os.path.join(HERE, "ai_eval_cases.json"), encoding="utf-8") as fh:
        cases = json.load(fh)

    failed = 0
    for case in cases:
        got = ask(args.model, case["text"], key)
        ok = matches(got, case["want"])
        failed += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {case['text']}")
        if not ok:
            print(f"       want {json.dumps(case['want'], ensure_ascii=False)}")
            print(f"       got  {json.dumps(got, ensure_ascii=False)}")
    print(f"\n{len(cases) - failed}/{len(cases)} read as expected ({args.model})")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
