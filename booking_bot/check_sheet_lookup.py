"""Read-only: what the bookings lookup makes of the LIVE tab.

    python booking_bot/check_sheet_lookup.py                 # summary
    python booking_bot/check_sheet_lookup.py --rows 36-42    # the rows themselves

Uses service_account.json (readonly scope) and the real node body, so what it prints
is what the bot will see. Nothing is written anywhere. The key lives in the main
checkout, not in a worktree: set HOSTEL_REPO to that directory if this is run from one.
"""
import argparse
import json
import os
import re
import subprocess
import sys

import gspread
from google.oauth2.service_account import Credentials

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
SHEET_ID = "1CiHciOeeyRMx9vz5cP0Xlid-jqM_gVjW3sUfore84S8"
TAB = "إدخال الحجوزات"
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def key_file():
    for base in (os.environ.get("HOSTEL_REPO", ""), os.path.dirname(HERE)):
        p = os.path.join(base, "service_account.json") if base else ""
        if p and os.path.exists(p):
            return p
    sys.exit("service_account.json not found (set HOSTEL_REPO to the main checkout)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", help="e.g. 36-42")
    args = ap.parse_args()
    creds = Credentials.from_service_account_file(
        key_file(), scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    ws = gspread.authorize(creds).open_by_key(SHEET_ID).worksheet(TAB)
    formulas = ws.get("A1:U2000", value_render_option="FORMULA")
    values = ws.get("A1:U2000", value_render_option="UNFORMATTED_VALUE")
    payload = json.dumps({"formulas": {"values": formulas}, "values": {"values": values}},
                         ensure_ascii=False)
    out = subprocess.run(["node", os.path.join(HERE, "lookup_cli.mjs")],
                         input=payload.encode("utf-8"), capture_output=True, check=True)
    rows = json.loads(out.stdout.decode("utf-8"))
    print(f"sheet rows read: {len(formulas)} | bookings: {len(rows)} | with payment lines: "
          f"{sum(1 for r in rows if r['lines'])} | open-ended: "
          f"{sum(1 for r in rows if r['عدد الليالي'] == '=OPEN')} | rate formulas: "
          f"{sum(1 for r in rows if r['total_is_formula'])}")
    bad = [r["row_number"] for r in rows if r["تاريخ البداية"] and not ISO.match(r["تاريخ البداية"])]
    print("rows whose arrival is not an ISO date:", bad or "none")
    print("blank ids at rows:", [r["row_number"] for r in rows if r["ID"] == ""] or "none",
          "| starred ids:", [r["ID"] for r in rows if "*" in r["ID"]] or "none")
    if args.rows:
        lo, hi = map(int, args.rows.split("-"))
        keys = ("row_number", "ID", "اسم المقيم", "اسم الشقة", "رقم الغرفة", "عدد الليالي",
                "تاريخ البداية", "اجمالي سعر الحجز", "اجمالي ما تم دفعه", "طريقة الدفع",
                "lines", "block_end")
        for r in rows:
            if lo <= r["row_number"] <= hi:
                print(json.dumps({k: r[k] for k in keys}, ensure_ascii=False))


if __name__ == "__main__":
    main()
