import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3001),
  API_VERSION: z.string().default("0.1.0"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DEV_USER_ID: z.string().uuid().optional(),
  DEV_ORG_ID: z.string().uuid().optional(),
  JWT_SECRET: z.string().min(32),
  TOKEN_ENC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  BACTRACK_DOMAIN: z.string().url().default("https://login.bactrack.com"),
  BACTRACK_CLIENT_ID: z.string().min(1).optional(),
  BACTRACK_AUDIENCE: z.string().default("https://api.bactrack.com"),
  BACTRACK_API: z.string().url().default("https://consumer-api.bactrack.com"),
  ALLOW_DEV_MAGIC_TOKEN: z.coerce.boolean().default(false),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return schema.parse(env);
}
