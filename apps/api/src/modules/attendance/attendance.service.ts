import { Injectable, Inject, BadRequestException, NotFoundException } from "@nestjs/common";
import crypto from "node:crypto";
import {
  AttendanceCheckRequest,
  AttendanceCheckResponse,
  AttendanceNonceResponse
} from "@swms/contracts";
import { CLOCK_TOKEN, type Clock } from "../../core/clock/clock.interface.js";
import { DatabaseService } from "../../core/database/database.service.js";
import { ConfigService } from "../policies/config.service.js";
import { DispatchService } from "../dispatch/dispatch.service.js";
import { QrService } from "./qr.service.js";
import { PresenceMonitorService } from "./presence-monitor.service.js";
import { calculateHaversineDistance } from "./debounce-filter.js";

@Injectable()
export class AttendanceService {
  constructor(
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(DispatchService) private readonly dispatchService: DispatchService,
    @Inject(QrService) private readonly qrService: QrService,
    @Inject(PresenceMonitorService) private readonly presenceMonitor: PresenceMonitorService
  ) {}

  private async getPolicy<T>(key: string, defaultValue: T, atTime?: Date): Promise<T> {
    try {
      const val = await this.configService.get<T>(key, atTime);
      return val !== undefined && val !== null ? val : defaultValue;
    } catch {
      return defaultValue;
    }
  }

  /**
   * 10.1 Issue single-use short-lived nonce tied to (guard, device, post).
   */
  async createNonce(params: {
    postId: string;
    guardId: number;
    deviceUid?: string;
  }): Promise<AttendanceNonceResponse> {
    const { postId, guardId } = params;
    const now = this.clock.now();

    // 1. Verify post exists
    const postRes = await this.db.query(`SELECT id FROM posts WHERE id = $1;`, [postId]);
    if (postRes.rowCount === 0) {
      throw new NotFoundException(`Post ${postId} not found`);
    }

    // 2. Resolve and verify deviceUid
    let deviceUid = params.deviceUid;
    if (!deviceUid) {
      const devRes = await this.db.query(
        `SELECT device_uid FROM devices WHERE guard_id = $1 AND active = true LIMIT 1;`,
        [guardId]
      );
      if (devRes.rowCount === 0) {
        throw new BadRequestException(`No active device found for guard ${guardId}`);
      }
      deviceUid = devRes.rows[0].device_uid;
    } else {
      const devCheck = await this.db.query(
        `SELECT id FROM devices WHERE guard_id = $1 AND device_uid = $2 AND active = true;`,
        [guardId, deviceUid]
      );
      if (devCheck.rowCount === 0) {
        throw new BadRequestException(`Device ${deviceUid} is not registered or active for guard ${guardId}`);
      }
    }

    // 3. TTL from policy attendance.nonce_ttl_sec (default 45s)
    const ttlSec = await this.getPolicy<number>("attendance.nonce_ttl_sec", 45, now);
    const expiresAt = new Date(now.getTime() + ttlSec * 1000);
    const nonce = crypto.randomUUID();

    // 4. Store in attendance_nonces
    await this.db.query(
      `INSERT INTO attendance_nonces (nonce, guard_id, device_uid, post_id, expires_at)
       VALUES ($1, $2, $3, $4, $5);`,
      [nonce, guardId, deviceUid, postId, expiresAt]
    );

    return {
      nonce,
      expiresAt: expiresAt.toISOString(),
      ttlSec
    };
  }

  /**
   * 10.1 Verify check-in/out attempt:
   * Nonce check, device check, QR HMAC check, impossible-travel, geofence, and emit state event.
   */
  async checkAttendance(
    dto: AttendanceCheckRequest,
    authGuardId?: number | null
  ): Promise<AttendanceCheckResponse> {
    const now = this.clock.now();
    const guardId = authGuardId ?? dto.guardId;

    if (!guardId) {
      throw new BadRequestException("Guard ID must be provided or derived from authentication");
    }

    // 1. Offline Clock Skew check
    let lateSync = false;
    let effectiveSimTs = now;

    if (dto.timestamp) {
      const clientTs = new Date(dto.timestamp);
      const skewSec = Math.abs((now.getTime() - clientTs.getTime()) / 1000);
      const toleranceSec = await this.getPolicy<number>(
        "attendance.clock_skew_tolerance_sec",
        300,
        now
      );

      if (skewSec > toleranceSec) {
        await this.logAttendanceAttempt({
          guardId,
          postId: dto.postId,
          kind: dto.kind,
          method: "QR",
          deviceUid: dto.deviceUid,
          simTs: now,
          accepted: false,
          rejectReason: "CLOCK_SKEW_TOO_LARGE",
          gps: dto.gps
        });
        return { accepted: false, reason: "CLOCK_SKEW_TOO_LARGE" };
      }

      if (skewSec > 10) {
        lateSync = true;
      }
      effectiveSimTs = clientTs;
    }

    // 2. Active Device Check
    const devRes = await this.db.query(
      `SELECT id, active FROM devices WHERE guard_id = $1 AND device_uid = $2;`,
      [guardId, dto.deviceUid]
    );

    if (devRes.rowCount === 0 || !devRes.rows[0].active) {
      await this.logAttendanceAttempt({
        guardId,
        postId: dto.postId,
        kind: dto.kind,
        method: "QR",
        deviceUid: dto.deviceUid,
        simTs: effectiveSimTs,
        accepted: false,
        rejectReason: "WRONG_DEVICE",
        gps: dto.gps
      });
      return { accepted: false, reason: "WRONG_DEVICE" };
    }

    // 3. Nonce Check (single-use, TTL, bindings)
    const nonceRes = await this.db.query(
      `SELECT * FROM attendance_nonces WHERE nonce = $1;`,
      [dto.nonce]
    );

    if (nonceRes.rowCount === 0) {
      await this.logAttendanceAttempt({
        guardId,
        postId: dto.postId,
        kind: dto.kind,
        method: "QR",
        deviceUid: dto.deviceUid,
        simTs: effectiveSimTs,
        accepted: false,
        rejectReason: "INVALID_NONCE",
        gps: dto.gps
      });
      return { accepted: false, reason: "INVALID_NONCE" };
    }

    const nonceRow = nonceRes.rows[0];

    if (nonceRow.used_at !== null) {
      await this.logAttendanceAttempt({
        guardId,
        postId: dto.postId,
        kind: dto.kind,
        method: "QR",
        deviceUid: dto.deviceUid,
        simTs: effectiveSimTs,
        accepted: false,
        rejectReason: "REPLAYED_NONCE",
        gps: dto.gps
      });
      return { accepted: false, reason: "REPLAYED_NONCE" };
    }

    if (new Date(nonceRow.expires_at).getTime() < now.getTime()) {
      await this.logAttendanceAttempt({
        guardId,
        postId: dto.postId,
        kind: dto.kind,
        method: "QR",
        deviceUid: dto.deviceUid,
        simTs: effectiveSimTs,
        accepted: false,
        rejectReason: "NONCE_EXPIRED",
        gps: dto.gps
      });
      return { accepted: false, reason: "NONCE_EXPIRED" };
    }

    if (Number(nonceRow.guard_id) !== Number(guardId)) {
      await this.logAttendanceAttempt({
        guardId,
        postId: dto.postId,
        kind: dto.kind,
        method: "QR",
        deviceUid: dto.deviceUid,
        simTs: effectiveSimTs,
        accepted: false,
        rejectReason: "GUARD_MISMATCH",
        gps: dto.gps
      });
      return { accepted: false, reason: "GUARD_MISMATCH" };
    }

    if (nonceRow.post_id !== dto.postId) {
      await this.logAttendanceAttempt({
        guardId,
        postId: dto.postId,
        kind: dto.kind,
        method: "QR",
        deviceUid: dto.deviceUid,
        simTs: effectiveSimTs,
        accepted: false,
        rejectReason: "POST_MISMATCH",
        gps: dto.gps
      });
      return { accepted: false, reason: "POST_MISMATCH" };
    }

    if (nonceRow.device_uid !== dto.deviceUid) {
      await this.logAttendanceAttempt({
        guardId,
        postId: dto.postId,
        kind: dto.kind,
        method: "QR",
        deviceUid: dto.deviceUid,
        simTs: effectiveSimTs,
        accepted: false,
        rejectReason: "DEVICE_MISMATCH",
        gps: dto.gps
      });
      return { accepted: false, reason: "DEVICE_MISMATCH" };
    }

    // 4. QR Token Verification (HMAC)
    const postRes = await this.db.query(
      `SELECT qr_code_id, lat, lon, geofence_m FROM posts WHERE id = $1;`,
      [dto.postId]
    );

    if (postRes.rowCount === 0) {
      throw new NotFoundException(`Post ${dto.postId} not found`);
    }

    const post = postRes.rows[0];
    const isQrValid = this.qrService.verifyToken(post.qr_code_id, dto.qrToken);

    if (!isQrValid) {
      await this.logAttendanceAttempt({
        guardId,
        postId: dto.postId,
        kind: dto.kind,
        method: "QR",
        deviceUid: dto.deviceUid,
        simTs: effectiveSimTs,
        accepted: false,
        rejectReason: "INVALID_QR_TOKEN",
        gps: dto.gps
      });
      return { accepted: false, reason: "INVALID_QR_TOKEN" };
    }

    // 5. Impossible Travel Check (§10.1: two posts farther apart than travel time allows)
    const lastCheckRes = await this.db.query(
      `SELECT post_id, sim_ts
       FROM attendance_logs
       WHERE guard_id = $1 AND accepted = true AND post_id IS NOT NULL AND post_id <> $2
       ORDER BY sim_ts DESC
       LIMIT 1;`,
      [guardId, dto.postId]
    );

    if (lastCheckRes.rowCount && lastCheckRes.rowCount > 0) {
      const lastPostId = lastCheckRes.rows[0].post_id;
      const lastTs = new Date(lastCheckRes.rows[0].sim_ts);
      const elapsedSec = (effectiveSimTs.getTime() - lastTs.getTime()) / 1000;

      const travelRes = await this.db.query(
        `SELECT minutes FROM post_travel WHERE from_post = $1 AND to_post = $2;`,
        [lastPostId, dto.postId]
      );

      const requiredTravelSec = (travelRes.rowCount && travelRes.rowCount > 0 ? travelRes.rows[0].minutes : 5) * 60;

      if (elapsedSec < requiredTravelSec) {
        await this.logAttendanceAttempt({
          guardId,
          postId: dto.postId,
          kind: dto.kind,
          method: "QR",
          deviceUid: dto.deviceUid,
          simTs: effectiveSimTs,
          accepted: false,
          rejectReason: "IMPOSSIBLE_TRAVEL",
          gps: dto.gps
        });
        return { accepted: false, reason: "IMPOSSIBLE_TRAVEL" };
      }
    }

    // 6. Optional GPS Geofence Check
    if (dto.gps) {
      const gpsMaxAcc = await this.getPolicy<number>("attendance.gps_accuracy_max_m", 30, now);

      if (dto.gps.accuracy <= gpsMaxAcc) {
        const postCenter = {
          lat: post.lat ?? 16.065,
          lon: post.lon ?? 108.202
        };
        const dist = calculateHaversineDistance(
          postCenter.lat,
          postCenter.lon,
          dto.gps.lat,
          dto.gps.lon
        );
        const geofenceM = post.geofence_m ?? 25;

        if (dist > geofenceM * 1.5) {
          await this.logAttendanceAttempt({
            guardId,
            postId: dto.postId,
            kind: dto.kind,
            method: "QR",
            deviceUid: dto.deviceUid,
            simTs: effectiveSimTs,
            accepted: false,
            rejectReason: "GEOFENCE_VIOLATION",
            gps: dto.gps
          });
          return { accepted: false, reason: "GEOFENCE_VIOLATION" };
        }
      }
    }

    // 7. Accept Attendance & Apply State Transitions in a Transaction
    const client = await this.db.getClient();
    let logId: number = 0;
    let eventType: string = "CHECKIN_ACCEPTED";

    try {
      await client.query("BEGIN;");

      // Mark nonce as used
      await client.query(
        `UPDATE attendance_nonces SET used_at = $1 WHERE nonce = $2;`,
        [now, dto.nonce]
      );

      // Log accepted attempt
      const logInsert = await client.query(
        `INSERT INTO attendance_logs (guard_id, post_id, kind, method, lat, lon, accuracy_m, device_uid, sim_ts, accepted)
         VALUES ($1, $2, $3, 'QR', $4, $5, $6, $7, $8, true)
         RETURNING id;`,
        [
          guardId,
          dto.postId,
          dto.kind,
          dto.gps?.lat ?? null,
          dto.gps?.lon ?? null,
          dto.gps?.accuracy ?? null,
          dto.deviceUid,
          effectiveSimTs
        ]
      );
      logId = Number(logInsert.rows[0].id);

      // Determine state transition
      const stateRes = await client.query(
        `SELECT ps.status, ps.guard_id, p.site_id
         FROM post_state ps
         JOIN posts p ON ps.post_id = p.id
         WHERE ps.post_id = $1
         FOR UPDATE;`,
        [dto.postId]
      );

      const currentStatus = stateRes.rowCount ? stateRes.rows[0].status : null;
      const siteId = stateRes.rowCount && stateRes.rows[0].site_id ? stateRes.rows[0].site_id : "AEON_THANH_KHE_F1";

      if (dto.kind === "QR_CONFIRM" || currentStatus === "UNCERTAIN") {
        eventType = "QR_CONFIRMED";
        if (currentStatus === "UNCERTAIN") {
          await this.dispatchService.apply(client, {
            siteId,
            kind: "QR_CONFIRMED",
            postId: dto.postId,
            actorId: guardId,
            simTs: effectiveSimTs,
            payload: { guardId }
          });
        }
        await this.presenceMonitor.handlePresenceRestored(guardId, dto.postId);
      } else if (dto.kind === "CHECK_IN") {
        if (currentStatus === "HANDOVER_PENDING") {
          eventType = "FLOAT_CHECKIN";
          await this.dispatchService.apply(client, {
            siteId,
            kind: "FLOAT_CHECKIN",
            postId: dto.postId,
            actorId: guardId,
            simTs: effectiveSimTs,
            payload: { floatId: guardId }
          });
        } else if (currentStatus === "RELIEVED_FOR_MEAL") {
          eventType = "ORIGINAL_BACK";
          await this.dispatchService.apply(client, {
            siteId,
            kind: "ORIGINAL_BACK",
            postId: dto.postId,
            actorId: guardId,
            simTs: effectiveSimTs,
            payload: { guardId }
          });
        } else if (
          currentStatus === "VACANT_ALERT" ||
          currentStatus === "VACANT_PLANNED" ||
          currentStatus === "COVERED_BY_PAIR"
        ) {
          eventType = "CHECKIN_ACCEPTED";
          await this.dispatchService.apply(client, {
            siteId,
            kind: "CHECKIN_ACCEPTED",
            postId: dto.postId,
            actorId: guardId,
            simTs: effectiveSimTs,
            payload: { guardId }
          });
        } else {
          // Already occupied or active
          eventType = "CHECKIN_ACCEPTED";
        }
        await this.presenceMonitor.handlePresenceRestored(guardId, dto.postId);
      }

      await client.query("COMMIT;");

      return {
        accepted: true,
        logId,
        eventType,
        lateSync
      };
    } catch (err) {
      await client.query("ROLLBACK;");
      throw err;
    } finally {
      client.release();
    }
  }

  private async logAttendanceAttempt(params: {
    guardId: number;
    postId: string;
    kind: string;
    method: string;
    deviceUid?: string;
    simTs: Date;
    accepted: boolean;
    rejectReason?: string;
    gps?: { lat: number; lon: number; accuracy: number };
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO attendance_logs (guard_id, post_id, kind, method, lat, lon, accuracy_m, device_uid, sim_ts, accepted, reject_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);`,
      [
        params.guardId,
        params.postId,
        params.kind,
        params.method,
        params.gps?.lat ?? null,
        params.gps?.lon ?? null,
        params.gps?.accuracy ?? null,
        params.deviceUid ?? null,
        params.simTs,
        params.accepted,
        params.rejectReason ?? null
      ]
    );
  }
}
