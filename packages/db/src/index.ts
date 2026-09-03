import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export * from "./schema.js";
export { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";

const pools = new Map<string, Pool>();

export function getPool(connectionString: string): Pool {
  const existing = pools.get(connectionString);
  if (existing) return existing;
  const created = new Pool({ connectionString, max: 10 });
  pools.set(connectionString, created);
  return created;
}

export function getDb(connectionString: string): NodePgDatabase<typeof schema> {
  return drizzle(getPool(connectionString), { schema });
}

export async function closePool(connectionString?: string): Promise<void> {
  if (connectionString) {
    await pools.get(connectionString)?.end();
    pools.delete(connectionString);
    return;
  }
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}
