import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { getPool, closePool } from "../src/index.js";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env") });

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const expectedTables = [
  "users", "organizations", "organization_memberships", "team_invites",
  "devices", "test_sessions", "device_leases", "bac_readings", "audit_log",
  "bactrack_identities", "magic_links", "outbox", "refresh_tokens", "consumer_imports", "dawarich_connections", "push_subscriptions",
];
const expectedIndexes = [
  "uq_membership_org_user", "uq_session_client", "uq_lease_one_holder",
  "uq_identity_provider_user",
];

let failed = 0;
const pool = getPool(url);

try {
const { rows: tables } = await pool.query(
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
);
const have = new Set(tables.map((r) => r.tablename as string));
for (const t of expectedTables) {
  const ok = have.has(t);
  console.log(`${ok ? "PASS" : "FAIL"} table ${t}`);
  if (!ok) failed++;
}

const { rows: idx } = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'");
const haveIdx = new Set(idx.map((r) => r.indexname as string));
for (const i of expectedIndexes) {
  const ok = haveIdx.has(i);
  console.log(`${ok ? "PASS" : "FAIL"} index ${i}`);
  if (!ok) failed++;
}

const { rows: mig } = await pool.query("SELECT name FROM applied_migrations ORDER BY 1");
console.log(`PASS ledger rows: ${mig.map((r) => r.name).join(",")}`);
if (!mig.some((r) => r.name === "0001_foundation")) { console.log("FAIL ledger missing 0001_foundation"); failed++; }

const { rows: ix2 } = await pool.query(
  "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='ix_readings_session'",
);
console.log(`${ix2.length === 1 ? "PASS" : "FAIL"} index ix_readings_session`);
if (ix2.length !== 1) failed++;
} finally {
  await closePool();
}
if (failed > 0) {
  console.error(`${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
