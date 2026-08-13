import { Pool } from 'pg';

// One pool per lambda instance. The connection string must be the TRANSACTION
// pooler (port 6543): the direct db host publishes an AAAA record only and is
// unreachable from IPv4, which is what a Vercel function is on.
let pool;

export function dbConfigured() {
  return Boolean(process.env.SUPABASE_TRANSACTION_URL);
}

export function pgPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.SUPABASE_TRANSACTION_URL,
      ssl: { rejectUnauthorized: false },
      // Transaction pooling hands the server connection back after every
      // statement, so a big client-side pool buys nothing and costs slots.
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function q(text, params = []) {
  const { rows } = await pgPool().query(text, params);
  return rows;
}

export async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] ?? null;
}

export async function tx(fn) {
  const client = await pgPool().connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
