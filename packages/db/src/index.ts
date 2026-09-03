import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export * from "./schema.js";

let pool: Pool | undefined;

export function getPool(connectionString: string): Pool {
  if (!pool) {
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}

export function getDb(connectionString: string): NodePgDatabase<typeof schema> {
  return drizzle(getPool(connectionString), { schema });
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
