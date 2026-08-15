"""
Snapshot everything that cannot be regenerated, before a risky change.

    python supabase/backup.py              # sheet + database + workflow
    python supabase/backup.py --no-n8n     # skip the workflow (n8n unreachable)

Writes to `backups/<UTC timestamp>/`, which is git-ignored and must stay that
way: the workflow JSON carries BOT_TOKEN in its Config node, and the sheet and
database carry guests' names and phone numbers.

Three things are captured, because the three fail differently:

  * **the spreadsheet** — every tab, twice. Once with formulas (FORMULA) and
    once with what they evaluate to (UNFORMATTED_VALUE). A backup of values
    alone cannot restore K, N, P, R, S or T, which are fill-down formulas; a
    backup of formulas alone cannot tell you what the numbers were. This is the
    only copy of the tabs nothing else mirrors.
  * **the database** — every table in `public`, as rows of JSON. Small enough to
    be exact rather than clever.
  * **the live workflow** — n8n keeps version history of its own, but only for
    the workflow. If the instance is lost again, as it was on 2026-08-14, that
    history goes with it.

Restoring is deliberately NOT automated. Every incident so far has been
something writing to the wrong row without being asked, and a one-command
restore is that same gun pointed at the whole sheet.
"""

import argparse
import datetime as dt
import json
import os
import sys

import psycopg

# The tab names are Arabic. A Windows console defaults to a codepage that cannot
# encode them, and the run would die printing the name of the tab it just backed
# up successfully.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from backfill import connect_args, open_sheet   # noqa: E402  (needs sys.path)

OUT_ROOT = os.path.join(REPO, "backups")


def write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1, default=str)
    return os.path.getsize(path)


def dump_sheet(outdir):
    sh = open_sheet()
    tabs = {}
    for ws in sh.worksheets():
        # A1 notation with no range means the whole used grid. Asking for both
        # renderings costs two API calls per tab and is the entire point.
        formulas = ws.get(value_render_option="FORMULA")
        values = ws.get(value_render_option="UNFORMATTED_VALUE")
        tabs[ws.title] = {"id": ws.id, "rows": len(values),
                          "formulas": formulas, "values": values}
        print(f"  tab {ws.title!r}: {len(values)} rows")
    size = write(os.path.join(outdir, "sheet.json"), tabs)
    print(f"  -> sheet.json ({size:,} bytes, {len(tabs)} tabs)")


def dump_database(outdir):
    out = {}
    with psycopg.connect(**connect_args()) as conn, conn.cursor() as cur:
        cur.execute("select table_name from information_schema.tables"
                    " where table_schema = 'public' and table_type = 'BASE TABLE'"
                    " order by table_name;")
        names = [r[0] for r in cur.fetchall()]
        for name in names:
            # The table name comes from information_schema, not from a caller,
            # and psycopg will not parameterise an identifier anyway.
            cur.execute(f'select * from public."{name}";')
            cols = [d.name for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
            out[name] = rows
            print(f"  table {name}: {len(rows)} rows")
    size = write(os.path.join(outdir, "database.json"), out)
    print(f"  -> database.json ({size:,} bytes, {len(out)} tables)")


def dump_workflow(outdir):
    sys.path.insert(0, os.path.join(REPO, "booking_bot"))
    import push_brain as pb

    pb.require_workflow_id()
    pb.select_server()
    detail = json.loads(pb.call_tool("get_workflow_details",
                                     {"workflowId": pb.WORKFLOW_ID}))
    wf = detail["workflow"]
    size = write(os.path.join(outdir, "workflow.json"), detail)
    print(f"  -> workflow.json ({size:,} bytes, {len(wf['nodes'])} nodes, "
          f"active={wf['active']})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-n8n", action="store_true",
                    help="skip the workflow, for when the instance is unreachable")
    args = ap.parse_args()

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    outdir = os.path.join(OUT_ROOT, stamp)
    os.makedirs(outdir, exist_ok=True)
    print(f"backup -> backups/{stamp}/")

    print("spreadsheet:")
    dump_sheet(outdir)
    print("database:")
    dump_database(outdir)
    if args.no_n8n:
        print("workflow: skipped")
    else:
        print("workflow:")
        dump_workflow(outdir)

    print(f"\ndone: {outdir}")


if __name__ == "__main__":
    main()
