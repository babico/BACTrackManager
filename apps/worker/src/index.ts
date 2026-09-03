import { loadConfig } from "./config.js";
import { expireDueSessions } from "./sweeper.js";
import { prunePublished } from "./outbox.js";

async function pass(url: string, retentionDays: number): Promise<void> {
  const swept = await expireDueSessions(url);
  const pruned = await prunePublished(url, retentionDays);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ at: new Date().toISOString(), ...swept, ...pruned }));
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.RUN_ONCE) {
    await pass(config.DATABASE_URL, config.OUTBOX_RETENTION_DAYS);
    return;
  }
  let stopped = false;
  const shutdown = () => {
    stopped = true;
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  while (!stopped) {
    try {
      await pass(config.DATABASE_URL, config.OUTBOX_RETENTION_DAYS);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("worker pass failed", err);
    }
    await new Promise((r) => setTimeout(r, config.SWEEP_INTERVAL_MS));
  }
}

void main();
