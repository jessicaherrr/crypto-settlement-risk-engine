import 'server-only';

import { Pool } from 'pg';

// The same Postgres `DATABASE_URL` the Go chain indexer writes confirmed
// state to (services/chain-indexer, see database/migrations/). Reading
// through this pool - not a separate Supabase project - is what makes
// "the dashboard shows what the indexer confirmed" actually true: a
// hosted Supabase database the indexer never touches would just be a
// second, perpetually-stale copy of the schema.
//
// Never imported by a client component - `server-only` makes that a
// build error, not just a convention.
const DEFAULT_LOCAL_DATABASE_URL = 'postgres://askgene:askgene@localhost:5432/askgene_quantfi';

declare global {
  // eslint-disable-next-line no-var
  var __askgenePgPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL || DEFAULT_LOCAL_DATABASE_URL;
  return new Pool({ connectionString, max: 10 });
}

// Next.js dev reloads this module on every request; a module-level `Pool`
// would otherwise leak a new connection pool per reload. Stashing it on
// `global` survives the reload.
export const pool = global.__askgenePgPool ?? createPool();
if (process.env.NODE_ENV !== 'production') {
  global.__askgenePgPool = pool;
}

export async function query<T extends object = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function queryOne<T extends object = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}
