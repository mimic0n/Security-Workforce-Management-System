import { Module } from "@nestjs/common";
import { DatabaseModule } from "./core/database/database.module.js";
import { AuthModule } from "./core/auth/auth.module.js";
import { ClockModule } from "./core/clock/clock.module.js";
import { AuditModule } from "./core/audit/audit.module.js";
import { EventsModule } from "./core/events/event-bus.service.js";
import { ScheduledJobsModule } from "./core/jobs/scheduled-jobs.module.js";
import { GuardsModule } from "./modules/guards/guards.module.js";
import { PostsModule } from "./modules/posts/posts.module.js";
import { PoliciesModule } from "./modules/policies/policies.module.js";
import { StaffingModule } from "./modules/staffing/staffing.module.js";
import { DispatchModule } from "./modules/dispatch/dispatch.module.js";
import { AttendanceModule } from "./modules/attendance/attendance.module.js";

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    ClockModule,
    AuditModule,
    EventsModule,
    ScheduledJobsModule,
    GuardsModule,
    PostsModule,
    PoliciesModule,
    StaffingModule,
    DispatchModule,
    AttendanceModule
  ]
})
export class AppModule {}

