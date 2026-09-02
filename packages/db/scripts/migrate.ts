import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const pool = getPool(url);
const files = readdirSync(root).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) {
  console.log(`applying ${f}`);
  await pool.query(readFileSync(join(root, f), "utf8"));
}
console.log(`applied ${files.length} migration(s)`);
await closePool();
