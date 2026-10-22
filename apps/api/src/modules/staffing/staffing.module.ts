import { Module } from "@nestjs/common";
import { StaffingService } from "./staffing.service.js";
import { StaffingController } from "./staffing.controller.js";
import { DatabaseModule } from "../../core/database/database.module.js";
import { ClockModule } from "../../core/clock/clock.module.js";
import { PoliciesModule } from "../policies/policies.module.js";

@Module({
  imports: [DatabaseModule, ClockModule, PoliciesModule],
  controllers: [StaffingController],
  providers: [StaffingService],
  exports: [StaffingService]
})
export class StaffingModule {}
