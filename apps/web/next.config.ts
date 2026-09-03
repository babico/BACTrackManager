import type { NextConfig } from "next";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const config: NextConfig = {
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
};
export default config;
