import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  OUTBOX_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  RUN_ONCE: z.coerce.boolean().default(false),
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return schema.parse(env);
}
