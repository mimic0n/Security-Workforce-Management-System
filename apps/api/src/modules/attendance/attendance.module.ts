import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { ClockModule } from "../../core/clock/clock.module.js";
import { PoliciesModule } from "../policies/policies.module.js";
import { ScheduledJobsModule } from "../../core/jobs/scheduled-jobs.module.js";
import { DispatchModule } from "../dispatch/dispatch.module.js";
import { QrService } from "./qr.service.js";
import { PresenceMonitorService } from "./presence-monitor.service.js";
import { AttendanceService } from "./attendance.service.js";
import { AttendanceController } from "./attendance.controller.js";
import { GPS_STREAM_PORT } from "../../adapters/ports/gps-stream.port.js";
import { MockGpsStreamAdapter } from "../../adapters/mock-gps-stream.adapter.js";

@Module({
  imports: [
    DatabaseModule,
    ClockModule,
    PoliciesModule,
    ScheduledJobsModule,
    DispatchModule
  ],
  controllers: [AttendanceController],
  providers: [
    QrService,
    PresenceMonitorService,
    AttendanceService,
    MockGpsStreamAdapter,
    {
      provide: GPS_STREAM_PORT,
      useClass: MockGpsStreamAdapter
    }
  ],
  exports: [
    AttendanceService,
    PresenceMonitorService,
    QrService,
    GPS_STREAM_PORT
  ]
})
export class AttendanceModule {}
