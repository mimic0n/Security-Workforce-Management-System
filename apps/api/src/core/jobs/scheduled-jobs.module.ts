import { Global, Module } from "@nestjs/common";
import { ScheduledJobsService } from "./scheduled-jobs.service.js";
import { ClockModule } from "../clock/clock.module.js";
import { DatabaseModule } from "../database/database.module.js";

@Global()
@Module({
  imports: [ClockModule, DatabaseModule],
  providers: [ScheduledJobsService],
  exports: [ScheduledJobsService]
})
export class ScheduledJobsModule {}
