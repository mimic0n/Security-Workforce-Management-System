import { Injectable, Inject } from "@nestjs/common";
import { type GpsStreamPort, type GpsSample } from "./ports/gps-stream.port.js";
import { PresenceMonitorService } from "../modules/attendance/presence-monitor.service.js";

@Injectable()
export class MockGpsStreamAdapter implements GpsStreamPort {
  constructor(
    @Inject(PresenceMonitorService) private readonly presenceMonitor: PresenceMonitorService
  ) {}

  async sendGpsSample(sample: GpsSample): Promise<void> {
    await this.presenceMonitor.processPing({
      guardId: sample.guardId,
      postId: sample.postId,
      lat: sample.lat,
      lon: sample.lon,
      accuracy_m: sample.accuracy,
      timestamp: sample.timestamp
    });
  }
}
