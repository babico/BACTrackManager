import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller.js";
import { DevicesController } from "./devices/devices.controller.js";
import { DevicesService } from "./devices/devices.service.js";
import { SessionsController } from "./sessions/sessions.controller.js";
import { SessionsService } from "./sessions/sessions.service.js";
import { ReadingsController } from "./readings/readings.controller.js";
import { AuditController } from "./audit/audit.controller.js";

@Module({
  controllers: [HealthController, DevicesController, SessionsController, ReadingsController, AuditController],
  providers: [DevicesService, SessionsService],
})
export class AppModule {}
