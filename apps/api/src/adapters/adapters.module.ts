import { Module, Global } from "@nestjs/common";
import { GPS_STREAM_PORT } from "./ports/gps-stream.port.js";
import { MockGpsStreamAdapter } from "./mock-gps-stream.adapter.js";
import { RealGpsStreamAdapter } from "./real-gps-stream.adapter.js";

import { CAMERA_AI_PORT } from "./ports/camera-ai.port.js";
import { MockCameraAiAdapter } from "./mock-camera-ai.adapter.js";
import { RealCameraAiAdapter } from "./real-camera-ai.adapter.js";

import { FIRE_ALARM_PORT } from "./ports/fire-alarm.port.js";
import { MockFireAlarmAdapter } from "./mock-fire-alarm.adapter.js";
import { RealFireAlarmAdapter } from "./real-fire-alarm.adapter.js";

import { NOTIFY_PORT } from "./ports/notify.port.js";
import { MockNotifyAdapter } from "./mock-notify.adapter.js";
import { RealNotifyAdapter } from "./real-notify.adapter.js";

import { MockController } from "./mock.controller.js";
import { AttendanceModule } from "../modules/attendance/attendance.module.js";
import { DispatchModule } from "../modules/dispatch/dispatch.module.js";

@Global()
@Module({
  imports: [AttendanceModule, DispatchModule],
  controllers: [MockController],
  providers: [
    MockGpsStreamAdapter,
    RealGpsStreamAdapter,
    {
      provide: GPS_STREAM_PORT,
      useExisting: MockGpsStreamAdapter
    },
    MockCameraAiAdapter,
    RealCameraAiAdapter,
    {
      provide: CAMERA_AI_PORT,
      useExisting: MockCameraAiAdapter
    },
    MockFireAlarmAdapter,
    RealFireAlarmAdapter,
    {
      provide: FIRE_ALARM_PORT,
      useExisting: MockFireAlarmAdapter
    },
    MockNotifyAdapter,
    RealNotifyAdapter,
    {
      provide: NOTIFY_PORT,
      useExisting: MockNotifyAdapter
    }
  ],
  exports: [
    GPS_STREAM_PORT,
    MockGpsStreamAdapter,
    RealGpsStreamAdapter,
    CAMERA_AI_PORT,
    MockCameraAiAdapter,
    RealCameraAiAdapter,
    FIRE_ALARM_PORT,
    MockFireAlarmAdapter,
    RealFireAlarmAdapter,
    NOTIFY_PORT,
    MockNotifyAdapter,
    RealNotifyAdapter
  ]
})
export class AdaptersModule {}
