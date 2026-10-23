import { Injectable, Inject } from "@nestjs/common";
import { type GpsStreamPort, type GpsSample } from "./ports/gps-stream.port.js";
import { PresenceMonitorService } from "../modules/attendance/presence-monitor.service.js";
import { DatabaseService } from "../core/database/database.service.js";
import { CLOCK_TOKEN, type Clock } from "../core/clock/clock.interface.js";

@Injectable()
export class MockGpsStreamAdapter implements GpsStreamPort {
  constructor(
    @Inject(PresenceMonitorService) private readonly presenceMonitor: PresenceMonitorService,
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock
  ) {}

  async sendGpsSample(sample: GpsSample): Promise<void> {
    let postId = sample.postId;
    if (!postId) {
      // Look up guard's current post
      const res = await this.db.query(
        `SELECT post_id FROM post_state WHERE guard_id = $1 LIMIT 1;`,
        [sample.guardId]
      );
      if (res.rows.length > 0) {
        postId = res.rows[0].post_id;
      } else {
        const assignRes = await this.db.query(
          `SELECT post_id FROM assignments WHERE guard_id = $1 AND status = 'ACTIVE' LIMIT 1;`,
          [sample.guardId]
        );
        if (assignRes.rows.length > 0) {
          postId = assignRes.rows[0].post_id;
        } else {
          throw new Error(`Guard ${sample.guardId} has no active post assigned`);
        }
      }
    }

    let timestamp = sample.timestamp;
    if (!timestamp) {
      const now = this.clock.now();
      if (sample.atOffsetSec !== undefined) {
        timestamp = new Date(now.getTime() + sample.atOffsetSec * 1000);
      } else {
        timestamp = now;
      }
    }

    await this.presenceMonitor.processPing({
      guardId: sample.guardId,
      postId: postId!,
      lat: sample.lat,
      lon: sample.lon,
      accuracy_m: sample.accuracy ?? 10,
      timestamp
    });
  }
}
