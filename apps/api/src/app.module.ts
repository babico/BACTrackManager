import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller.js";
import { DevicesController } from "./devices/devices.controller.js";
import { DevicesService } from "./devices/devices.service.js";
import { SessionsController } from "./sessions/sessions.controller.js";
import { SessionsService } from "./sessions/sessions.service.js";

@Module({
  controllers: [HealthController, DevicesController, SessionsController],
  providers: [DevicesService, SessionsService],
})
export class AppModule {}
