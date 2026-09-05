import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import helmet from "helmet";
import { HealthController } from "./health/health.controller.js";
import { DevicesController } from "./devices/devices.controller.js";
import { DevicesService } from "./devices/devices.service.js";
import { SessionsController } from "./sessions/sessions.controller.js";
import { SessionEventsController } from "./sessions/session-events.controller.js";
import { SessionsService } from "./sessions/sessions.service.js";
import { ReadingsController } from "./readings/readings.controller.js";
import { AuditController } from "./audit/audit.controller.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService } from "./auth/auth.service.js";
import { OrgsController } from "./orgs/orgs.controller.js";
import { OrgsService } from "./orgs/orgs.service.js";
import { ImportsController } from "./imports/imports.controller.js";
import { ImportsService } from "./imports/imports.service.js";
import { DawarichController } from "./dawarich/dawarich.controller.js";
import { DawarichService } from "./dawarich/dawarich.service.js";
import { ExportsController } from "./exports/exports.controller.js";
import { PushController } from "./push/push.controller.js";
import { PushService } from "./push/push.service.js";

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: "default", limit: 200, ttl: 60000 },
      { name: "auth", limit: 20, ttl: 60000 },
    ]),
  ],
  controllers: [
    HealthController,
    DevicesController,
    SessionsController,
    SessionEventsController,
    ReadingsController,
    AuditController,
    AuthController,
    OrgsController,
    ImportsController,
    DawarichController,
    ExportsController,
    PushController,
  ],
  providers: [
    DevicesService,
    SessionsService,
    AuthService,
    OrgsService,
    ImportsService,
    DawarichService,
    PushService,
    { provide: "PUSH_TRANSPORT", useValue: null },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(helmet()).forRoutes("*");
  }
}
