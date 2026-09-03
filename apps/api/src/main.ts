import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { HttpErrorFilter } from "./common/http-error.filter.js";
import { loadConfig } from "./config.js";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new HttpErrorFilter());
  app.enableCors({
    origin: config.ALLOWED_ORIGINS.split(",").map((o) => o.trim()),
    allowedHeaders: ["Content-Type", "Authorization", "x-org-id"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.listen(config.PORT);
  // eslint-disable-next-line no-console
  console.log(`api listening on ${config.PORT}`);
}

void bootstrap();
