import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3001),
  API_VERSION: z.string().default("0.1.0"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DEV_USER_ID: z.string().uuid().optional(),
  DEV_ORG_ID: z.string().uuid().optional(),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return schema.parse(env);
}
