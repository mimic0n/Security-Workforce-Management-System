import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import pg from "pg";
import { AppModule } from "../src/app.module.js";
import { DatabaseService } from "../src/core/database/database.service.js";
import { CLOCK_TOKEN } from "../src/core/clock/clock.interface.js";
import { VirtualClock } from "../src/core/clock/virtual-clock.js";
import { AttendanceService } from "../src/modules/attendance/attendance.service.js";
import { QrService } from "../src/modules/attendance/qr.service.js";
import { generateQrToken } from "@swms/contracts";
import { runMigration } from "../../../db/migrate.js";
import { runSeed } from "../../../db/seed/seed.js";

const { Pool } = pg;

describe("Milestone M7 Unit Tests — Attendance Service (§10.1)", () => {
  let app: INestApplication;
  let db: DatabaseService;
  let clock: VirtualClock;
  let pool: pg.Pool;
  let attendanceService: AttendanceService;
  let qrService: QrService;

  const dbUrl = process.env.DATABASE_URL || "postgres://grey@localhost:5432/swms_test";

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl });
    await runMigration("up", dbUrl);
    await runSeed(dbUrl);

    clock = new VirtualClock(new Date("2026-11-07T07:30:00+07:00"));

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
    qrService = app.get(QrService);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    clock.jumpTo(new Date("2026-11-07T07:30:00+07:00"));
    // Clean attendance tables
    await db.query("DELETE FROM attendance_logs;");
    await db.query("DELETE FROM attendance_nonces;");
    await db.query("DELETE FROM incidents;");
  });

  it("1. QR HMAC generation and verification matches contract", () => {
    const token = qrService.generateToken("QR_P8");
    expect(token).toBeDefined();
    expect(token.length).toBe(64); // sha256 hex string

    // Contract function produces identical token
    const contractToken = generateQrToken("QR_P8");
    expect(token).toBe(contractToken);

    // Verification passes for matching code
    expect(qrService.verifyToken("QR_P8", token)).toBe(true);

    // Verification fails for wrong code or tampered token
    expect(qrService.verifyToken("QR_G1", token)).toBe(false);
    expect(qrService.verifyToken("QR_P8", "tampered_token")).toBe(false);
  });

  it("2. Nonce generation is bound to guard, device, and post with policy TTL", async () => {
    // Guard 1 (G01) has device DEV_G01
    const guardRes = await db.query("SELECT id, code FROM guards WHERE code = 'G01';");
    const guardId = Number(guardRes.rows[0].id);

    const nonceRes = await attendanceService.createNonce({
      postId: "P8",
      guardId,
      deviceUid: "DEV_G01"
    });

    expect(nonceRes.nonce).toBeDefined();
    expect(nonceRes.ttlSec).toBe(45); // default attendance.nonce_ttl_sec

    // Check DB record
    const dbRow = await db.query(
      "SELECT * FROM attendance_nonces WHERE nonce = $1;",
      [nonceRes.nonce]
    );
    expect(dbRow.rowCount).toBe(1);
    expect(Number(dbRow.rows[0].guard_id)).toBe(guardId);
    expect(dbRow.rows[0].post_id).toBe("P8");
    expect(dbRow.rows[0].device_uid).toBe("DEV_G01");
    expect(dbRow.rows[0].used_at).toBeNull();
  });

  it("3. Reject check-in with wrong device (WRONG_DEVICE)", async () => {
    const guardRes = await db.query("SELECT id FROM guards WHERE code = 'G01';");
    const guardId = Number(guardRes.rows[0].id);

    // Try with a device UID not registered to guard 1
    const res = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "P8",
      nonce: "arbitrary_nonce",
      qrToken: qrService.generateToken("QR_P8"),
      deviceUid: "DEV_WRONG_123",
      guardId
    });

    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("WRONG_DEVICE");

    // Verify logged in attendance_logs
    const log = await db.query(
      "SELECT accepted, reject_reason FROM attendance_logs WHERE guard_id = $1;",
      [guardId]
    );
    expect(log.rowCount).toBe(1);
    expect(log.rows[0].accepted).toBe(false);
    expect(log.rows[0].reject_reason).toBe("WRONG_DEVICE");
  });

  it("4. Reject check-in with replayed or expired nonce", async () => {
    const guardRes = await db.query("SELECT id FROM guards WHERE code = 'G01';");
    const guardId = Number(guardRes.rows[0].id);

    // Set post P8 to VACANT_ALERT so check-in is valid
    await db.query("UPDATE post_state SET status = 'VACANT_ALERT' WHERE post_id = 'P8';");

    const nonceInfo = await attendanceService.createNonce({
      postId: "P8",
      guardId,
      deviceUid: "DEV_G01"
    });

    const qrToken = qrService.generateToken("QR_P8");

    // First check-in: SUCCESS
    const check1 = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "P8",
      nonce: nonceInfo.nonce,
      qrToken,
      deviceUid: "DEV_G01",
      guardId
    });
    expect(check1.accepted).toBe(true);

    // Second check-in with identical nonce: REJECTED (REPLAYED_NONCE)
    const check2 = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "P8",
      nonce: nonceInfo.nonce,
      qrToken,
      deviceUid: "DEV_G01",
      guardId
    });
    expect(check2.accepted).toBe(false);
    expect(check2.reason).toBe("REPLAYED_NONCE");

    // Now test expired nonce: create new nonce and advance clock past TTL (45s)
    const nonceInfo2 = await attendanceService.createNonce({
      postId: "P8",
      guardId,
      deviceUid: "DEV_G01"
    });
    await clock.advance(50 * 1000); // advance 50 seconds

    const checkExpired = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "P8",
      nonce: nonceInfo2.nonce,
      qrToken,
      deviceUid: "DEV_G01",
      guardId
    });
    expect(checkExpired.accepted).toBe(false);
    expect(checkExpired.reason).toBe("NONCE_EXPIRED");
  });

  it("5. Impossible-travel: fast travel between distant posts is rejected (IMPOSSIBLE_TRAVEL)", async () => {
    const guardRes = await db.query("SELECT id FROM guards WHERE code = 'G01';");
    const guardId = Number(guardRes.rows[0].id);

    // Set P1 and G2 to VACANT_ALERT
    await db.query("UPDATE post_state SET status = 'VACANT_ALERT' WHERE post_id IN ('P1', 'G2');");

    // Guard checks in at P1 at t0
    const nonce1 = await attendanceService.createNonce({
      postId: "P1",
      guardId,
      deviceUid: "DEV_G01"
    });
    const checkP1 = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "P1",
      nonce: nonce1.nonce,
      qrToken: qrService.generateToken("QR_P1"),
      deviceUid: "DEV_G01",
      guardId
    });
    expect(checkP1.accepted).toBe(true);

    // Only 30 seconds later, guard tries to check in at G2 (different group, travel time = 10 min)
    await clock.advance(30 * 1000);

    const nonce2 = await attendanceService.createNonce({
      postId: "G2",
      guardId,
      deviceUid: "DEV_G01"
    });
    const checkG2 = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "G2",
      nonce: nonce2.nonce,
      qrToken: qrService.generateToken("QR_G2"),
      deviceUid: "DEV_G01",
      guardId
    });

    expect(checkG2.accepted).toBe(false);
    expect(checkG2.reason).toBe("IMPOSSIBLE_TRAVEL");

    // Advance clock past travel time (11 minutes = 660s) and try again
    await clock.advance(660 * 1000);
    const nonce3 = await attendanceService.createNonce({
      postId: "G2",
      guardId,
      deviceUid: "DEV_G01"
    });
    const checkG2After = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "G2",
      nonce: nonce3.nonce,
      qrToken: qrService.generateToken("QR_G2"),
      deviceUid: "DEV_G01",
      guardId
    });
    expect(checkG2After.accepted).toBe(true);
  });

  it("6. Offline check-in: accepts within clock-skew tolerance, rejects large skew", async () => {
    const guardRes = await db.query("SELECT id FROM guards WHERE code = 'G01';");
    const guardId = Number(guardRes.rows[0].id);

    await db.query("UPDATE post_state SET status = 'VACANT_ALERT' WHERE post_id = 'P8';");

    const nonceInfo = await attendanceService.createNonce({
      postId: "P8",
      guardId,
      deviceUid: "DEV_G01"
    });

    // Check-in with 20 seconds lag (within 300s tolerance)
    const clientTimestamp = new Date(clock.now().getTime() - 20 * 1000).toISOString();
    const res = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "P8",
      nonce: nonceInfo.nonce,
      qrToken: qrService.generateToken("QR_P8"),
      deviceUid: "DEV_G01",
      guardId,
      timestamp: clientTimestamp
    });

    expect(res.accepted).toBe(true);
    expect(res.lateSync).toBe(true);

    // Large skew (> 300s tolerance)
    const nonceInfo2 = await attendanceService.createNonce({
      postId: "P8",
      guardId,
      deviceUid: "DEV_G01"
    });
    const skewedTimestamp = new Date(clock.now().getTime() - 600 * 1000).toISOString();
    const skewedRes = await attendanceService.checkAttendance({
      kind: "CHECK_IN",
      postId: "P8",
      nonce: nonceInfo2.nonce,
      qrToken: qrService.generateToken("QR_P8"),
      deviceUid: "DEV_G01",
      guardId,
      timestamp: skewedTimestamp
    });

    expect(skewedRes.accepted).toBe(false);
    expect(skewedRes.reason).toBe("CLOCK_SKEW_TOO_LARGE");
  });
});
