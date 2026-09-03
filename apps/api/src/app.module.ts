import { Module } from "@nestjs/common";
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

@Module({
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
  ],
  providers: [DevicesService, SessionsService, AuthService, OrgsService, ImportsService, DawarichService],
})
export class AppModule {}
