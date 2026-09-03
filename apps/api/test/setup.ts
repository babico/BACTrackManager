// Loads repo-root .env for local runs (turbo spawns workers without shell env).
// Never overrides real environment variables — CI keeps working.
import { config } from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env") });
