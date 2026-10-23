import { Injectable, Inject, OnModuleInit } from "@nestjs/common";
import { CLOCK_TOKEN, type Clock } from "../../core/clock/clock.interface.js";
import { DatabaseService } from "../../core/database/database.service.js";
import { ConfigService } from "../policies/config.service.js";
import { ScheduledJobsService } from "../../core/jobs/scheduled-jobs.service.js";
import { DispatchService } from "../dispatch/dispatch.service.js";
import { FillVacancyService } from "../dispatch/engine/fill-vacancy.service.js";
import { RankingService } from "../dispatch/engine/ranking.service.js";
import { DebounceFilter, type DebounceResult } from "./debounce-filter.js";

export interface PresencePingResult extends DebounceResult {
  postId: string;
  guardId: number;
}

@Injectable()
export class PresenceMonitorService implements OnModuleInit {
  private readonly filters = new Map<string, DebounceFilter>();

  constructor(
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(ScheduledJobsService) private readonly scheduledJobs: ScheduledJobsService,
    @Inject(DispatchService) private readonly dispatchService: DispatchService,
    @Inject(FillVacancyService) private readonly fillVacancyService: FillVacancyService,
    @Inject(RankingService) private readonly rankingService: RankingService
  ) {}

  onModuleInit(): void {
    // Register handlers for presence escalation jobs
    this.scheduledJobs.registerHandler("presence.prewarm", async (job) => {
      await this.handlePrewarmJob(job.data);
    });

    this.scheduledJobs.registerHandler("presence.escalate", async (job) => {
      await this.handleEscalateJob(job.data);
    });

    this.scheduledJobs.registerHandler("presence.violation", async (job) => {
      await this.handleViolationJob(job.data);
    });
  }

  private async getPolicy<T>(key: string, defaultValue: T, atTime?: Date): Promise<T> {
    try {
      const val = await this.configService.get<T>(key, atTime);
      return val !== undefined && val !== null ? val : defaultValue;
    } catch {
      return defaultValue;
    }
  }

  private getFilterKey(guardId: number, postId: string): string {
    return `${guardId}:${postId}`;
  }

  public resetFilter(guardId?: number, postId?: string): void {
    if (guardId !== undefined && postId !== undefined) {
      this.filters.delete(this.getFilterKey(guardId, postId));
    } else {
      this.filters.clear();
    }
  }

  /**
   * Process a GPS ping sample through the debounce filter.
   */
  async processPing(params: {
    guardId: number;
    postId: string;
    lat: number;
    lon: number;
    accuracy_m: number;
    timestamp?: Date;
  }): Promise<PresencePingResult> {
    const now = params.timestamp || this.clock.now();
    const { guardId, postId, lat, lon, accuracy_m } = params;

    // 1. Fetch post center and geofence
    const postRes = await this.db.query(
      `SELECT id, lat, lon, geofence_m FROM posts WHERE id = $1;`,
      [postId]
    );

    if (postRes.rowCount === 0) {
      return {
        accepted: false,
        filtered: true,
        state: "INSIDE",
        distance_m: 0,
        consecutiveOutside: 0,
        transitionedToOutside: false,
        transitionedToInside: false,
        postId,
        guardId,
        reason: `Post ${postId} not found`
      };
    }

    const post = postRes.rows[0];
    const postCenter = {
      lat: post.lat ?? 16.065,
      lon: post.lon ?? 108.202
    };

    // 2. Fetch policies dynamically
    const gpsAccuracyMaxM = await this.getPolicy<number>("attendance.gps_accuracy_max_m", 30, now);
    const outSamplesRequired = await this.getPolicy<number>("attendance.out_samples_required", 3, now);

    // 3. Get or create DebounceFilter instance
    const key = this.getFilterKey(guardId, postId);
    let filter = this.filters.get(key);
    if (!filter) {
      filter = new DebounceFilter({
        geofenceM: post.geofence_m ?? 25,
        gpsAccuracyMaxM,
        outSamplesRequired,
        leaveRadiusMultiplier: 1.5
      });
      this.filters.set(key, filter);
    }

    // 4. Process sample through debounce filter
    const result = filter.processSample({ lat, lon, accuracy_m, timestamp: now }, postCenter);

    // 5. Handle transitions
    if (result.transitionedToOutside) {
      await this.handlePresenceLost(guardId, postId, now);
    } else if (result.transitionedToInside) {
      await this.handlePresenceRestored(guardId, postId);
    }

    return {
      ...result,
      postId,
      guardId
    };
  }

  /**
   * Called when debounce filter confirms presence is lost (t0).
   * Initiates UNCERTAIN state and schedules escalation jobs.
   */
  async handlePresenceLost(guardId: number, postId: string, t0: Date): Promise<void> {
    const client = await this.db.getClient();
    try {
      await client.query("BEGIN;");

      const stateRes = await client.query(
        `SELECT ps.status, pr.tier, pr.max_vacant_sec, ps.guard_id, p.site_id
         FROM post_state ps
         JOIN posts p ON ps.post_id = p.id
         JOIN post_rules pr ON ps.post_id = pr.post_id
         WHERE ps.post_id = $1
         FOR UPDATE;`,
        [postId]
      );

      if (stateRes.rowCount === 0) {
        await client.query("ROLLBACK;");
        return;
      }

      const { status, tier, max_vacant_sec, site_id } = stateRes.rows[0];

      // Only transition if currently OCCUPIED
      if (status === "OCCUPIED") {
        await this.dispatchService.apply(client, {
          siteId: site_id || "AEON_THANH_KHE_F1",
          kind: "PRESENCE_UNCERTAIN",
          postId,
          actorId: guardId,
          simTs: t0,
          payload: { guardId }
        });
      }

      await client.query("COMMIT;");

      // Dynamic durations from policies
      const uncertainAfterSec = await this.getPolicy<number>("attendance.uncertain_after_sec", 45, t0);
      const tier1EscalateSec = await this.getPolicy<number>("attendance.tier1_escalate_after_sec", 120, t0);
      const violationAfterSec = await this.getPolicy<number>("attendance.violation_after_sec", 600, t0);

      const escalateDelaySec = tier === "TIER1" ? tier1EscalateSec : (max_vacant_sec || 900);

      const prewarmAt = new Date(t0.getTime() + uncertainAfterSec * 1000);
      const escalateAt = new Date(t0.getTime() + escalateDelaySec * 1000);
      const violationAt = new Date(t0.getTime() + violationAfterSec * 1000);

      // Schedule Stage 1: Pre-warm candidate & notify dispatcher
      await this.scheduledJobs.schedule(
        "presence.prewarm",
        { postId, guardId, t0: t0.toISOString() },
        prewarmAt,
        { key: `presence_prewarm_${postId}_${guardId}` }
      );

      // Schedule Stage 2: Escalate to VACANT_ALERT & fillVacancy
      await this.scheduledJobs.schedule(
        "presence.escalate",
        { postId, guardId, t0: t0.toISOString() },
        escalateAt,
        { key: `presence_escalate_${postId}_${guardId}` }
      );

      // Schedule Stage 3: Record VIOLATION incident
      await this.scheduledJobs.schedule(
        "presence.violation",
        { postId, guardId, t0: t0.toISOString() },
        violationAt,
        { key: `presence_violation_${postId}_${guardId}` }
      );
    } catch (err) {
      await client.query("ROLLBACK;");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Called when QR is confirmed or guard returns inside geofence before escalation.
   */
  async handlePresenceRestored(guardId: number, postId: string): Promise<void> {
    // 1. Cancel pending escalation jobs
    await this.scheduledJobs.cancel(`presence_prewarm_${postId}_${guardId}`);
    await this.scheduledJobs.cancel(`presence_escalate_${postId}_${guardId}`);
    await this.scheduledJobs.cancel(`presence_violation_${postId}_${guardId}`);

    // 2. Reset filter state to INSIDE
    const key = this.getFilterKey(guardId, postId);
    const filter = this.filters.get(key);
    if (filter) {
      filter.reset("INSIDE");
    }
  }

  /**
   * Job Stage 1: Pre-warm candidate pool at t0 + uncertain_after_sec (45s).
   */
  private async handlePrewarmJob(data: { postId: string; guardId: number; t0: string }): Promise<void> {
    const { postId } = data;
    const postRes = await this.db.query(
      `SELECT status FROM post_state WHERE post_id = $1;`,
      [postId]
    );

    if (postRes.rowCount === 0 || postRes.rows[0].status !== "UNCERTAIN") {
      // Guard already confirmed or resolved
      return;
    }

    // Pre-warm: identify best replacement candidate (without dispatching order)
    try {
      const floatsRes = await this.db.query(
        `SELECT id, code, role, float_kind, ot_minutes_month
         FROM guards
         WHERE role = 'FLOAT' AND active = true;`
      );
      const candidates = floatsRes.rows.map((g) => ({
        id: Number(g.id),
        code: g.code,
        role: g.role,
        floatKind: g.float_kind,
        otMinutesMonth: Number(g.ot_minutes_month || 0),
        dispatchesToday: 0
      }));
      await this.rankingService.rankCandidates(candidates, postId, {
        atTime: this.clock.now()
      });
    } catch {
      // ignore
    }
  }

  /**
   * Job Stage 2: Escalate to VACANT_ALERT and fillVacancy at t0 + escalate_sec.
   */
  private async handleEscalateJob(data: { postId: string; guardId: number; t0: string }): Promise<void> {
    const { postId } = data;
    const client = await this.db.getClient();

    try {
      await client.query("BEGIN;");

      const postRes = await client.query(
        `SELECT ps.status, pr.tier, p.site_id
         FROM post_state ps
         JOIN posts p ON ps.post_id = p.id
         JOIN post_rules pr ON ps.post_id = pr.post_id
         WHERE ps.post_id = $1
         FOR UPDATE;`,
        [postId]
      );

      if (postRes.rowCount === 0) {
        await client.query("ROLLBACK;");
        return;
      }

      const { status, site_id } = postRes.rows[0];

      // Only escalate if still UNCERTAIN
      if (status !== "UNCERTAIN") {
        await client.query("ROLLBACK;");
        return;
      }

      const now = this.clock.now();

      // 1. Transition UNCERTAIN -> VACANT_ALERT
      await this.dispatchService.apply(client, {
        siteId: site_id || "AEON_THANH_KHE_F1",
        kind: "ESCALATE_TIMEOUT",
        postId,
        simTs: now,
        payload: { postId }
      });

      // 2. Determine shift key (format: YYYY-MM-DD:SHIFT)
      const dateStr = now.toISOString().slice(0, 10);
      const hours = (now.getUTCHours() + 7) % 24;
      const shiftCode = hours >= 6 && hours < 14 ? "MORNING" : hours >= 14 && hours < 22 ? "AFTERNOON" : "NIGHT";
      const shiftKey = `${dateStr}:${shiftCode}`;

      // 3. Trigger fillVacancy immediately
      await this.fillVacancyService.fillVacancy(client, {
        postId,
        shiftKey,
        siteId: site_id,
        now,
        idemKey: `escalate_fill_${postId}_${now.getTime()}`
      });

      await client.query("COMMIT;");
    } catch (err) {
      await client.query("ROLLBACK;");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Job Stage 3: Record VIOLATION incident at t0 + violation_after_sec (600s).
   */
  private async handleViolationJob(data: { postId: string; guardId: number; t0: string }): Promise<void> {
    const { postId, guardId, t0 } = data;
    const now = this.clock.now();

    // Check if the original guard has an accepted QR confirmation since t0
    const checkRes = await this.db.query(
      `SELECT id FROM attendance_logs
       WHERE guard_id = $1 AND post_id = $2 AND kind = 'QR_CONFIRM' AND accepted = true AND sim_ts >= $3
       LIMIT 1;`,
      [guardId, postId, t0]
    );

    if (checkRes.rowCount && checkRes.rowCount > 0) {
      // Guard verified presence, no violation
      return;
    }

    // Record incident VIOLATION (§10.2: "at +10 min a VIOLATION incident exists")
    await this.db.query(
      `INSERT INTO incidents (kind, post_id, guard_id, severity, opened_at, details)
       VALUES ('VIOLATION', $1, $2, 'HIGH', $3, $4);`,
      [
        postId,
        guardId,
        now,
        JSON.stringify({
          reason: "UNCONFIRMED_PRESENCE_VIOLATION",
          vacantSince: t0,
          detectedAt: now.toISOString()
        })
      ]
    );
  }
}
