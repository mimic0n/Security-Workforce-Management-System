import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import pg from "pg";
import { AppModule } from "../src/app.module.js";
import { DatabaseService } from "../src/core/database/database.service.js";
import { CLOCK_TOKEN } from "../src/core/clock/clock.interface.js";
import { VirtualClock } from "../src/core/clock/virtual-clock.js";
import { AttendanceService } from "../src/modules/attendance/attendance.service.js";
import { PresenceMonitorService } from "../src/modules/attendance/presence-monitor.service.js";
import { QrService } from "../src/modules/attendance/qr.service.js";
import { runMigration } from "../../../db/migrate.js";
import { runSeed } from "../../../db/seed/seed.js";

const { Pool } = pg;

describe("Milestone M7 Acceptance Criteria — Attendance & Presence (§10, §14)", () => {
  let app: INestApplication;
  let db: DatabaseService;
  let clock: VirtualClock;
  let pool: pg.Pool;
  let attendanceService: AttendanceService;
  let presenceMonitor: PresenceMonitorService;
  let qrService: QrService;

  const dbUrl = process.env.DATABASE_URL || "postgres://grey@localhost:5432/swms_test";

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl });
    await runMigration("up", dbUrl);
    await runSeed(dbUrl);

    clock = new VirtualClock(new Date("2026-11-07T14:30:00+07:00"));

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(CLOCK_TOKEN)
      .useValue(clock)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    db = app.get(DatabaseService);
    attendanceService = app.get(AttendanceService);
    presenceMonitor = app.get(PresenceMonitorService);
    qrService = app.get(QrService);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    await clock.jumpTo(new Date("2026-11-07T14:30:00+07:00"));
    presenceMonitor.resetFilter();
    // Clean dynamic tables
    await db.query("DELETE FROM attendance_logs;");
    await db.query("DELETE FROM attendance_nonces;");
    await db.query("DELETE FROM incidents;");
    await db.query("DELETE FROM dispatch_orders;");
    await db.query("DELETE FROM dispatch_tasks;");
    await db.query("DELETE FROM state_events;");
  });

  it("1. Replayed QR check-in is rejected (REPLAYED_NONCE)", async () => {
    const guardRes = await db.query("SELECT id FROM guards WHERE code = 'G01';");
    const guardId = Number(guardRes.rows[0].id);

    // Post P8 is VACANT_ALERT awaiting check-in
    await db.query(
      `UPDATE post_state SET status = 'VACANT_ALERT', guard_id = NULL WHERE post_id = 'P8';`
    );

    const nonceInfo = await attendanceService.createNonce({
      postId: "P8",
      guardId,
      deviceUid: "DEV_G01"
    });

    const qrToken = qrService.generateToken("QR_P8");

    // First attempt: Accepted
    const firstCheck = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "P8",
      nonce: nonceInfo.nonce,
      qrToken,
      deviceUid: "DEV_G01",
      guardId
    });
    expect(firstCheck.accepted).toBe(true);

    // Second attempt with replayed nonce & QR: Rejected
    const replayCheck = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "P8",
      nonce: nonceInfo.nonce,
      qrToken,
      deviceUid: "DEV_G01",
      guardId
    });
    expect(replayCheck.accepted).toBe(false);
    expect(replayCheck.reason).toBe("REPLAYED_NONCE");

    // Verify rejection is recorded in attendance_logs
    const logRes = await db.query(
      `SELECT accepted, reject_reason FROM attendance_logs WHERE guard_id = $1 ORDER BY id DESC LIMIT 1;`,
      [guardId]
    );
    expect(logRes.rows[0].accepted).toBe(false);
    expect(logRes.rows[0].reject_reason).toBe("REPLAYED_NONCE");
  });

  it("2. Wrong device check-in is rejected (WRONG_DEVICE)", async () => {
    const guardRes = await db.query("SELECT id FROM guards WHERE code = 'G01';");
    const guardId = Number(guardRes.rows[0].id);

    // Attempt check-in using a device UID that is not the guard's registered active device
    const res = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "P8",
      nonce: "fake_nonce",
      qrToken: qrService.generateToken("QR_P8"),
      deviceUid: "UNREGISTERED_DEV_999",
      guardId
    });

    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("WRONG_DEVICE");

    const logRes = await db.query(
      `SELECT accepted, reject_reason FROM attendance_logs WHERE guard_id = $1 ORDER BY id DESC LIMIT 1;`,
      [guardId]
    );
    expect(logRes.rows[0].accepted).toBe(false);
    expect(logRes.rows[0].reject_reason).toBe("WRONG_DEVICE");
  });

  it("3. Impossible-travel check: two posts farther apart than travel time allows is rejected", async () => {
    const guardRes = await db.query("SELECT id FROM guards WHERE code = 'G01';");
    const guardId = Number(guardRes.rows[0].id);

    await db.query(
      `UPDATE post_state SET status = 'VACANT_ALERT', guard_id = NULL WHERE post_id IN ('P1', 'G2');`
    );

    // Check in at P1 at t0
    const nonceP1 = await attendanceService.createNonce({
      postId: "P1",
      guardId,
      deviceUid: "DEV_G01"
    });
    const checkP1 = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "P1",
      nonce: nonceP1.nonce,
      qrToken: qrService.generateToken("QR_P1"),
      deviceUid: "DEV_G01",
      guardId
    });
    expect(checkP1.accepted).toBe(true);

    // 20 seconds later, tries to check in at G2 (requires 10 minutes travel time in post_travel)
    await clock.advance(20 * 1000);

    const nonceG2 = await attendanceService.createNonce({
      postId: "G2",
      guardId,
      deviceUid: "DEV_G01"
    });
    const checkG2 = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "G2",
      nonce: nonceG2.nonce,
      qrToken: qrService.generateToken("QR_G2"),
      deviceUid: "DEV_G01",
      guardId
    });

    expect(checkG2.accepted).toBe(false);
    expect(checkG2.reason).toBe("IMPOSSIBLE_TRAVEL");
  });

  it("4. 30 s GPS noise produces NO alert and keeps post OCCUPIED", async () => {
    const guardRes = await db.query("SELECT id FROM guards WHERE code = 'G01';");
    const guardId = Number(guardRes.rows[0].id);

    // Set post P8 to OCCUPIED by guard G01
    await db.query(
      `UPDATE post_state SET status = 'OCCUPIED', guard_id = $1 WHERE post_id = 'P8';`,
      [guardId]
    );

    // Fetch center of P8
    const postRes = await db.query("SELECT lat, lon, geofence_m FROM posts WHERE id = 'P8';");
    const center = {
      lat: postRes.rows[0].lat ?? 16.065,
      lon: postRes.rows[0].lon ?? 108.202
    };

    // Simulate 30 seconds of GPS noise:
    // (a) First sample has degraded accuracy (40m > 30m max) -> dropped
    await presenceMonitor.processPing({
      guardId,
      postId: "P8",
      lat: center.lat + 0.0006, // ~66m away
      lon: center.lon,
      accuracy_m: 40
    });

    // (b) Second sample is outside (~60m away), but only 1 sample (< 3 outSamplesRequired)
    await presenceMonitor.processPing({
      guardId,
      postId: "P8",
      lat: center.lat + 0.0006,
      lon: center.lon,
      accuracy_m: 10
    });

    // (c) Guard quickly returns inside (< 25m) within 30s
    await clock.advance(30 * 1000);
    await presenceMonitor.processPing({
      guardId,
      postId: "P8",
      lat: center.lat,
      lon: center.lon,
      accuracy_m: 10
    });

    // Post must remain strictly OCCUPIED — zero alert emitted, zero incidents
    const state = await db.query("SELECT status FROM post_state WHERE post_id = 'P8';");
    expect(state.rows[0].status).toBe("OCCUPIED");

    const incidents = await db.query("SELECT count(*) FROM incidents;");
    expect(Number(incidents.rows[0].count)).toBe(0);

    const vacantEvents = await db.query(
      "SELECT count(*) FROM state_events WHERE post_id = 'P8' AND to_status = 'VACANT_ALERT';"
    );
    expect(Number(vacantEvents.rows[0].count)).toBe(0);
  });

  it("5. Full Scenario A2 unit timeline (§13.4 & §10.2): presence lost -> UNCERTAIN -> VACANT_ALERT -> refilled within 5m -> VIOLATION at +10m", async () => {
    // Setup guard G08 at P8 (Tier 1 post)
    const guardRes = await db.query("SELECT id FROM guards WHERE code = 'G08';");
    const g08Id = Number(guardRes.rows[0].id);

    // Initial state: P8 is OCCUPIED by G08 at 14:30:00
    await db.query(
      `UPDATE post_state SET status = 'OCCUPIED', guard_id = $1 WHERE post_id = 'P8';`,
      [g08Id]
    );

    const postRes = await db.query("SELECT lat, lon FROM posts WHERE id = 'P8';");
    const center = {
      lat: postRes.rows[0].lat ?? 16.065,
      lon: postRes.rows[0].lon ?? 108.202
    };

    // 14:30:00: Guard stops sending valid presence (sends 3 consecutive outside readings)
    // Offset lat by +0.0006 deg (~66m > 37.5m leave radius)
    const outsideCoord = {
      lat: center.lat + 0.0006,
      lon: center.lon,
      accuracy_m: 10
    };

    await presenceMonitor.processPing({ guardId: g08Id, postId: "P8", ...outsideCoord });
    await presenceMonitor.processPing({ guardId: g08Id, postId: "P8", ...outsideCoord });
    const p3 = await presenceMonitor.processPing({ guardId: g08Id, postId: "P8", ...outsideCoord });

    expect(p3.state).toBe("OUTSIDE");
    expect(p3.transitionedToOutside).toBe(true);

    // Post immediately enters UNCERTAIN
    const stateAtT0 = await db.query("SELECT status FROM post_state WHERE post_id = 'P8';");
    expect(stateAtT0.rows[0].status).toBe("UNCERTAIN");

    const eventAtT0 = await db.query(
      `SELECT cause, to_status FROM state_events WHERE post_id = 'P8' ORDER BY id DESC LIMIT 1;`
    );
    expect(eventAtT0.rows[0].cause).toBe("PRESENCE_UNCERTAIN");
    expect(eventAtT0.rows[0].to_status).toBe("UNCERTAIN");

    // Advance clock to t0 + 45s (14:30:45, attendance.uncertain_after_sec): Pre-warm stage
    await clock.jumpTo(new Date("2026-11-07T14:30:45+07:00"));
    const stateAt45s = await db.query("SELECT status FROM post_state WHERE post_id = 'P8';");
    expect(stateAt45s.rows[0].status).toBe("UNCERTAIN"); // Still UNCERTAIN, no alert yet

    // Advance clock to t0 + 120s (14:32:00, attendance.tier1_escalate_after_sec): Escalate stage
    await clock.jumpTo(new Date("2026-11-07T14:32:00+07:00"));

    // Post transitions UNCERTAIN -> VACANT_ALERT and fillVacancy is triggered
    const stateAt120s = await db.query("SELECT status FROM post_state WHERE post_id = 'P8';");
    expect(stateAt120s.rows[0].status).toBe("VACANT_ALERT");

    const eventAt120s = await db.query(
      `SELECT cause, to_status FROM state_events WHERE post_id = 'P8' AND cause = 'ESCALATE_TIMEOUT';`
    );
    expect(eventAt120s.rowCount).toBe(1);
    expect(eventAt120s.rows[0].to_status).toBe("VACANT_ALERT");

    // A dispatch order to fill P8 vacancy exists
    const orderRes = await db.query(
      `SELECT * FROM dispatch_orders WHERE to_post = 'P8' ORDER BY id DESC LIMIT 1;`
    );
    expect(orderRes.rowCount).toBe(1);
    const replacementGuardId = Number(orderRes.rows[0].to_guard_id);

    // Get replacement guard's device
    const repDev = await db.query(
      `SELECT device_uid FROM devices WHERE guard_id = $1 AND active = true;`,
      [replacementGuardId]
    );
    const repDeviceUid = repDev.rows[0].device_uid;

    // Advance clock to 14:33:30 (3.5 min after loss, well within 5 min required by A2)
    await clock.jumpTo(new Date("2026-11-07T14:33:30+07:00"));

    // Replacement guard checks in at P8
    const repNonce = await attendanceService.createNonce({
      postId: "P8",
      guardId: replacementGuardId,
      deviceUid: repDeviceUid
    });

    const repCheck = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "P8",
      nonce: repNonce.nonce,
      qrToken: qrService.generateToken("QR_P8"),
      deviceUid: repDeviceUid,
      guardId: replacementGuardId
    });

    expect(repCheck.accepted).toBe(true);
    expect(repCheck.eventType).toBe("CHECKIN_ACCEPTED");

    // P8 is now OCCUPIED within 5 min of the loss!
    const stateRefilled = await db.query(
      "SELECT status, guard_id FROM post_state WHERE post_id = 'P8';"
    );
    expect(stateRefilled.rows[0].status).toBe("OCCUPIED");
    expect(Number(stateRefilled.rows[0].guard_id)).toBe(replacementGuardId);

    // Advance clock to t0 + 600s (14:40:00, attendance.violation_after_sec)
    // Original guard G08 never confirmed QR -> incident VIOLATION must exist!
    await clock.jumpTo(new Date("2026-11-07T14:40:00+07:00"));

    const violationIncident = await db.query(
      `SELECT * FROM incidents WHERE kind = 'VIOLATION' AND post_id = 'P8' AND guard_id = $1;`,
      [g08Id]
    );
    expect(violationIncident.rowCount).toBe(1);
    expect(violationIncident.rows[0].severity).toBe("HIGH");
  });

  it("6. Control run: QR confirmation before escalation cancels timers and produces NO alert", async () => {
    const guardRes = await db.query("SELECT id FROM guards WHERE code = 'G08';");
    const g08Id = Number(guardRes.rows[0].id);

    // Initial state: P8 is OCCUPIED by G08 at 14:30:00
    await db.query(
      `UPDATE post_state SET status = 'OCCUPIED', guard_id = $1 WHERE post_id = 'P8';`,
      [g08Id]
    );

    const postRes = await db.query("SELECT lat, lon FROM posts WHERE id = 'P8';");
    const center = {
      lat: postRes.rows[0].lat ?? 16.065,
      lon: postRes.rows[0].lon ?? 108.202
    };

    // 14:30:00: Presence lost -> UNCERTAIN
    const outsideCoord = { lat: center.lat + 0.0006, lon: center.lon, accuracy_m: 10 };
    await presenceMonitor.processPing({ guardId: g08Id, postId: "P8", ...outsideCoord });
    await presenceMonitor.processPing({ guardId: g08Id, postId: "P8", ...outsideCoord });
    await presenceMonitor.processPing({ guardId: g08Id, postId: "P8", ...outsideCoord });

    const stateUncertain = await db.query("SELECT status FROM post_state WHERE post_id = 'P8';");
    expect(stateUncertain.rows[0].status).toBe("UNCERTAIN");

    // Guard confirms QR at 14:30:40 (before the 120s escalation)
    await clock.jumpTo(new Date("2026-11-07T14:30:40+07:00"));

    const nonceInfo = await attendanceService.createNonce({
      postId: "P8",
      guardId: g08Id,
      deviceUid: "DEV_G08"
    });

    const qrCheck = await attendanceService.checkAttendance({
      kind: "QR_CONFIRM",
      postId: "P8",
      nonce: nonceInfo.nonce,
      qrToken: qrService.generateToken("QR_P8"),
      deviceUid: "DEV_G08",
      guardId: g08Id
    });

    expect(qrCheck.accepted).toBe(true);
    expect(qrCheck.eventType).toBe("QR_CONFIRMED");

    // Post reverts to OCCUPIED
    const stateRestored = await db.query("SELECT status FROM post_state WHERE post_id = 'P8';");
    expect(stateRestored.rows[0].status).toBe("OCCUPIED");

    // Advance clock past 14:32:00 (escalation time) and past 14:40:00 (violation time)
    await clock.jumpTo(new Date("2026-11-07T14:45:00+07:00"));

    // State is STILL OCCUPIED, no VACANT_ALERT ever fired, NO violation incident
    const stateFinal = await db.query("SELECT status FROM post_state WHERE post_id = 'P8';");
    expect(stateFinal.rows[0].status).toBe("OCCUPIED");

    const vacantEvents = await db.query(
      `SELECT count(*) FROM state_events WHERE post_id = 'P8' AND to_status = 'VACANT_ALERT';`
    );
    expect(Number(vacantEvents.rows[0].count)).toBe(0);

    const incidents = await db.query(
      `SELECT count(*) FROM incidents WHERE kind = 'VIOLATION' AND post_id = 'P8';`
    );
    expect(Number(incidents.rows[0].count)).toBe(0);
  });
});
