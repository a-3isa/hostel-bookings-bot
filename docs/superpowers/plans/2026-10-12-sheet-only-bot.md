# Sheet-only bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Telegram bot no longer touches Postgres: it reads the sheet in the turn it writes it, keeps its sessions in an n8n Data Table, and stops mirroring.

**Architecture:** `Brain` is unchanged. New Code nodes turn Sheets-API `values.get` responses into the rows the old SQL returned (bookings with their payment lines, the apartment/room registry, the next booking ID). Session nodes become Data Table nodes. The mirror and reconcile nodes are removed. The generator builds the new base graph; `deploy_graph.py` migrates the live workflow (draft first, verified, then published once).

**Tech Stack:** Python (generators, pytest), Node (offline tests), n8n Code / HTTP Request / Data Table nodes, Google Sheets API v4.

**Spec:** `docs/superpowers/specs/2026-10-12-sheet-only-bot-design.md`

## Global Constraints

- `brain.js` is not edited (Task 8 only updates its comments if a test needs it). The existing `node booking_bot/test_brain.mjs` suite must stay green throughout (baseline: 630 checks).
- Lookups read the Sheets **API** with HTTP Request nodes (`values.get`), never the Sheets node: a row's number is its array index + 1 (row 1 is the header). Reasoning is in `values_get`'s docstring.
- Every HTTP fetch that follows a node emitting more than one item is `executeOnce` (`Fetch Locations`, `Fetch Booking Ids`, `Fetch Report Locations`, `Fetch Availability Locations`). Every lookup Code node has `alwaysOutputData: true`, so an empty or failed read still lets the Brain run.
- A **line** is a row directly under a booking's block with the same `ID`, `اسم المقيم`, `اسم الشقة`, `رقم الغرفة` and arrival, a blank `اجمالي سعر الحجز`, and a filled paid or method cell. Those five identity columns must stay a subset of `LINE_IDENTITY_COLS` in `brain.js` (a test pins it).
- Lookup row shape (what `brain.js` already reads): the sheet's Arabic headers, plus `row_number`, `booking_id` (= the row number), `lines: [{seq, row, method, amount}]` (`seq` from 2), `block_end`, `total_is_formula`. Open-ended nights are the string `'=OPEN'`. Dates are `YYYY-MM-DD`. `ID` is text.
- The sheet's formula columns `K, N, P, R, S, T` are never written; column `U` (معرف النظام) is no longer written or read.
- The graph is generated. Never edit the workflow in the n8n editor.
- Nothing in Postgres, `supabase/` or `webui/` is deleted. Retire them in docs only.
- Shell is Git Bash; keep commands plain and separate (worktree isolation refuses compound git commands). Read files in chunks of at most 200 lines. A hook creates empty junk files named after JS fragments in the worktree root: never `git add -A`; run `git clean -n` and remove them with `git clean -f` before the final review.
- Commit messages end with exactly this line (no other trailer):
  ```
  Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
  ```
- Baseline before starting: `node booking_bot/test_brain.mjs` → `all checks passed` (630 `ok`); `python -m pytest booking_bot -q` → 37 passed.
- Live workflow id `hzMYegbL3yifl7KN`; pass it as `N8N_WORKFLOW_ID=hzMYegbL3yifl7KN` (the worktree has no `.workflow_id`). Active version before this work: `4555ef7a-38f1-4d4e-a1dc-f71038a6d6f8` (the rollback target).

## Review Focus

Failure modes the spec implies but the tasks' main tests would not catch. Each is pinned by a test in the task named.

1. **A lookup that returns nothing must not stop the bot.** An empty tab, a failed read, or a response with no `values` still has to emit one item so the gates and `Brain` run. Task 2/3 (Code nodes) and Task 4 (`alwaysOutputData`).
2. **A booking whose block has a gap.** Two rows with the same identity that are not adjacent are two bookings, not a booking and a line. Task 2.
3. **Dates in either form.** Serial numbers (46301) and text (`2026-10-06`, `6/10/2026`) must both become `YYYY-MM-DD`; a wrong date silently breaks clash checks. Task 2.
4. **Sessions that "save" but do not persist.** The reason this store was abandoned in August. Task 1 proves it against the real node before anything is wired.
5. **The migration run twice.** `deploy_graph.py` must be idempotent on the migrated workflow: second run adds and removes nothing. Task 5.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `booking_bot/nodes/build_bookings_lookup.js` | create | `Read Bookings For Edit`: bookings + lines from two `values.get` responses. |
| `booking_bot/nodes/build_locations.js` | create | The three registry nodes: `{الشقة, الغرفة}` rows from `A2:B`. |
| `booking_bot/nodes/compute_next_booking_id.js` | create | `Read Next Booking ID`: highest plain counter + 1. |
| `booking_bot/test_sheet_lookup.mjs` | create | Offline tests for the three Code nodes, on fixtures from the real tab. |
| `booking_bot/lookup_cli.mjs`, `booking_bot/check_sheet_lookup.py` | create | Read-only parity check against the live tab. |
| `booking_bot/build_workflow.py` | modify | Data Table session nodes, the fetch + Code lookups, `AVAILABILITY_TAB`, no Postgres, no `Write Line Id`. |
| `booking_bot/deploy_graph.py` | modify | Reports/availability registry reads, no shadow/reconcile blocks, the live migration (`sheet_only_ops`), batching, `removeNode` offline. |
| `booking_bot/test_workflow.py`, `validate_workflow.py` | modify | No-Postgres and wiring tests. |
| retired files | delete | `nodes/build_shadow_write.js`, `build_snapshot_sql.js`, `build_reconcile_message.js`, `read_unmirrored.sql`, `read_bookings_for_edit.sql`, `read_locations.sql`, `read_next_booking_id.sql`, `test_shadow.mjs`, `test_reconcile.mjs`. |
| `README.md`, `booking_bot/README.md`, `docs/HANDOFF.md`, `booking_bot/sync_nodes.py`, `supabase/README.md`, `webui/README.md` | modify | Document the change; mark the database retired. |

---

### Task 1: Prove the two MCP-level assumptions on a scratch workflow

**Why first:** sessions on a Data Table "looked up cleanly and wrote nothing" in August, and the repo says an HTTP node cannot be bound to the Google credential over MCP. Both are cheap to test and fatal to discover late.

**Files:** none in the repo. Evidence goes into the ledger.

**Interfaces:**
- Produces: the proven Data Table parameter shapes for `get` and `upsert` (used verbatim by Task 4 / Task 5), and a yes/no on "an `addNode` op with an inline `credentials` object authenticates an HTTP node to Google Sheets".

- [ ] **Step 1: Read the SDK reference and create a scratch workflow**

Call `get_workflow_sdk_reference` (section `patterns` is enough), then `validate_workflow` and `create_workflow_from_code` for a workflow named `SCRATCH sheet-only proof (delete me)` containing only a Manual Trigger named `Start`.

- [ ] **Step 2: Look up the live Google credential and the delete operation**

Run `list_credentials` (type `google`) and note the id and name of `Google Sheets account` that the live workflow uses:

```bash
N8N_WORKFLOW_ID=hzMYegbL3yifl7KN python -c "import sys,json; sys.path.insert(0,'booking_bot'); import push_brain as pb; pb.select_server(); wf=json.loads(pb.call_tool('get_workflow_details',{'workflowId':pb.WORKFLOW_ID}))['workflow']; print([n['credentials']['googleSheetsOAuth2Api'] for n in wf['nodes'] if (n.get('credentials') or {}).get('googleSheetsOAuth2Api')][:1])"
```

Call `get_node_types` for `{nodeId: "n8n-nodes-base.dataTable", resource: "row", operation: "deleteRows"}` to learn its filter shape.

- [ ] **Step 3: Add the probe nodes with one `update_workflow` call**

Operations (all `addNode` unless stated; positions arbitrary), each node's `parameters` exactly as the generator will emit them in Task 4:

1. `Probe A` — `n8n-nodes-base.code` v2: `return [{ json: { chatId: '__probe__', sessionState: 'CHOICE', sessionData: JSON.stringify({ a: 1, b: 'عربي', c: [1, 2, 3] }) } }];`
2. `Probe Upsert A` — `n8n-nodes-base.dataTable` v1.1:
```json
{"resource": "row", "operation": "upsert",
 "dataTableId": {"__rl": true, "mode": "name", "value": "bookings_bot_sessions"},
 "matchType": "allConditions",
 "filters": {"conditions": [{"keyName": "chat_id", "condition": "eq", "keyValue": "={{ $json.chatId }}"}]},
 "columns": {"mappingMode": "defineBelow",
   "value": {"chat_id": "={{ $json.chatId }}", "state": "={{ $json.sessionState }}",
             "data": "={{ $json.sessionData }}", "updated_at": "={{ Date.now() }}"},
   "matchingColumns": ["chat_id"],
   "schema": [
     {"id": "chat_id", "displayName": "chat_id", "required": false, "defaultMatch": false, "display": true, "type": "string", "canBeUsedToMatch": true},
     {"id": "state", "displayName": "state", "required": false, "defaultMatch": false, "display": true, "type": "string", "canBeUsedToMatch": true},
     {"id": "data", "displayName": "data", "required": false, "defaultMatch": false, "display": true, "type": "string", "canBeUsedToMatch": true},
     {"id": "updated_at", "displayName": "updated_at", "required": false, "defaultMatch": false, "display": true, "type": "number", "canBeUsedToMatch": true}]}}
```
3. `Probe Get A` — `n8n-nodes-base.dataTable` v1.1, `settings.alwaysOutputData: true`:
```json
{"resource": "row", "operation": "get",
 "dataTableId": {"__rl": true, "mode": "name", "value": "bookings_bot_sessions"},
 "matchType": "allConditions",
 "filters": {"conditions": [{"keyName": "chat_id", "condition": "eq", "keyValue": "__probe__"}]},
 "returnAll": false, "limit": 1}
```
4. `Probe B` — Code: same as `Probe A` but `sessionState: 'EDIT_MENU'` and `sessionData: '{}'`.
5. `Probe Upsert B` — a copy of `Probe Upsert A`.
6. `Probe Get B` — a copy of `Probe Get A`.
7. `Probe Delete` — `dataTable` v1.1, `operation: "deleteRows"` with the filter `chat_id eq __probe__` in the shape step 2 returned.
8. `Probe Sheets` — `n8n-nodes-base.httpRequest` v4.2, **with the credential inline in the node object**:
```json
{"parameters": {"method": "GET",
   "url": "=https://sheets.googleapis.com/v4/spreadsheets/1CiHciOeeyRMx9vz5cP0Xlid-jqM_gVjW3sUfore84S8/values/{{ encodeURIComponent('الإتاحة!A2:B6') }}",
   "authentication": "predefinedCredentialType", "nodeCredentialType": "googleSheetsOAuth2Api",
   "sendQuery": true, "queryParameters": {"parameters": [{"name": "valueRenderOption", "value": "UNFORMATTED_VALUE"}]},
   "options": {"timeout": 15000}},
 "credentials": {"googleSheetsOAuth2Api": {"id": "<id from step 2>", "name": "<name from step 2>"}}}
```
Connections, in order: `Start → Probe A → Probe Upsert A → Probe Get A → Probe B → Probe Upsert B → Probe Get B → Probe Delete → Probe Sheets`.

- [ ] **Step 4: Run it and read the result**

`execute_workflow` with `executionMode: "manual"`, then `get_workflow_execution` with `includeData: true` and `nodeNames: ["Probe Get A", "Probe Get B", "Probe Delete", "Probe Sheets"]`.

Expected:
- `Probe Get A` returns one row: `state: "CHOICE"`, `data` equal to the JSON string, `updated_at` a number, **and** `get_data_table_rows` (table id from `search_data_tables`, filter `chat_id eq __probe__`) agrees. This is the check that the August bug is not back: the row exists in the table, not just in the node's output.
- `Probe Get B` returns **one** row (not two) with `state: "EDIT_MENU"` and `data: "{}"`.
- After `Probe Delete`, `get_data_table_rows` for `__probe__` returns no rows.
- `Probe Sheets` returns `values` with the registry rows (`['الشقة','الغرفة']`, …), proving the inline credential works.

- [ ] **Step 5: Decide, then clean up**

Archive the scratch workflow (`archive_workflow`). Ledger the outcome:
- Both pass → `Task 1: complete — Data Table upsert/get persist; HTTP + inline credential authenticates`. Tasks 4-5 use the shapes above unchanged.
- Data Table fails (no row in the table, or two rows) → change one thing at a time (add or drop `schema`, `mode: "id"`, `matchType`) and re-run; if no shape persists, `Ruling: sessions stay on Postgres` and **skip** the session parts of Tasks 4 and 5 (marked "if sessions move"). Everything else ships.
- HTTP credential fails → `Ruling: lookups use the Google Sheets node (getAll, header row 1, row_number)`; Task 2's `sheetRows()` already accepts that shape (Step 3 there), and Task 4 emits Sheets nodes instead of HTTP nodes.

No commit for the proof itself (nothing changes in the repo).

**Result (2026-10-12, scratch workflow `Le9zDCUgDaVWxeDE`, executions 7810-7811, archived): both pass.**
- Data Table: `upsert` inserted the row; `get` read it back; a second `upsert` updated the same row (id 2, still one row); `get_data_table_rows` agreed after each step. Arabic JSON in `data` round-trips. An upsert with `state: ""` and `data: "{}"` persists (the `Clear Session` shape). `deleteRows` (operation name is `deleteRows`, not `delete_rows`) removed it. `get` for a missing row with `alwaysOutputData` emits one empty item `{}`.
- HTTP + inline credential: an `addNode` op carrying `credentials: {googleSheetsOAuth2Api: {id: qXOwEKyHdq2gJy6B, name: "Google Sheets account"}}` authenticated to the Sheets API and returned the registry (`['الشقة','الغرفة']`, `['التاريخ']`, then rooms with the room as a **number**, so `build_locations.js` must stringify it, which it does). The tool's note that HTTP nodes "must be configured manually" refers to auto-assignment only; the inline credential survives.

---

### Task 2: `Read Bookings For Edit`, from the sheet

**Files:**
- Create: `booking_bot/nodes/build_bookings_lookup.js`
- Create: `booking_bot/test_sheet_lookup.mjs`

**Interfaces:**
- Consumes: `$('Fetch Bookings Formulas')` and `$('Fetch Bookings Values')` — each item's `json` is a `values.get` response `{ values: [[headers…], [row 2…], …] }` (formula render and unformatted-value render of `A1:U2000`).
- Produces: items whose `json` is the lookup row shape in Global Constraints. Exports the helper `sheetRows()` shape reused by Task 3 (copied, not imported — Code nodes are standalone).

- [ ] **Step 1: Write the failing tests**

Create `booking_bot/test_sheet_lookup.mjs`:

```js
/**
 * Offline tests for the three lookup Code nodes that replaced the Postgres reads.
 *
 *     node booking_bot/test_sheet_lookup.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (name) => readFileSync(join(HERE, 'nodes', name), 'utf8');
const brainSrc = readFileSync(join(HERE, 'brain.js'), 'utf8');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ''}`); }
}
function section(name) { console.log(`\n${name}`); }

// The real header row of إدخال الحجوزات (A..W).
const HEADERS = ['بوكنج ID', 'ID', 'اسم المقيم', 'نوع الحجز', 'الجنسية', 'رقم الهاتف', 'اسم الشقة',
  'رقم الغرفة', 'عدد الليالي', 'تاريخ البداية', 'تاريخ المغادرة', 'اجمالي سعر الحجز',
  'اجمالي ما تم دفعه', 'نسبة البرنامج', 'طريقة الدفع', 'المتبقي', 'ملاحظات', 'تاريخ الإدخال',
  'صافي الدخل', 'آخر تعديل', 'معرف النظام', 'data', 'rows'];

/** A sheet row as the API returns it: cells in header order, trailing blanks trimmed. */
function cells(obj) {
  const row = HEADERS.map(h => (obj[h] === undefined ? '' : obj[h]));
  while (row.length && row[row.length - 1] === '') row.pop();
  return row;
}
/** values.get body for `{ sheetRow: {header: value} }`; interior blank rows are []. */
function sheet(rows) {
  const last = Math.max(1, ...Object.keys(rows).map(Number));
  const values = [HEADERS];
  for (let r = 2; r <= last; r++) values.push(rows[r] ? cells(rows[r]) : []);
  return { range: "'إدخال الحجوزات'!A1:U2000", majorDimension: 'ROWS', values };
}

function runLookup(formulaRows, valueRows = formulaRows) {
  const fn = new Function('$', src('build_bookings_lookup.js'));
  const $ = (name) => {
    const body = name === 'Fetch Bookings Formulas' ? sheet(formulaRows)
      : name === 'Fetch Bookings Values' ? sheet(valueRows) : null;
    if (!body) throw new Error(`unexpected node ${name}`);
    return { first: () => ({ json: body }), all: () => [{ json: body }] };
  };
  return fn($).map(i => i.json);
}

// Serial 46301 = 2026-10-06 (days since 1899-12-30).
const SERIAL = { '2026-10-05': 46300, '2026-10-06': 46301, '2026-10-09': 46304 };

const R36 = { 'ID': 25, 'اسم المقيم': 'تبع عمر البيه', 'نوع الحجز': 'بوكينج', 'رقم الهاتف': '+20 10 11111111',
  'اسم الشقة': 'ذاكر حسين', 'رقم الغرفة': 3, 'عدد الليالي': 30, 'تاريخ البداية': SERIAL['2026-10-05'],
  'اجمالي سعر الحجز': 10000, 'اجمالي ما تم دفعه': 0, 'طريقة الدفع': 'غير مدفوع', 'المتبقي': 10000, 'معرف النظام': '2338' };
// Rows 37-39 as they really are: three different stays that all carry system id 2340.
const R37 = { 'ID': 26, 'اسم المقيم': 'سيف الدين حسام', 'اسم الشقة': 'ذاكر حسين', 'رقم الغرفة': 4, 'عدد الليالي': 1,
  'تاريخ البداية': SERIAL['2026-10-05'], 'اجمالي سعر الحجز': 1050, 'اجمالي ما تم دفعه': 1050, 'طريقة الدفع': 'انستاباي', 'معرف النظام': '2340' };
const R38 = { 'ID': 27, 'اسم المقيم': 'محمد طاهر', 'اسم الشقة': 'عبدالله العربي', 'رقم الغرفة': 3, 'عدد الليالي': 2,
  'تاريخ البداية': SERIAL['2026-10-06'], 'اجمالي سعر الحجز': 1400, 'اجمالي ما تم دفعه': 1400, 'طريقة الدفع': 'انستاباي', 'معرف النظام': '2340' };
const R39 = { 'ID': 27, 'اسم المقيم': 'محمد طاهر', 'اسم الشقة': 'عبدالله العربي', 'رقم الغرفة': 3, 'عدد الليالي': 2,
  'تاريخ البداية': SERIAL['2026-10-09'], 'اجمالي سعر الحجز': 700, 'اجمالي ما تم دفعه': 700, 'طريقة الدفع': 'فودافون كاش', 'معرف النظام': '2340' };

section('lookup: one booking, in the shape the Brain reads');
let rows = runLookup({ 36: R36 });
check('one booking', rows.length === 1, rows.length);
const b = rows[0];
check('its sheet row is the array position + 1', b.row_number === 36 && b.booking_id === 36, [b.row_number, b.booking_id]);
check('the Arabic headers carry the values', b['اسم المقيم'] === 'تبع عمر البيه' && b['اسم الشقة'] === 'ذاكر حسين'
  && b['رقم الغرفة'] === 3 && b['طريقة الدفع'] === 'غير مدفوع', b);
check('ID is text', b['ID'] === '25', b['ID']);
check('money stays a number', b['اجمالي سعر الحجز'] === 10000 && b['اجمالي ما تم دفعه'] === 0, b);
check('the arrival serial is an ISO date', b['تاريخ البداية'] === '2026-10-05', b['تاريخ البداية']);
check('no lines, block ends on its own row', Array.isArray(b.lines) && b.lines.length === 0 && b.block_end === 36, [b.lines, b.block_end]);
check('a plain total is not a formula', b.total_is_formula === false);

section('lookup: rows 37-39 (one system id, three stays) are three bookings, not a booking and two lines');
rows = runLookup({ 37: R37, 38: R38, 39: R39 });
check('three bookings', rows.length === 3, rows.map(r => r.row_number));
check('the same guest on a later arrival is its own booking', rows[2].row_number === 39 && rows[2].lines.length === 0, rows[2]);
check('in row order', rows.map(r => r.row_number).join() === '37,38,39');

section('lookup: a payment line belongs to the booking above it');
const LINE_IDENTITY = ['بوكنج ID', 'ID', 'اسم المقيم', 'نوع الحجز', 'رقم الهاتف', 'اسم الشقة', 'رقم الغرفة', 'تاريخ البداية', 'ملاحظات'];
const brainIdentity = [...brainSrc.match(/const LINE_IDENTITY_COLS = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
check('the identity columns the writer copies are the ones this test copies', brainIdentity.join() === LINE_IDENTITY.join(), brainIdentity);
const lineOf = (booking, extra) => {
  const line = {};
  for (const h of LINE_IDENTITY) if (booking[h] !== undefined && booking[h] !== '') line[h] = booking[h];
  return { ...line, 'عدد الليالي': booking['عدد الليالي'], 'اجمالي سعر الحجز': '', ...extra };
};
rows = runLookup({ 50: R38, 51: lineOf(R38, { 'اجمالي ما تم دفعه': 700, 'طريقة الدفع': 'فودافون كاش' }), 52: R39 });
check('two bookings; the line is not one', rows.length === 2 && rows[0].row_number === 50 && rows[1].row_number === 52, rows.map(r => r.row_number));
check('the line is on the booking: seq 2, its row, method and amount',
  JSON.stringify(rows[0].lines) === JSON.stringify([{ seq: 2, row: 51, method: 'فودافون كاش', amount: 700 }]), rows[0].lines);
check('the block ends on the line, so the next payment line goes under it', rows[0].block_end === 51, rows[0].block_end);
rows = runLookup({ 50: R38, 51: lineOf(R38, { 'اجمالي ما تم دفعه': 700, 'طريقة الدفع': 'كاش' }),
  52: lineOf(R38, { 'اجمالي ما تم دفعه': 100, 'طريقة الدفع': 'دولار' }) });
check('two lines are seq 2 and 3', rows[0].lines.map(l => l.seq).join() === '2,3' && rows[0].block_end === 52, rows[0].lines);

section('lookup: what is NOT a line');
rows = runLookup({ 50: R38, 52: lineOf(R38, { 'اجمالي ما تم دفعه': 700, 'طريقة الدفع': 'كاش' }) });          // Review Focus 2
check('the same identity two rows down (a blank row between) is a second booking', rows.length === 2 && rows[0].lines.length === 0, rows);
rows = runLookup({ 50: R37, 51: lineOf(R38, { 'اجمالي ما تم دفعه': 700, 'طريقة الدفع': 'كاش' }) });
check('a line-shaped row under a different guest is its own booking', rows.length === 2, rows.map(r => r.row_number));
rows = runLookup({ 50: R38, 51: { ...lineOf(R38, { 'اجمالي ما تم دفعه': 700, 'طريقة الدفع': 'كاش' }), 'اجمالي سعر الحجز': 700 } });
check('a row with its own price is a booking even with the same identity', rows.length === 2, rows.length);
rows = runLookup({ 50: R38, 51: lineOf(R38, {}) });
check('a row with neither paid nor method is not a line', rows.length === 2, rows.length);

section('lookup: nights, totals, dates');
const open = { ...R36, 'عدد الليالي': 12 };
const openF = { ...R36, 'عدد الليالي': '=TODAY()-J36', 'اجمالي سعر الحجز': '=500*I36' };
rows = runLookup({ 36: openF }, { 36: open });
check('an open-ended stay is =OPEN (the formula read, not the number it shows today)', rows[0]['عدد الليالي'] === '=OPEN', rows[0]['عدد الليالي']);
check('a nightly-rate total is flagged as a formula, and its VALUE comes from the values read',
  rows[0].total_is_formula === true && rows[0]['اجمالي سعر الحجز'] === 10000, [rows[0].total_is_formula, rows[0]['اجمالي سعر الحجز']]);
rows = runLookup({ 36: { ...R36, 'اجمالي سعر الحجز': '=12900' } }, { 36: { ...R36, 'اجمالي سعر الحجز': 12900 } });
check('a hand-typed constant total (=12900) is not a rate formula', rows[0].total_is_formula === false);
rows = runLookup({ 36: { ...R36, 'اجمالي سعر الحجز': '=1400+700' } }, { 36: { ...R36, 'اجمالي سعر الحجز': 2100 } });
check('neither is =1400+700', rows[0].total_is_formula === false);
rows = runLookup({ 36: { ...R36, 'اجمالي سعر الحجز': '=(650*I36)-2200' } }, { 36: { ...R36, 'اجمالي سعر الحجز': 900 } });
check('a rate with a discount is', rows[0].total_is_formula === true);
rows = runLookup({ 36: { ...R36, 'عدد الليالي': '=J36+1' } }, { 36: { ...R36, 'عدد الليالي': 4 } });
check('a formula that is not TODAY()-based shows its value', rows[0]['عدد الليالي'] === 4, rows[0]['عدد الليالي']);
rows = runLookup({ 36: { ...R36, 'تاريخ البداية': '2026-10-06' } });                                    // Review Focus 3
check('an ISO text date is kept', rows[0]['تاريخ البداية'] === '2026-10-06', rows[0]['تاريخ البداية']);
rows = runLookup({ 36: { ...R36, 'تاريخ البداية': '6/10/2026' } });
check('d/m/yyyy text becomes ISO', rows[0]['تاريخ البداية'] === '2026-10-06', rows[0]['تاريخ البداية']);
rows = runLookup({ 36: { ...R36, 'تاريخ المغادرة': 46302 } });
check('the departure serial becomes ISO too', rows[0]['تاريخ المغادرة'] === '2026-10-07', rows[0]['تاريخ المغادرة']);

section('lookup: the rows that are not bookings, and the odd ones that are');
rows = runLookup({ 2: { 'اسم المقيم': 'احمد حسن', 'تاريخ البداية': 46295, 'عدد الليالي': 12 },
  3: { 'ID': '19**', 'اسم المقيم': 'ناصر نزهه', 'اسم الشقة': 'انبي 2', 'رقم الغرفة': 1 }, 6: R36 });
check('a row with no ID is a booking with ID ""', rows[0]['ID'] === '' && rows[0]['اسم المقيم'] === 'احمد حسن', rows[0]);
check('a carried-over "19**" stays text', rows[1]['ID'] === '19**', rows[1]['ID']);
check('interior blank rows are skipped', rows.map(r => r.row_number).join() === '2,3,6', rows.map(r => r.row_number));
rows = runLookup({ 4: { 'ID': 9 } });
check('a row with an ID but no guest is not a booking', rows.length === 0, rows);
rows = runLookup({ 36: { ...R36, 'ملاحظات': 'ملغي' } });
check('a cancelled note passes through for the Brain to read', rows[0]['ملاحظات'] === 'ملغي');

section('lookup: nothing to read');                                                                    // Review Focus 1
const emptyRun = (a, b) => {
  const fn = new Function('$', src('build_bookings_lookup.js'));
  const $ = (name) => ({ first: () => ({ json: name === 'Fetch Bookings Formulas' ? a : b }) });
  return fn($);
};
check('an empty tab gives no rows (the node is alwaysOutputData, so the Brain still runs)', emptyRun({ values: [HEADERS] }, { values: [HEADERS] }).length === 0);
check('a failed fetch (an error item, no values) gives no rows and does not throw',
  emptyRun({ error: 'boom' }, { error: 'boom' }).length === 0);
check('so does a missing second fetch', (() => { const fn = new Function('$', src('build_bookings_lookup.js'));
  return fn((n) => { if (n === 'Fetch Bookings Values') throw new Error('Referenced node is unexecuted');
    return { first: () => ({ json: sheet({ 36: R36 }) }) }; }).length === 0; })());
rows = runLookup({ 36: R36 }, {});
check('formulas present but no values: the formula read stands in', rows.length === 1 && rows[0]['اسم المقيم'] === 'تبع عمر البيه', rows);

// ── The registry and the next ID are added by Task 3 ──────────────────────────

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node booking_bot/test_sheet_lookup.mjs 2>&1 | tail -5`
Expected: an error that `nodes/build_bookings_lookup.js` does not exist (ENOENT).

- [ ] **Step 3: Write `booking_bot/nodes/build_bookings_lookup.js`**

```js
/**
 * "Read Bookings For Edit" — the bookings tab as the Brain's lookup rows.
 *
 * This used to be a Postgres query (read_bookings_for_edit.sql) over a mirror that
 * only ever heard about the bot's own writes. The sheet is hand-edited and the
 * mirror was not, so the row number the query handed over drifted, and the bot
 * wrote the next payment onto the guest above or below. Reading the sheet in the
 * same turn removes that class of bug: the row number and the amounts are the
 * ones the bot is about to write against.
 *
 * Inputs are two Sheets-API `values.get` responses of A1:U2000, one rendered as
 * FORMULA and one as UNFORMATTED_VALUE (the HTTP nodes "Fetch Bookings Formulas"
 * and "Fetch Bookings Values"). The API, not the Sheets node: it returns rows from
 * row 1 with trailing empties trimmed and interior blanks kept, so a row's number
 * is its index + 1 — the Sheets node numbers rows from its own view of the range.
 *
 * A row is a BOOKING when it names a guest and is not a LINE. A LINE is a second
 * payment METHOD on the same booking: commitPaymentLine copies the identity columns
 * onto a row directly under the booking's block, leaves the price blank and fills
 * paid and method. Anything else — including the same guest on a later arrival, or
 * the same identity after a gap — is its own booking.
 *
 * The output keeps the sheet's own Arabic headers, so brain.js reads it as it read
 * the SQL: row_number, booking_id (the row: nothing outside this turn needs a
 * database id any more), lines, block_end and total_is_formula.
 */

const H = {
  ref: 'بوكنج ID', id: 'ID', name: 'اسم المقيم', type: 'نوع الحجز', phone: 'رقم الهاتف',
  apt: 'اسم الشقة', room: 'رقم الغرفة', nights: 'عدد الليالي', arrival: 'تاريخ البداية',
  departure: 'تاريخ المغادرة', total: 'اجمالي سعر الحجز', paid: 'اجمالي ما تم دفعه',
  method: 'طريقة الدفع', remaining: 'المتبقي', notes: 'ملاحظات',
};

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const txt = (v) => (v === undefined || v === null ? '' : String(v));

/** Rows of a values.get response as { row, cells: {header: value} }; row = index + 1. */
function sheetRows(resp) {
  const values = resp && Array.isArray(resp.values) ? resp.values : [];
  if (!values.length) return [];
  const head = values[0].map(h => txt(h).trim());
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const cells = {};
    head.forEach((h, c) => { if (h) cells[h] = row[c] === undefined ? '' : row[c]; });
    out.push({ row: i + 1, cells });
  }
  return out;
}

/** A date cell as YYYY-MM-DD: a Sheets serial, or text in the sheet's own forms. */
function isoDate(v) {
  if (blank(v)) return '';
  if (typeof v === 'number') {
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d+(\.\d+)?$/.test(s)) return isoDate(Number(s));
  return s;
}

/** Who the row is about; a line repeats its booking's. */
const keyOf = (v) => [v[H.id], v[H.name], v[H.apt], v[H.room], isoDate(v[H.arrival])]
  .map(x => txt(x).trim()).join('\u0001');

function bookingItem(row, f, v) {
  const nightsF = f[H.nights];
  const open = typeof nightsF === 'string' && /^=\s*TODAY\s*\(\s*\)/i.test(nightsF.trim());
  const totalF = f[H.total];
  return {
    row_number: row,
    [H.ref]: txt(v[H.ref]),
    [H.id]: txt(v[H.id]),
    [H.name]: txt(v[H.name]),
    [H.type]: txt(v[H.type]),
    [H.phone]: txt(v[H.phone]),
    [H.apt]: txt(v[H.apt]),
    [H.room]: v[H.room] === undefined ? '' : v[H.room],
    [H.nights]: open ? '=OPEN' : (blank(v[H.nights]) ? '' : v[H.nights]),
    [H.arrival]: isoDate(v[H.arrival]),
    [H.departure]: isoDate(v[H.departure]),
    [H.total]: v[H.total] === undefined ? '' : v[H.total],
    [H.paid]: v[H.paid] === undefined ? '' : v[H.paid],
    [H.method]: txt(v[H.method]),
    [H.remaining]: v[H.remaining] === undefined ? '' : v[H.remaining],
    [H.notes]: txt(v[H.notes]),
    booking_id: row,
    lines: [],
    block_end: row,
    // A nightly rate (=500*I10, =(650*I19)-2200) grows with the stay and must not be
    // overwritten by a typed number. A typed constant (=12900, =1400+700) may be.
    total_is_formula: typeof totalF === 'string' && totalF.trim().startsWith('=') && /\bI\d+\b/i.test(totalF),
  };
}

let formulas = [];
let values = [];
try {
  formulas = sheetRows($('Fetch Bookings Formulas').first().json);
  values = sheetRows($('Fetch Bookings Values').first().json);
} catch (e) {
  return [];                           // a node that did not run, or an error item
}

const valueCells = new Map(values.map(x => [x.row, x.cells]));
const out = [];
let cur = null;
let curKey = '';
for (const { row, cells } of formulas) {
  const v = valueCells.get(row) || cells;
  if (blank(v[H.name])) continue;      // an empty row, or one with no guest
  const isLine = cur && row === cur.block_end + 1 && keyOf(v) === curKey
    && blank(v[H.total]) && !(blank(v[H.paid]) && blank(v[H.method]));
  if (isLine) {
    cur.lines.push({
      seq: cur.lines.length + 2, row, method: txt(v[H.method]).trim(), amount: Number(v[H.paid]) || 0,
    });
    cur.block_end = row;
    continue;
  }
  cur = bookingItem(row, cells, v);
  curKey = keyOf(v);
  out.push(cur);
}
return out.map(json => ({ json }));
```

- [ ] **Step 4: Run to verify it passes**

Run: `node booking_bot/test_sheet_lookup.mjs 2>&1 | tail -4`
Expected: `all checks passed`.

- [ ] **Step 5: Commit**

```bash
git add booking_bot/nodes/build_bookings_lookup.js booking_bot/test_sheet_lookup.mjs
git commit -m "Read Bookings For Edit: the bookings and their payment lines, from the sheet" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The registry and the next booking ID, from the sheet

**Files:**
- Create: `booking_bot/nodes/build_locations.js`, `booking_bot/nodes/compute_next_booking_id.js`
- Modify: `booking_bot/test_sheet_lookup.mjs`

**Interfaces:**
- `build_locations.js` consumes its direct input `$input.first().json` = a `values.get` response of `الإتاحة!A2:B2000`; produces items `{ 'الشقة', 'الغرفة' }` (strings), the shape `locationRegistry()` and both report builders read. One body serves `Read Locations`, `Read Report Locations` and `Read Availability Locations`.
- `compute_next_booking_id.js` consumes `$input.first().json` = a `values.get` response of `B1:B2000` (row 1 = the `ID` header); produces `[{ json: { next_booking_id } }]`, read by `brain.js` as `$('Read Next Booking ID').first().json.next_booking_id`.

- [ ] **Step 1: Write the failing tests** — insert before the `// ── The registry …` comment line in `test_sheet_lookup.mjs`:

```js
function runInput(file, body) {
  const fn = new Function('$input', '$', src(file));
  return fn({ first: () => ({ json: body }) }, () => { throw new Error('no named reads'); }).map(i => i.json);
}

section('registry: the الإتاحة tab, A2:B');
const REG = { values: [
  ['الشقة', 'الغرفة'], ['التاريخ'],
  ['ذاكر حسين', 1], ['ذاكر حسين', 2], ['انبي 2', 1], ['ابو حديد 11', 10], ['ابو حديد 11', 2], [], ['', 3], ['عبدالله العربي'],
] };
let reg = runInput('build_locations.js', REG);
check('the header row and the date row are not rooms', !reg.some(r => r['الشقة'] === 'الشقة' || r['الشقة'] === 'التاريخ'), reg);
check('rooms are strings, in the tab\'s order',
  JSON.stringify(reg.map(r => [r['الشقة'], r['الغرفة']])) ===
  JSON.stringify([['ذاكر حسين', '1'], ['ذاكر حسين', '2'], ['انبي 2', '1'], ['ابو حديد 11', '10'], ['ابو حديد 11', '2']]), reg);
check('a row with no apartment or no room is dropped', reg.length === 5, reg.length);
check('no values at all gives no rows', runInput('build_locations.js', { error: 'boom' }).length === 0);                // Review Focus 1
check('a header-only tab gives no rows', runInput('build_locations.js', { values: [['الشقة', 'الغرفة']] }).length === 0);

section('next booking id: the highest plain counter this month, plus one');
const ids = (...v) => ({ values: [['ID'], ...v.map(x => [x])] });
check('the highest plain number + 1', runInput('compute_next_booking_id.js', ids(1, 2, 44, 43))[0].next_booking_id === 45);
check('text and number cells both count', runInput('compute_next_booking_id.js', ids('7', 8))[0].next_booking_id === 9);
check('Arabic-Indic digits are folded', runInput('compute_next_booking_id.js', ids('٢٥', '٩'))[0].next_booking_id === 26);
check('a carried-over "104**" never counts', runInput('compute_next_booking_id.js', ids(3, '104**', '19**'))[0].next_booking_id === 4);
check('a passport-length number (> 6 digits) never counts', runInput('compute_next_booking_id.js', ids(3, '29876543210'))[0].next_booking_id === 4);
check('a blank row and the header never count', runInput('compute_next_booking_id.js', ids('', 5, ' '))[0].next_booking_id === 6);
check('an empty tab starts at 1', runInput('compute_next_booking_id.js', { values: [['ID']] })[0].next_booking_id === 1);
check('a failed read starts at 1 rather than throwing', runInput('compute_next_booking_id.js', { error: 'x' })[0].next_booking_id === 1);
check('cancelled bookings still spend their number (the ID cell is all that is read)', runInput('compute_next_booking_id.js', ids(1, 2, 3))[0].next_booking_id === 4);
```

Remove the now-wrong trailing comment `// ── The registry and the next ID are added by Task 3 ──`.

- [ ] **Step 2: Run to verify failure**

Run: `node booking_bot/test_sheet_lookup.mjs 2>&1 | tail -4`
Expected: ENOENT for `build_locations.js`.

- [ ] **Step 3: Write `booking_bot/nodes/build_locations.js`**

```js
/**
 * The apartment / room registry, from the الإتاحة tab (A2:B).
 *
 * One body for the three nodes that need it — "Read Locations" (the Telegram
 * branch), "Read Report Locations" and "Read Availability Locations" — because it
 * reads only its direct input: the values.get response of the HTTP node in front.
 *
 * Row 2 of the tab is the header (الشقة / الغرفة) and row 3 holds a date label with
 * no room; neither is a room. Rooms keep the tab's order, which is already grouped
 * by apartment and ascending. brain.js's locationRegistry() and build_reports.js
 * read الشقة / الغرفة as text, exactly as they read the SQL this replaced.
 */
const resp = $input.first().json;
const values = resp && Array.isArray(resp.values) ? resp.values : [];
const cell = (v) => (v === undefined || v === null ? '' : String(v).trim());
const out = [];
for (const r of values) {
  const apartment = cell(r[0]);
  const room = cell(r[1]);
  if (!apartment || !room || apartment === 'الشقة') continue;
  out.push({ json: { 'الشقة': apartment, 'الغرفة': room } });
}
return out;
```

- [ ] **Step 4: Write `booking_bot/nodes/compute_next_booking_id.js`**

```js
/**
 * "Read Next Booking ID" — the ID offered for the next booking: one past the
 * highest this month's tab holds, so nobody has to remember it.
 *
 * The numbering restarts every month, and the tab is one month, so "this month"
 * holds by construction. Guests carried over from last month keep their old ID
 * marked with stars ("104**"), which is not a plain counter and never counts; ID is
 * hand-typed text, so only 1-6 digit counters do (a passport or national number
 * would push every suggestion into the millions). Arabic-Indic digits are folded to
 * ASCII first, the way brain.js reads them. Cancelled bookings keep their number.
 *
 * A suggestion, not an allocation: the receptionist can type another number.
 * Input: the values.get response of B1:B2000 (row 1 is the "ID" header).
 */
const resp = $input.first().json;
const values = resp && Array.isArray(resp.values) ? resp.values : [];
const fold = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/[٠-٩]/g, ch => String(ch.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, ch => String(ch.charCodeAt(0) - 0x06F0))
  .trim();
let max = 0;
for (let i = 1; i < values.length; i++) {         // row 1 is the header
  const s = fold((values[i] || [])[0]);
  if (/^[0-9]{1,6}$/.test(s)) max = Math.max(max, Number(s));
}
return [{ json: { next_booking_id: max + 1 } }];
```

- [ ] **Step 5: Run to verify**

Run: `node booking_bot/test_sheet_lookup.mjs 2>&1 | tail -3`
Expected: `all checks passed`.

- [ ] **Step 6: Commit**

```bash
git add booking_bot/nodes/build_locations.js booking_bot/nodes/compute_next_booking_id.js booking_bot/test_sheet_lookup.mjs
git commit -m "The registry and the next booking ID, from the sheet" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The base graph — no Postgres

**Files:**
- Modify: `booking_bot/build_workflow.py`
- Modify: `booking_bot/test_workflow.py`

**Interfaces:**
- Consumes: Tasks 2-3 node bodies; Task 1's proven Data Table shapes.
- Produces (used by Task 5): in `build_workflow.py`: `AVAILABILITY_TAB`, `values_get(tab_expr, rng, render="UNFORMATTED_VALUE")`, `fetch_params(tab_expr, rng, render)`, `FETCH_SETTINGS`, `LOOKUP_CODE_SETTINGS`, `session_params(operation)` → the Data Table parameter dict for `"get"`, `"save"`, `"clear"`, and `lookup_node_specs()` → `{name: (type, typeVersion, params, settings, credential-or-None)}` for `Fetch Bookings Formulas`, `Fetch Bookings Values`, `Read Bookings For Edit`, `Fetch Locations`, `Read Locations`, `Fetch Booking Ids`, `Read Next Booking ID`, `Fetch Report Locations`, `Read Report Locations`, `Fetch Availability Locations`, `Read Availability Locations`.

- [ ] **Step 1: Write the failing tests** — append to `test_workflow.py`:

```python
# ── Sheet-only: no Postgres anywhere ─────────────────────────────────────────

POSTGRES_NAMES = {"Build Shadow Write", "Shadow Write", "Read Booking Id", "Write Booking Id",
                  "Write Line Id", "Build Snapshot SQL", "Write Snapshot", "Read Discrepancies",
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
    # an HTTP node runs once per incoming item
    assert nodes["Fetch Locations"].get("executeOnce") is True
    assert nodes["Fetch Booking Ids"].get("executeOnce") is True
    renders = {n: [p["value"] for p in nodes[n]["parameters"]["queryParameters"]["parameters"]
                   if p["name"] == "valueRenderOption"] for n in ("Fetch Bookings Formulas", "Fetch Bookings Values")}
    assert renders == {"Fetch Bookings Formulas": ["FORMULA"], "Fetch Bookings Values": ["UNFORMATTED_VALUE"]}


def test_the_code_nodes_carry_the_files_that_are_tested(nodes):
    import os
    here = os.path.dirname(os.path.abspath(bw.__file__))
    for name, body in (("Read Bookings For Edit", "build_bookings_lookup.js"),
                       ("Read Locations", "build_locations.js"),
                       ("Read Next Booking ID", "compute_next_booking_id.js")):
        assert nodes[name]["parameters"]["jsCode"] == open(os.path.join(here, "nodes", body), encoding="utf-8").read(), name


def test_the_registry_tab_is_in_config(nodes):
    have = {a["name"]: a["value"] for a in nodes["Config"]["parameters"]["assignments"]["assignments"]}
    assert have["AVAILABILITY_TAB"] == "الإتاحة"


def test_the_payment_line_write_ends_at_the_group_post(graph):
    """Write Line Id stamped a database id into column U and is gone with the database."""
    assert targets(graph, "Write Line Rows")[0] == ["Has Group?"]
    assert "Write Line Id" not in graph.connections
```

Update the existing tests that assumed the old nodes:
- Replace `test_the_registry_read_runs_once_when_it_follows_the_bookings_read` with the `executeOnce` assertions above (delete the function; its `dg.read_settings` references go away in Task 5).
- In `test_the_ai_gate_sits_between_the_last_lookup_and_the_brain` nothing changes.

- [ ] **Step 2: Run to verify failure**

Run: `python -m pytest booking_bot/test_workflow.py -q 2>&1 | grep -E "^(FAILED|ERROR)|passed|failed" | head -12`
Expected: the new tests fail (Postgres nodes still there).

- [ ] **Step 3: `build_workflow.py` — constants and helpers**

After `BOOKINGS_TAB`/`EXPENSE_TAB` add `AVAILABILITY_TAB = "الإتاحة"`. In `Config`'s assignments (near `EXPENSE_TAB`) add `{"id": "avail_tab", "name": "AVAILABILITY_TAB", "value": AVAILABILITY_TAB, "type": "string"}`. Delete `POSTGRES_CRED` and the `SESSION_TABLE` stays.

Change `values_get` to take the render option:

```python
def values_get(tab_expr, rng, render="UNFORMATTED_VALUE"):
    ...  # docstring unchanged
        "queryParameters": {"parameters": [
            {"name": "majorDimension", "value": "ROWS"},
            # (existing comment)
            {"name": "valueRenderOption", "value": render},
        ]},
```

Add after `sheets_read`:

```python
# The lookups' HTTP reads. onError continues so a failed read still reaches the Code
# node (which returns nothing) and the Brain; retried once because a 5xx from Sheets
# is transient and the read is a plain GET.
FETCH_SETTINGS = dict(onError="continueRegularOutput", retryOnFail=True, maxTries=2,
                      waitBetweenTries=500)
# A Code node that emits nothing stops the branch before the Brain runs — the same
# lesson as the SQL nodes these replace. This makes an empty read one empty item.
LOOKUP_CODE_SETTINGS = dict(alwaysOutputData=True)


def fetch_params(tab_expr, rng, render="UNFORMATTED_VALUE"):
    p = values_get(tab_expr, rng, render)
    p["options"] = {"timeout": 15000}
    return p


def session_params(operation):
    """The Data Table parameters for the session store.

    `get` for Load Session; `save` / `clear` are the two upserts. Proven against the
    real node in a scratch workflow (plan Task 1) because this store was abandoned
    on 2026-08-14 after it "looked up cleanly and wrote nothing".
    """
    table = {"__rl": True, "mode": "name", "value": SESSION_TABLE}
    chat_id = ("={{ String($('Telegram Trigger').first().json.message?.chat?.id ?? "
               "$('Telegram Trigger').first().json.callback_query.message.chat.id) }}")
    if operation == "get":
        return {"resource": "row", "operation": "get", "dataTableId": table,
                "matchType": "allConditions",
                "filters": {"conditions": [{"keyName": "chat_id", "condition": "eq",
                                            "keyValue": chat_id}]},
                "returnAll": False, "limit": 1}
    schema = [{"id": c, "displayName": c, "required": False, "defaultMatch": False,
               "display": True, "type": t, "canBeUsedToMatch": True}
              for c, t in (("chat_id", "string"), ("state", "string"),
                           ("data", "string"), ("updated_at", "number"))]
    if operation == "save":
        key = "={{ $json.chatId }}"
        value = {"chat_id": key, "state": "={{ $json.sessionState }}",
                 "data": "={{ $json.sessionData }}", "updated_at": "={{ Date.now() }}"}
    else:                                   # "clear": ended, with nothing parked in `data`
        key = "={{ $('Brain').first().json.chatId }}"
        value = {"chat_id": key, "state": "", "data": "{}", "updated_at": "={{ Date.now() }}"}
    return {"resource": "row", "operation": "upsert", "dataTableId": table,
            "matchType": "allConditions",
            "filters": {"conditions": [{"keyName": "chat_id", "condition": "eq", "keyValue": key}]},
            "columns": {"mappingMode": "defineBelow", "value": value,
                        "matchingColumns": ["chat_id"], "schema": schema}}


def lookup_node_specs():
    """name -> (type, typeVersion, parameters, settings, credential). The lookups the
    Postgres reads became, shared by build() and deploy_graph.py (which adds the two
    report/availability registries to a live workflow)."""
    http = "n8n-nodes-base.httpRequest"
    code = "n8n-nodes-base.code"
    once = dict(FETCH_SETTINGS, executeOnce=True)
    return {
        "Fetch Bookings Formulas": (http, 4.2, fetch_params("BOOKINGS_TAB", "A1:U2000", "FORMULA"),
                                    dict(FETCH_SETTINGS), SHEETS_CRED),
        "Fetch Bookings Values": (http, 4.2, fetch_params("BOOKINGS_TAB", "A1:U2000"),
                                  dict(FETCH_SETTINGS), SHEETS_CRED),
        "Read Bookings For Edit": (code, 2, {"jsCode": read_source("build_bookings_lookup.js")},
                                   dict(LOOKUP_CODE_SETTINGS), None),
        "Fetch Locations": (http, 4.2, fetch_params("AVAILABILITY_TAB", "A2:B2000"), once, SHEETS_CRED),
        "Read Locations": (code, 2, {"jsCode": read_source("build_locations.js")},
                           dict(LOOKUP_CODE_SETTINGS), None),
        "Fetch Booking Ids": (http, 4.2, fetch_params("BOOKINGS_TAB", "B1:B2000"), once, SHEETS_CRED),
        "Read Next Booking ID": (code, 2, {"jsCode": read_source("compute_next_booking_id.js")},
                                 dict(LOOKUP_CODE_SETTINGS), None),
        "Fetch Report Locations": (http, 4.2, fetch_params("AVAILABILITY_TAB", "A2:B2000"),
                                   dict(FETCH_SETTINGS), SHEETS_CRED),
        "Read Report Locations": (code, 2, {"jsCode": read_source("build_locations.js")},
                                  dict(LOOKUP_CODE_SETTINGS), None),
        "Fetch Availability Locations": (http, 4.2, fetch_params("AVAILABILITY_TAB", "A2:B2000"),
                                         dict(FETCH_SETTINGS), SHEETS_CRED),
        "Read Availability Locations": (code, 2, {"jsCode": read_source("build_locations.js")},
                                        dict(LOOKUP_CODE_SETTINGS), None),
    }
```

(`read_source` already exists above `Graph`; if it is defined after these helpers, move these helpers below it.)

- [ ] **Step 4: `build_workflow.py` — `build()`**

Replace the Postgres `Load Session` node (the block under "The session" comment) with the comment below and:

```python
    # ── The session ──────────────────────────────────────────────────────────
    #
    # One row per chat in the n8n Data Table `bookings_bot_sessions`. It was the
    # original store; it moved to Postgres on 2026-08-14 because it "looked up
    # cleanly and wrote nothing", and returned on 2026-10-12 when Postgres left the
    # bot. session_params() has the shape that was proven to persist, and the proof
    # is in the plan (Task 1). `alwaysOutputData` lets a chat with no row through as
    # an empty item, which the Brain's readSession() reads as "no session".
    g.node("Load Session", "n8n-nodes-base.dataTable", 1.1, session_params("get"),
           (-60, 300), alwaysOutputData=True)
```

Replace the two Postgres lookup nodes and `Read Next Booking ID` (from `lookup_settings = dict(...)` through the `Read Next Booking ID` node) with:

```python
    specs = lookup_node_specs()

    def lookup(name, pos):
        ntype, tv, params, settings, cred = specs[name]
        g.node(name, ntype, tv, params, pos, cred=cred, **settings)

    # Each lookup runs only on the turns that need it; the Brain references them in
    # try/catch because they are unexecuted on every other turn.
    g.node("Needs Bookings?", "n8n-nodes-base.if", 2.3,
           {"conditions": state_conditions(BOOKING_STATES),
            "looseTypeValidation": True, "options": {}}, (160, 300))
    lookup("Fetch Bookings Formulas", (360, 120))
    lookup("Fetch Bookings Values", (560, 120))
    lookup("Read Bookings For Edit", (760, 120))
    g.node("Needs Locations?", "n8n-nodes-base.if", 2.3,
           {"conditions": state_conditions(LOCATION_STATES, from_session=True),
            "looseTypeValidation": True, "options": {}}, (960, 300))
    lookup("Fetch Locations", (1160, 180))
    lookup("Read Locations", (1360, 180))
```

and, where `Read Next Booking ID` was, `lookup("Fetch Booking Ids", (760, 420))` and `lookup("Read Next Booking ID", (960, 420))` (keep the `Needs Booking ID?` / `Needs Expense Number?` / `Read Expense Numbers` nodes as they are, with their comments). Keep `lookup_settings` only if `Read Expense Numbers` still uses it (it does: keep that dict, minus the Postgres wording).

Connections (replace the old lookup wiring block):

```python
    g.connect("Telegram Trigger", "Config")
    g.connect("Config", "Load Session")
    g.connect("Load Session", "Needs Bookings?")
    # true -> look the bookings up first; false -> straight on to the next gate.
    g.connect("Needs Bookings?", "Fetch Bookings Formulas", index=0)
    g.connect("Needs Bookings?", "Needs Locations?", index=1)
    g.connect("Fetch Bookings Formulas", "Fetch Bookings Values")
    g.connect("Fetch Bookings Values", "Read Bookings For Edit")
    g.connect("Read Bookings For Edit", "Needs Locations?")
    g.connect("Needs Locations?", "Fetch Locations", index=0)
    g.connect("Fetch Locations", "Read Locations")
    g.connect("Read Locations", "Needs Booking ID?")
    g.connect("Needs Locations?", "Needs Booking ID?", index=1)
    g.connect("Needs Booking ID?", "Fetch Booking Ids", index=0)
    g.connect("Fetch Booking Ids", "Read Next Booking ID")
    g.connect("Needs Booking ID?", "Needs Expense Number?", index=1)
    g.connect("Read Next Booking ID", "Needs Expense Number?")
    g.connect("Needs Expense Number?", "Read Expense Numbers", index=0)
```

(this replaces the lines from `g.connect("Telegram Trigger", "Config")` through `g.connect("Needs Expense Number?", "Read Expense Numbers", index=0)`, including the ones now split around the `Brain` node definition — keep the `g.node("Brain", …)` line where it is.)

`Save Session` and `Clear Session`: replace their Postgres definitions with

```python
    g.node("Save Session", "n8n-nodes-base.dataTable", 1.1, session_params("save"), (1160, 480))
```
```python
    g.node("Clear Session", "n8n-nodes-base.dataTable", 1.1, session_params("clear"), (2760, 660))
```
(keep the surrounding comments about ordering, rewriting the Postgres-specific ones: "`updated_at` is `Date.now()`, the same server clock the Brain compares against").

`Write Line Id`: delete the node definition, its comment block, and `g.connect("Write Line Rows", "Write Line Id")` with its comment. Delete `values_put_id` if nothing else in `build_workflow.py` or `deploy_graph.py` still calls it after Task 5 (check with grep in Task 6).

Update the module docstring and comments that describe Postgres/shadow (`deploy_graph.py hangs the shadow write off this node`, "Phase 4b" lookups, `bot_sessions`) to say what is true now.

- [ ] **Step 5: Run to verify**

Run: `python -m pytest booking_bot/test_workflow.py -q 2>&1 | grep -E "^(FAILED|ERROR)|passed|failed" | head`
Expected: the new tests pass. Tests that still reference removed helpers (`dg.read_settings`, the shadow wiring) fail until Task 5 — list them in the ledger; they are fixed there.

Also run: `node booking_bot/test_brain.mjs | tail -1` → `all checks passed`, and `python booking_bot/build_workflow.py --print > /dev/null` exits 0.

- [ ] **Step 6: Commit**

```bash
git add booking_bot/build_workflow.py booking_bot/test_workflow.py
git commit -m "The base graph without Postgres: Data Table sessions and sheet lookups" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `deploy_graph.py` — the reports' registries and the live migration

**Files:**
- Modify: `booking_bot/deploy_graph.py`
- Modify: `booking_bot/test_workflow.py`

**Interfaces:**
- Consumes: Task 4's `bw.lookup_node_specs()`, `bw.session_params()`, `bw.build()`.
- Produces: `RETIRED` (the node names to remove), `sheet_only_ops(wf, target, sheets_cred)` → `ops` (see Step 3), `apply_in_batches(ops)`; `apply_offline` understands `removeNode`.

- [ ] **Step 1: Write the failing tests** — append to `test_workflow.py`:

```python
# ── The live migration ───────────────────────────────────────────────────────

def _old_graph():
    """A copy of the base graph rewound to what the live workflow looked like before
    this change: Postgres nodes for sessions and lookups, and the live-only branches."""
    wf = json.loads(json.dumps(bw.workflow(bw.build())))
    nodes = {n["name"]: n for n in wf["nodes"]}
    for name in ("Load Session", "Save Session", "Clear Session", "Read Bookings For Edit",
                 "Read Locations", "Read Next Booking ID"):
        nodes[name]["type"] = "n8n-nodes-base.postgres"
        nodes[name]["typeVersion"] = 2.6
        nodes[name]["parameters"] = {"operation": "executeQuery", "query": "select 1"}
    for name in ("Fetch Bookings Formulas", "Fetch Bookings Values", "Fetch Locations", "Fetch Booking Ids"):
        wf["nodes"] = [n for n in wf["nodes"] if n["name"] != name]
        wf["connections"].pop(name, None)
    c = wf["connections"]
    link = lambda src, tgt, i=0: (c.setdefault(src, {}).setdefault("main", []) or None) and None
    def add(src, tgt, i=0):
        main = c.setdefault(src, {}).setdefault("main", [])
        while len(main) <= i:
            main.append([])
        main[i].append({"node": tgt, "type": "main", "index": 0})
    for spec in c.values():
        for br in spec.get("main", []):
            br[:] = [l for l in br if not l["node"].startswith("Fetch ")]
    add("Needs Bookings?", "Read Bookings For Edit", 0)
    add("Needs Locations?", "Read Locations", 0)
    add("Needs Booking ID?", "Read Next Booking ID", 0)
    # the live-only branches
    for name in sorted(POSTGRES_NAMES - {"Write Line Id"}):
        wf["nodes"].append({"name": name, "type": "n8n-nodes-base.postgres", "typeVersion": 2.6,
                            "position": [0, 0], "parameters": {"operation": "executeQuery", "query": "select 1"}})
    add("Clear Session", "Build Shadow Write")
    add("Build Shadow Write", "Shadow Write")
    add("Shadow Write", "Read Booking Id")
    add("Read Booking Id", "Write Booking Id")
    return wf


def _migrated(live=None):
    live = live or _old_graph()
    target = bw.workflow(bw.build())
    ops = dg.sheet_only_ops(live, target, ("googleSheetsOAuth2Api", "SHEETS-ID", "Google Sheets account"))
    dg.apply_offline(live, ops)
    return live, ops


def test_migrating_the_old_graph_gives_the_built_graph():
    live, ops = _migrated()
    built = bw.workflow(bw.build())
    got = {n["name"]: n for n in live["nodes"]}
    want = {n["name"]: n for n in built["nodes"]}
    assert not [n for n in got if n.endswith("Locations") and got[n]["type"].endswith("postgres")]
    assert not [n for n in live["nodes"] if n["type"].endswith("postgres")]
    for name in ("Load Session", "Save Session", "Clear Session", "Read Bookings For Edit", "Read Locations",
                 "Read Next Booking ID", "Fetch Bookings Formulas", "Fetch Bookings Values", "Fetch Locations",
                 "Fetch Booking Ids"):
        for field in ("type", "typeVersion", "parameters"):
            assert got[name][field] == want[name][field], (name, field)
    for src in ("Needs Bookings?", "Needs Locations?", "Needs Booking ID?", "Fetch Bookings Formulas",
                "Fetch Bookings Values", "Read Bookings For Edit", "Fetch Locations", "Read Locations",
                "Fetch Booking Ids", "Read Next Booking ID"):
        assert live["connections"][src] == built["connections"][src], src
    assert vw.check(live) == []


def test_the_retired_branches_leave_nothing_behind():
    live, _ = _migrated()
    names = {n["name"] for n in live["nodes"]}
    assert not (names & POSTGRES_NAMES), names & POSTGRES_NAMES
    for spec in live["connections"].values():
        for br in spec.get("main", []):
            assert not [l for l in br if l["node"] in POSTGRES_NAMES]
    assert "Build Shadow Write" not in live["connections"]


def test_migrating_twice_changes_nothing_the_second_time():
    live, _ = _migrated()
    target = bw.workflow(bw.build())
    ops = dg.sheet_only_ops(live, target, ("googleSheetsOAuth2Api", "SHEETS-ID", "Google Sheets account"))
    kinds = {o["type"] for o in ops}
    assert not (kinds & {"addNode", "removeNode", "addConnection", "removeConnection"}), kinds       # Review Focus 5


def test_the_http_fetches_carry_their_credential_inline():
    """setNodeCredential refuses googleSheetsOAuth2Api on an HTTP node, so the node is
    added WITH its credentials (proved in plan Task 1)."""
    _, ops = _migrated()
    adds = {o["node"]["name"]: o["node"] for o in ops if o["type"] == "addNode"}
    for name in ("Fetch Bookings Formulas", "Fetch Bookings Values", "Fetch Locations", "Fetch Booking Ids"):
        assert adds[name]["credentials"]["googleSheetsOAuth2Api"]["id"] == "SHEETS-ID", name
    assert not [o for o in ops if o["type"] == "setNodeCredential" and "Fetch" in o["nodeName"]]


def test_the_migration_fits_the_endpoints_batch_limit():
    _, ops = _migrated()
    batches = dg.batches(ops, 90)
    assert all(len(b) <= 90 for b in batches) and sum(map(len, batches)) == len(ops)


def test_the_merged_workflow_has_no_postgres_anywhere(monkeypatch, tmp_path):
    base = tmp_path / "base.json"
    out = tmp_path / "full.json"
    base.write_text(json.dumps(bw.workflow(bw.build()), ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(dg, "OFFLINE_IN", str(base))
    monkeypatch.setattr(dg, "OFFLINE_OUT", str(out))
    monkeypatch.setattr(sys, "argv", ["deploy_graph.py", "--offline"])
    dg.main()
    full = json.loads(out.read_text(encoding="utf-8"))
    assert not [n["name"] for n in full["nodes"] if n["type"].endswith("postgres")]
    assert not (POSTGRES_NAMES & {n["name"] for n in full["nodes"]})
    names = {n["name"] for n in full["nodes"]}
    for need in ("Fetch Report Locations", "Read Report Locations", "Fetch Availability Locations",
                 "Read Availability Locations", "Build Reports", "Build Availability Report"):
        assert need in names, need
    assert targets_in(full, "Report Config") == [["Fetch Report Locations"]]
    assert targets_in(full, "Fetch Report Locations") == [["Read Report Locations"]]
    assert targets_in(full, "Read Report Locations") == [["Read Report Formulas"]]
    assert targets_in(full, "Availability Config") == [["Fetch Availability Locations"]]
    assert targets_in(full, "Fetch Availability Locations") == [["Read Availability Locations"]]
    assert targets_in(full, "Read Availability Locations") == [["Read Availability Formulas"]]
    assert vw.check(full) == []


def targets_in(wf, src):
    return [[l["node"] for l in br] for br in wf["connections"].get(src, {}).get("main", [])]
```

Delete the tests that cover removed behaviour: `test_the_registry_read_runs_once_when_it_follows_the_bookings_read` (if not already removed), and in `test_the_offline_merge_wires_the_brain_once` keep the assertions (they still hold).

- [ ] **Step 2: Run to verify failure**

Run: `python -m pytest booking_bot/test_workflow.py -q 2>&1 | grep -E "^(FAILED|ERROR)|passed|failed" | head -12`
Expected: failures (`dg.sheet_only_ops` does not exist, etc.).

- [ ] **Step 3: `deploy_graph.py` — remove the Postgres blocks**

Delete, in `main()`:
- the `postgres_read` function and all `postgres_read(...)` calls (`Read Bookings For Edit`, `Read Locations`, `Read Next Booking ID`, `Read Report Locations`, `Read Availability Locations`);
- the whole `# ── Phase 2: dual-write to Supabase` block and the whole `# ── Phase 3: the daily reconcile` block (from their header comments to the line before `# ── A payment receipt sent as a file`), including the `MIRROR_ON` handling if present;
- `read_settings` (added for the `executeOnce` fix) and the module constants `pg`, `pg = next(...)` lookups, `list_credentials` for `postgres`;
- the Phase 2/3 mentions in the module docstring (replace by a short "Sheet-only" paragraph);
- the "Undo" comment block if it only described the shadow write.

In the scheduled-report block, where `postgres_read("Read Report Locations", …)` was, add (this runs only when the live workflow is already sheet-only or being built offline; the live type swap is `sheet_only_ops`'s job):

```python
    # The room registry, for 🔓 الغرف الفارغة, from the الإتاحة tab. It sits at the HEAD
    # of the chain: one item in from Report Config is one fetch, whereas hanging it
    # off either sheet read would fire it once per row.
    registry_pair("Fetch Report Locations", "Read Report Locations", [-840, 960])
```

and in the availability block, where `postgres_read("Read Availability Locations", …)` was:

```python
    registry_pair("Fetch Availability Locations", "Read Availability Locations", [1680, 1100])
```

with the helper (defined next to `connect`/`disconnect` inside `main()`):

```python
    def registry_pair(fetch, read, pos):
        specs = bw.lookup_node_specs()
        for name, p in ((fetch, pos), (read, [pos[0] + 120, pos[1]])):
            ntype, tv, params, settings, cred = specs[name]
            if name in have:
                ops.append({"type": "updateNodeParameters", "nodeName": name, "parameters": params})
                continue
            node = {"name": name, "type": ntype, "typeVersion": tv, "parameters": params, "position": p}
            if cred:                                    # an HTTP node takes its credential inline
                node["credentials"] = {cred[0]: {"id": SHEETS_CRED[1], "name": SHEETS_CRED[2]}}
            ops.append({"type": "addNode", "node": node})
            if settings:
                ops.append({"type": "setNodeSettings", "nodeName": name, "settings": settings})
            print(f"  + {name}")
```

and fix their wiring: `connect("Report Config", "Fetch Report Locations")`, `connect("Fetch Report Locations", "Read Report Locations")`, `connect("Read Report Locations", "Read Report Formulas")`; `connect("Availability Config", "Fetch Availability Locations")`, `connect("Fetch Availability Locations", "Read Availability Locations")`, `connect("Read Availability Locations", "Read Availability Formulas")` (replacing the old `connect("Report Config", "Read Report Locations")` and `connect("Availability Config", "Read Availability Locations")`).

- [ ] **Step 4: `deploy_graph.py` — the migration functions**

Add near the top-level helpers:

```python
# Nodes that exist only to feed the database, with their helpers. Removing a node
# drops its connections, so nothing is left pointing at them.
RETIRED = ["Build Shadow Write", "Shadow Write", "Read Booking Id", "Write Booking Id", "Write Line Id",
           "Build Snapshot SQL", "Write Snapshot", "Read Discrepancies", "Build Reconcile Message",
           "Read Unmirrored Bookings", "Append Mirror Row", "Mark Mirrored"]

# Nodes whose TYPE changes (Postgres -> Data Table / Code). Updating parameters cannot
# change a node's type, so each is removed and added again with its edges restored.
RETYPED = ["Load Session", "Save Session", "Clear Session", "Read Bookings For Edit", "Read Locations",
           "Read Next Booking ID", "Read Report Locations", "Read Availability Locations"]

# Fetches that are NEW nodes in front of a Code node, with the node they feed.
FETCHES = [("Needs Bookings?", 0, ["Fetch Bookings Formulas", "Fetch Bookings Values"], "Read Bookings For Edit"),
           ("Needs Locations?", 0, ["Fetch Locations"], "Read Locations"),
           ("Needs Booking ID?", 0, ["Fetch Booking Ids"], "Read Next Booking ID"),
           ("Report Config", 0, ["Fetch Report Locations"], "Read Report Locations"),
           ("Availability Config", 0, ["Fetch Availability Locations"], "Read Availability Locations")]


def batches(ops, size=90):
    """The endpoint takes at most 100 operations per call, each call atomic."""
    return [ops[i:i + size] for i in range(0, len(ops), size)]


def sheet_only_ops(wf, target, sheets_cred):
    """Operations that turn the live workflow `wf` into the sheet-only one.

    `target` is the graph build_workflow.py builds; node parameters and the edges
    around the retyped nodes come from it. Idempotent: run on a migrated workflow it
    returns only parameter updates. `sheets_cred` is (type, id, name) of the live
    Google credential, embedded in each added HTTP node (setNodeCredential refuses
    googleSheetsOAuth2Api on an HTTP node — see plan Task 1).
    """
    live = {n["name"]: n for n in wf["nodes"]}
    want = {n["name"]: n for n in target["nodes"]}
    tconns, lconns = target["connections"], wf.get("connections", {})
    specs = bw.lookup_node_specs()
    ops = []

    def edges_of(conns, name):
        """(incoming [(src, idx, kind)], outgoing [(idx, tgt, kind)]) of one node."""
        inc = [(s, i, k) for s, spec in conns.items() for k, brs in spec.items()
               for i, br in enumerate(brs) for l in br if l["node"] == name]
        out = [(i, l["node"], k) for k, brs in conns.get(name, {}).items()
               for i, br in enumerate(brs) for l in br]
        return inc, out

    def node_dict(name):
        if name in want:
            n = dict(want[name])
        else:                                                    # a report/availability node
            ntype, tv, params, settings, cred = specs[name]
            n = {"name": name, "type": ntype, "typeVersion": tv, "parameters": params, "position": [0, 0]}
        n = {k: n[k] for k in ("name", "type", "typeVersion", "parameters", "position") if k in n}
        n["position"] = list(n.get("position") or [0, 0])
        if name in specs and specs[name][4]:
            n["credentials"] = {sheets_cred[0]: {"id": sheets_cred[1], "name": sheets_cred[2]}}
        return n

    def settings_for(name):
        if name in specs:
            return dict(specs[name][3])
        src = want.get(name, {})
        return {k: src[k] for k in ("alwaysOutputData", "onError", "retryOnFail", "maxTries",
                                    "executeOnce", "waitBetweenTries") if k in src}

    # 1. Config gains AVAILABILITY_TAB.
    cfg = live.get("Config")
    if cfg is not None:
        assigns = cfg["parameters"]["assignments"]["assignments"]
        if not any(a["name"] == "AVAILABILITY_TAB" for a in assigns):
            assigns = assigns + [{"id": "avail_tab", "name": "AVAILABILITY_TAB",
                                  "value": bw.AVAILABILITY_TAB, "type": "string"}]
            ops.append({"type": "updateNodeParameters", "nodeName": "Config",
                        "parameters": {"assignments": {"assignments": assigns}}})

    # 2. Retype: remember the edges, remove, add, restore them.
    for name in RETYPED:
        if name not in live:
            continue
        ntype = specs[name][0] if name in specs else want[name]["type"]
        if live[name]["type"] == ntype:
            params = specs[name][2] if name in specs else want[name]["parameters"]
            ops.append({"type": "updateNodeParameters", "nodeName": name, "parameters": params})
            continue
        inc, out = edges_of(lconns, name)
        # incoming edges from nodes that will be retired or replaced are not restored
        keep_in = [e for e in inc if e[0] not in RETIRED]
        ops.append({"type": "removeNode", "nodeName": name})
        ops.append({"type": "addNode", "node": node_dict(name)})
        if settings_for(name):
            ops.append({"type": "setNodeSettings", "nodeName": name, "settings": settings_for(name)})
        for src, idx, kind in keep_in:
            if src in live:
                ops.append({"type": "addConnection", "source": src, "target": name,
                            "sourceIndex": idx, "targetIndex": 0})
        for idx, tgt, kind in out:
            if tgt not in RETIRED:
                ops.append({"type": "addConnection", "source": name, "target": tgt,
                            "sourceIndex": idx, "targetIndex": 0})

    # 3. The new fetch nodes, and the edges that put them in front of their Code node.
    for gate, idx, fetches, reader in FETCHES:
        if gate not in live or reader not in live and reader not in want:
            continue
        for f in fetches:
            if f in live:
                ops.append({"type": "updateNodeParameters", "nodeName": f, "parameters": specs[f][2]})
                continue
            ops.append({"type": "addNode", "node": node_dict(f)})
            if settings_for(f):
                ops.append({"type": "setNodeSettings", "nodeName": f, "settings": settings_for(f)})
        chain = fetches + [reader]
        pairs = [(gate, chain[0], idx)] + [(a, b, 0) for a, b in zip(chain, chain[1:])]
        for src, tgt, i in pairs:
            have_edge = any(l["node"] == tgt for br in lconns.get(src, {}).get("main", [])[i:i + 1] for l in br)
            if not have_edge:
                ops.append({"type": "addConnection", "source": src, "target": tgt,
                            "sourceIndex": i, "targetIndex": 0})
        # the old direct edge gate -> reader is replaced by gate -> fetch
        if any(l["node"] == reader for br in lconns.get(gate, {}).get("main", [])[idx:idx + 1] for l in br):
            ops.append({"type": "removeConnection", "source": gate, "target": reader,
                        "sourceIndex": idx, "targetIndex": 0})

    # 4. Retire the database feeders.
    for name in RETIRED:
        if name in live:
            ops.append({"type": "removeNode", "nodeName": name})
    return ops
```

Note for the implementer: step 2 removes a retyped node (dropping all its edges), so its restored edges are re-added after; step 3's `removeConnection` for `gate → reader` applies to a reader that was *not* retyped in this run. Run the tests after each helper and fix ordering until `test_migrating_the_old_graph_gives_the_built_graph` passes — that test is the contract.

Make `apply_offline` understand `removeNode`:

```python
        elif kind == "removeNode":
            name = op["nodeName"]
            wf["nodes"] = [n for n in wf["nodes"] if n["name"] != name]
            nodes.pop(name, None)
            conns.pop(name, None)
            for spec in conns.values():
                for brs in spec.values():
                    for br in brs:
                        br[:] = [c for c in br if c["node"] != name]
```

(and keep `nodes` consistent: `apply_offline` builds `nodes` once at the top; recompute `nodes = {...}` after `addNode`/`removeNode` already handled above.)

In `main()`: after loading `wf` (live or offline), compute the Sheets credential and call the migration before the report/availability blocks run:

```python
    target = bw.workflow(bw.build())
    mig = sheet_only_ops(wf, target, SHEETS_CRED)
    ops.extend(mig)
    for name in RETIRED + RETYPED:          # the rest of main() must see the migrated names
        have.discard(name) if name in RETIRED else None
```

(offline, `wf` is the base JSON, which already is sheet-only, so `mig` is parameter updates only; live, it is the real migration.) Replace the single `update_workflow` call at the end with batches:

```python
    for i, batch in enumerate(batches(ops)):
        print(f"\napplying operations {i * 90 + 1}-{i * 90 + len(batch)} of {len(ops)}…")
        print(pb.call_tool("update_workflow",
                           {"workflowId": pb.WORKFLOW_ID, "operations": batch})[:400])
```

and build `creds` bindings only for non-HTTP nodes (HTTP nodes carry theirs inline).

- [ ] **Step 5: Run to verify**

Run: `python -m pytest booking_bot -q 2>&1 | grep -E "^(FAILED|ERROR)|passed|failed" | head`
Expected: all pass. Run `node booking_bot/test_brain.mjs | tail -1` and `node booking_bot/test_sheet_lookup.mjs | tail -1`: `all checks passed`.

- [ ] **Step 6: Commit**

```bash
git add booking_bot/deploy_graph.py booking_bot/test_workflow.py
git commit -m "deploy_graph: the sheet-only migration, and no more shadow or reconcile branches" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Remove the dead files and references

**Files:** delete the retired node bodies and tests; update references.

- [ ] **Step 1: Find every reference**

Run: `git grep -n -E "build_shadow_write|build_snapshot_sql|build_reconcile_message|read_unmirrored|read_bookings_for_edit|read_locations|read_next_booking_id|test_shadow|test_reconcile|values_put_id|Write Line Id|Shadow Write" -- booking_bot README.md docs/HANDOFF.md | grep -v "bookings-bot.*\.json" | head -40`

- [ ] **Step 2: Delete**

```bash
git rm booking_bot/nodes/build_shadow_write.js booking_bot/nodes/build_snapshot_sql.js booking_bot/nodes/build_reconcile_message.js
git rm booking_bot/nodes/read_unmirrored.sql booking_bot/nodes/read_bookings_for_edit.sql booking_bot/nodes/read_locations.sql booking_bot/nodes/read_next_booking_id.sql
git rm booking_bot/test_shadow.mjs booking_bot/test_reconcile.mjs
```

- [ ] **Step 3: Fix the references the grep found**

- `build_workflow.py`: delete `values_put_id` if unused (and its docstring), and stale comments naming the shadow write / Phase 4b / `bot_sessions`.
- `sync_nodes.py`: remove the retired names from `DEFAULT_NODES` / `NEVER_DEFAULT` and its docstring.
- `nodes/build_line_rows.js`: the header comments that mention `Write Line Id` and column U: say column U is no longer written.
- `booking_bot/README.md`, `README.md`: the architecture diagram and the "mirror" paragraphs (Task 8 rewrites them; here only make the code comments true).
- `validate_workflow.py`: nothing should reference the removed files; run it.

- [ ] **Step 4: Verify**

Run: `python -m pytest booking_bot -q 2>&1 | tail -1`; `node booking_bot/test_brain.mjs | tail -1`; `node booking_bot/test_sheet_lookup.mjs | tail -1`; `node booking_bot/test_reports.mjs 2>&1 | tail -1`; `python booking_bot/build_workflow.py --print > /dev/null`.
Expected: all green, exit 0. If `test_reports.mjs` fails because a report builder assumed the SQL registry's room order or type, fix the builder minimally and add a case for a registry row with no room.

- [ ] **Step 5: Commit**

```bash
git add -A booking_bot
git status --short | head
git commit -m "Remove the shadow, reconcile and Postgres lookup files" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
(Before `git add -A booking_bot`, run `git clean -n` and delete any junk files; `-A` is scoped to `booking_bot`.)

---

### Task 7: Parity check against the live tab (read-only)

**Files:**
- Create: `booking_bot/lookup_cli.mjs`, `booking_bot/check_sheet_lookup.py`

**Interfaces:** `lookup_cli.mjs` reads `{formulas, values}` JSON (two `values.get` bodies) on stdin and prints the lookup rows as JSON; `check_sheet_lookup.py` fetches the live tab with the repo's `service_account.json` (read-only scope) and prints a summary.

- [ ] **Step 1: Write `booking_bot/lookup_cli.mjs`**

```js
/**
 * Run the real "Read Bookings For Edit" node body over two values.get responses.
 *
 *     echo '{"formulas":{...},"values":{...}}' | node booking_bot/lookup_cli.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'nodes', 'build_bookings_lookup.js'), 'utf8');
const input = JSON.parse(readFileSync(0, 'utf8'));
const $ = (name) => ({
  first: () => ({ json: name === 'Fetch Bookings Formulas' ? input.formulas : input.values }),
});
const rows = new Function('$', src)($).map(i => i.json);
process.stdout.write(JSON.stringify(rows));
```

- [ ] **Step 2: Write `booking_bot/check_sheet_lookup.py`**

```python
"""Read-only: what the new bookings lookup makes of the LIVE tab.

    python booking_bot/check_sheet_lookup.py            # summary
    python booking_bot/check_sheet_lookup.py --rows 36-42   # the rows themselves

Uses the repo's service_account.json (readonly scope) and the real node body, so
what it prints is what the bot will see. Nothing is written anywhere.
"""
import argparse
import json
import os
import subprocess
import sys

import gspread
from google.oauth2.service_account import Credentials

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
SHEET_ID = "1CiHciOeeyRMx9vz5cP0Xlid-jqM_gVjW3sUfore84S8"
TAB = "إدخال الحجوزات"


def key_file():
    for base in (os.path.dirname(HERE), os.environ.get("HOSTEL_REPO", "")):
        p = os.path.join(base, "service_account.json")
        if base and os.path.exists(p):
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
    payload = json.dumps({"formulas": {"values": formulas}, "values": {"values": values}}, ensure_ascii=False)
    out = subprocess.run(["node", os.path.join(HERE, "lookup_cli.mjs")], input=payload.encode("utf-8"),
                         capture_output=True, check=True).stdout.decode("utf-8")
    rows = json.loads(out)
    lines = [r for r in rows if r["lines"]]
    print(f"bookings read: {len(rows)} | with payment lines: {len(lines)} | open-ended: "
          f"{sum(1 for r in rows if r['عدد الليالي'] == '=OPEN')} | rate formulas: "
          f"{sum(1 for r in rows if r['total_is_formula'])}")
    bad_dates = [r["row_number"] for r in rows if r["تاريخ البداية"] and not __import__("re").match(r"^\d{4}-\d{2}-\d{2}$", r["تاريخ البداية"])]
    print("rows whose arrival is not an ISO date:", bad_dates or "none")
    ids = [r["ID"] for r in rows]
    print("carried-over / starred ids:", [i for i in ids if "*" in i] or "none", "| blank ids at rows:",
          [r["row_number"] for r in rows if r["ID"] == ""] or "none")
    if args.rows:
        lo, hi = map(int, args.rows.split("-"))
        for r in rows:
            if lo <= r["row_number"] <= hi:
                print(json.dumps({k: r[k] for k in ("row_number", "ID", "اسم المقيم", "اسم الشقة", "رقم الغرفة",
                                                      "عدد الليالي", "تاريخ البداية", "اجمالي سعر الحجز",
                                                      "اجمالي ما تم دفعه", "طريقة الدفع", "lines", "block_end")},
                                 ensure_ascii=False))


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Run it against the real tab**

Run: `HOSTEL_REPO=D:/hostel/bookings/bot python booking_bot/check_sheet_lookup.py --rows 36-42`
Expected: bookings read ≈ 54; rows 37, 38 and 39 are three bookings with no lines; row 41 is ID 29 (`محمد`) with paid 504 and row 42 is ID 30 (`عبدالنبي`) with paid 4210; "rows whose arrival is not an ISO date: none". Record the summary in the ledger. If a row looks wrong, fix `build_bookings_lookup.js` test-first (add the row's shape to `test_sheet_lookup.mjs`) before moving on.

- [ ] **Step 4: Commit**

```bash
git add booking_bot/lookup_cli.mjs booking_bot/check_sheet_lookup.py
git commit -m "A read-only parity check of the new lookup against the live tab" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Docs, generated files, final checks

**Files:** `README.md`, `booking_bot/README.md`, `docs/HANDOFF.md`, `supabase/README.md`, `webui/README.md`, the spec's status line, the two generated JSON files.

- [ ] **Step 1: Regenerate and validate**

```bash
python booking_bot/build_workflow.py
python booking_bot/deploy_graph.py --offline
python booking_bot/validate_workflow.py
python booking_bot/validate_workflow.py booking_bot/bookings-bot.full.workflow.json
python booking_bot/build_workflow.py --creds
```
Expected: both validations clean; `--creds` lists no `postgres` credential.

- [ ] **Step 2: Rewrite the docs**

- `README.md`: the architecture diagram becomes `Telegram ──► n8n workflow (brain.js) ──► Google Sheet (the only store)`; the `supabase/` and `webui/` rows say **Retired (2026-10-12): the bot no longer reads or writes them; kept for reference**; the "What the bot does" bullet about the mirror is removed; "Secrets" no longer mentions Supabase.
- `booking_bot/README.md`: replace the Postgres/Phase 4b/mirror text with: sessions in the Data Table (`bookings_bot_sessions`), lookups from the Sheets API, the three Code nodes and the parity script; rebuild instructions create the Data Table and need only the Telegram and Google credentials.
- `docs/HANDOFF.md`: new top entry `2026-10-12 — the bot no longer uses Postgres`: why (the wrong-row incident), what changed, the rollback version id, the retired nodes, the line-detection rule, the first-message checklist. Mark the Supabase sections as historical.
- `supabase/README.md`, `webui/README.md`: a top banner: retired; the bot does not use it; do not run `reindex.py`/`backfill.py` expecting them to affect the bot.
- Spec: change `**Status:**` to `Implemented 2026-10-12`.

- [ ] **Step 3: Run everything**

```bash
node booking_bot/test_brain.mjs | tail -1
node booking_bot/test_sheet_lookup.mjs | tail -1
node booking_bot/test_reports.mjs 2>&1 | tail -1
python -m pytest booking_bot -q 2>&1 | tail -1
git clean -n
```
Expected: three `all checks passed`, pytest green, only junk files listed by `git clean -n` (remove with `git clean -f`).

- [ ] **Step 4: Commit**

```bash
git add README.md booking_bot/README.md docs/HANDOFF.md supabase/README.md webui/README.md docs/superpowers/specs/2026-10-12-sheet-only-bot-design.md booking_bot/bookings-bot.workflow.json booking_bot/bookings-bot.full.workflow.json
git commit -m "Docs and generated workflow for the sheet-only bot" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Deploy to the live workflow, verify, publish, watch

**Files:** none. Evidence goes into the ledger and `docs/HANDOFF.md`.

- [ ] **Step 1: Record the rollback point**

`get_workflow_history` for `hzMYegbL3yifl7KN`; confirm the active version is `4555ef7a-38f1-4d4e-a1dc-f71038a6d6f8` and note it in the ledger.

- [ ] **Step 2: Apply to the draft**

```bash
N8N_WORKFLOW_ID=hzMYegbL3yifl7KN python booking_bot/deploy_graph.py > .superpowers/sdd/sheet-only-bot/deploy.txt 2>&1
N8N_WORKFLOW_ID=hzMYegbL3yifl7KN python booking_bot/push_brain.py > .superpowers/sdd/sheet-only-bot/push.txt 2>&1
```
Read the tails. Expected: each batch applies without an error; `push_brain` still reports `Brain` identical (no change). If a batch is refused, fix the operation, restore the draft with `restore_workflow_version` to the active version, and retry — the draft is not live.

- [ ] **Step 3: Verify the draft**

```bash
N8N_WORKFLOW_ID=hzMYegbL3yifl7KN python - <<'EOF'
```
(or an equivalent `python -c`; keep it a plain command) checking, against `get_workflow_details`:
- no node of type `n8n-nodes-base.postgres`;
- none of `POSTGRES_NAMES` present;
- `Load Session`, `Save Session`, `Clear Session` are Data Table nodes whose parameters equal `bw.session_params(...)`;
- the four lookup fetch nodes exist, carry `googleSheetsOAuth2Api` credentials with the live id, and `Fetch Locations` / `Fetch Booking Ids` are `executeOnce`;
- `Brain`'s inbound edges are exactly `AI Extract` and `Needs AI?`;
- every `$('Name')` in every Code node resolves to a node that exists;
- `Brain` equals `brain.js` byte for byte; the Config access lists and `BOT_TOKEN` are unchanged.

Run `validate_workflow` equivalents offline on the live JSON by saving `get_workflow_details` output to a file and running `python booking_bot/validate_workflow.py <file>`.

- [ ] **Step 4: Publish once, then watch**

`publish_workflow`; record the new `activeVersionId`. Then `search_workflow_executions` (limit 10) and, for any execution after the publish, read its node statuses with `inspect_exec.py`-style summarising (compact). Expected: no `error` nodes; `Load Session` returns an item; `Save Session` runs; the Data Table row for a real chat id appears (`get_data_table_rows`).

If any execution after the publish shows an error in a lookup, session or write node: `restore_workflow_version` to `4555ef7a…` immediately, `publish_workflow`, ledger what failed, and diagnose from the execution data before trying again.

- [ ] **Step 5: Hand-off checklist for the user (written into HANDOFF and the final message)**

`/start` → 🤖 or ✏️, an ID that exists, **إلغاء**: the card shows the right guest and nothing changes. Then one real payment on a booking of the user's choice and check the right row in the sheet.

- [ ] **Step 6: Push the branch and open the PR**

```bash
git push -u origin sheet-only-bot
gh pr create --base ai-booking-edit --head sheet-only-bot --title "Remove Postgres from the bot: it reads and writes only the sheet" --body-file <path to a body written with Write>
```
The PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-review

**Spec coverage:** §3 decisions → Tasks 1, 4, 5, 9; §4 graph table → Tasks 4-5; §5 reading a booking → Task 2; §6 next ID → Task 3; §7 registry → Tasks 3-5; §8 sessions → Tasks 1, 4, 5; §9 deploy → Task 9; §10 tests → Tasks 2-7; §11 risks → Task 9 (rollback, watch), Review Focus; §12 out of scope → Global Constraints.

**Placeholders:** the only deliberate "decide at run time" points are Task 1 outcomes (Data Table / HTTP credential), each with a stated fallback and ledger rule, and Task 5 Step 4's note that ordering is fixed against the contract test.

**Type consistency:** `lookup_node_specs()` returns 5-tuples used identically in Tasks 4 and 5; `session_params("get"|"save"|"clear")` used in Tasks 4-5 tests; `sheet_only_ops(wf, target, sheets_cred)` and `batches(ops, 90)` as the tests call them; `RETIRED`/`RETYPED`/`FETCHES` names as defined.
