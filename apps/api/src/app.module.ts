import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller.js";
import { DevicesController } from "./devices/devices.controller.js";
import { DevicesService } from "./devices/devices.service.js";

@Module({ controllers: [HealthController, DevicesController], providers: [DevicesService] })
export class AppModule {}
