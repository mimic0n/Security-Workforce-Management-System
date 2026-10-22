import { Module } from "@nestjs/common";
import { PoliciesController } from "./policies.controller.js";
import { PoliciesService } from "./policies.service.js";
import { ConfigService } from "./config.service.js";
import { DatabaseModule } from "../../core/database/database.module.js";
import { ClockModule } from "../../core/clock/clock.module.js";
import { AuditModule } from "../../core/audit/audit.module.js";
import { EventsModule } from "../../core/events/event-bus.service.js";

@Module({
  imports: [DatabaseModule, ClockModule, AuditModule, EventsModule],
  controllers: [PoliciesController],
  providers: [ConfigService, PoliciesService],
  exports: [ConfigService, PoliciesService]
})
export class PoliciesModule {}
