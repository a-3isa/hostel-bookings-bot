/**
 * Run the real "Read Bookings For Edit" node body over two values.get responses.
 *
 *     echo '{"formulas":{...},"values":{...}}' | node booking_bot/lookup_cli.mjs
 *
 * Used by check_sheet_lookup.py to show what the bot would see on the live tab.
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
