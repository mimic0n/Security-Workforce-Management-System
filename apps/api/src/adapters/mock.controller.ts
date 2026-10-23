import { Controller, Post, Body, Inject } from "@nestjs/common";
import { CAMERA_AI_PORT, type CameraAiPort } from "./ports/camera-ai.port.js";
import { FIRE_ALARM_PORT, type FireAlarmPort } from "./ports/fire-alarm.port.js";
import { GPS_STREAM_PORT, type GpsStreamPort } from "./ports/gps-stream.port.js";

@Controller("api/mock")
export class MockController {
  constructor(
    @Inject(CAMERA_AI_PORT) private readonly cameraAi: CameraAiPort,
    @Inject(FIRE_ALARM_PORT) private readonly fireAlarm: FireAlarmPort,
    @Inject(GPS_STREAM_PORT) private readonly gpsStream: GpsStreamPort
  ) {}

  @Post("camera-ai")
  async mockCameraAi(
    @Body() body: { postId: string; confidence?: number; atTime?: string }
  ) {
    const atTime = body.atTime ? new Date(body.atTime) : undefined;
    const result = await this.cameraAi.reportMotion({
      postId: body.postId,
      confidence: body.confidence,
      atTime
    });
    return { ok: true, result };
  }

  @Post("fire-alarm")
  async mockFireAlarm(@Body() body: { zone?: string }) {
    const result = await this.fireAlarm.triggerAlarm(body?.zone || "FLOOR1");
    return { ok: true, result };
  }

  @Post("fire-alarm/clear")
  async mockFireAlarmClear() {
    const result = await this.fireAlarm.clearAlarm();
    return { ok: true, result };
  }

  @Post("gps-stream")
  async mockGpsStream(
    @Body()
    body: {
      guardId: number;
      lat: number;
      lon: number;
      accuracy?: number;
      postId?: string;
      atOffsetSec?: number;
      timestamp?: string;
    }
  ) {
    await this.gpsStream.sendGpsSample({
      guardId: body.guardId,
      lat: body.lat,
      lon: body.lon,
      accuracy: body.accuracy ?? 10,
      postId: body.postId,
      atOffsetSec: body.atOffsetSec,
      timestamp: body.timestamp ? new Date(body.timestamp) : undefined
    });
    return { ok: true };
  }
}
