import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { getPool, closePool } from "../src/index.js";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env") });

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const pool = getPool(url);
try {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS applied_migrations (name varchar(128) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const { rows } = await pool.query("SELECT name FROM applied_migrations");
  const applied = new Set(rows.map((r) => r.name as string));

  if (applied.size === 0) {
    const { rows: t } = await pool.query(
      "SELECT to_regclass('public.users') AS cls",
    );
    if (t[0]?.cls !== null) {
      await pool.query("INSERT INTO applied_migrations (name) VALUES ('0001_foundation')");
      applied.add("0001_foundation");
      console.log("baselined 0001_foundation (objects already present)");
    }
  }

  const files = readdirSync(root).filter((f) => f.endsWith(".sql")).sort();
  let count = 0;
  for (const f of files) {
    const name = f.replace(/\.sql$/, "");
    if (applied.has(name)) {
      console.log(`skipping ${f} (already applied)`);
      continue;
    }
    console.log(`applying ${f}`);
    await pool.query(readFileSync(join(root, f), "utf8"));
    await pool.query("INSERT INTO applied_migrations (name) VALUES ($1)", [name]);
    count++;
  }
  console.log(`applied ${count} migration(s)`);
} finally {
  await closePool();
}
