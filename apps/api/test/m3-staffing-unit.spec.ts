import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { INestApplication } from "@nestjs/common";
import pg from "pg";
import { AppModule } from "../src/app.module.js";
import { VirtualClock } from "../src/core/clock/virtual-clock.js";
import { CLOCK_TOKEN } from "../src/core/clock/clock.interface.js";
import { StaffingService } from "../src/modules/staffing/staffing.service.js";
import { ConfigService } from "../src/modules/policies/config.service.js";
import { runMigration } from "../../../db/migrate.js";
import { runSeed } from "../../../db/seed/seed.js";

const testDbUrl = process.env.TEST_DATABASE_URL || "postgres://grey@localhost:5432/swms_test";
const { Pool } = pg;

describe("StaffingService Unit & Edge Case Tests", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let virtualClock: VirtualClock;
  let staffingService: StaffingService;
  let pool: pg.Pool;
  let adminToken: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    process.env.SIM_MODE = "true";

    pool = new Pool({ connectionString: testDbUrl });
    await runMigration("up", testDbUrl);
    await runSeed(testDbUrl);

    virtualClock = new VirtualClock(new Date("2026-11-01T00:00:00.000Z"));

    moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(CLOCK_TOKEN)
      .useValue(virtualClock)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    staffingService = moduleRef.get<StaffingService>(StaffingService);

    const adminLoginRes = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: "admin", password: "password123" });
    adminToken = adminLoginRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("handles surplus guards where present > required (gap and gapPct are 0)", async () => {
    const result = await staffingService.calculate({
      present: 100
    });

    expect(result.required).toBe(60);
    expect(result.present).toBe(100);
    expect(result.gap).toBe(0);
    expect(result.gapPct).toBe(0);
  });

  it("handles zero slots per day (all headcount set to 0)", async () => {
    const zeroHeadcount = { MORNING: 0, AFTERNOON: 0, NIGHT: 0 };
    const result = await staffingService.calculate({
      fixed: zeroHeadcount,
      floatT1: zeroHeadcount,
      floatGen: zeroHeadcount,
      sup: zeroHeadcount,
      present: 0
    });

    expect(result.slotsPerDay).toBe(0);
    expect(result.required).toBe(0);
    expect(result.gap).toBe(0);
    expect(result.gapPct).toBe(0);
  });

  it("excludes inactive guards when reading present count from DB", async () => {
    // Insert an inactive guard
    await pool.query(
      `INSERT INTO guards (code, full_name, role, active)
       VALUES ('INACTIVE_TEST_01', 'Inactive Guard Test', 'GUARD', false);`
    );

    const result = await staffingService.calculate();
    // Present count should remain 45 because active = false
    expect(result.present).toBe(45);
  });

  it("supports POST /staffing/compute-k endpoint", async () => {
    const res = await request(app.getHttpServer())
      .post("/staffing/compute-k")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        workDaysMax: 313,
        leave: 12,
        sick: 6,
        training: 2
      })
      .expect(200);

    expect(res.body.k).toBe(1.2457);
    expect(res.body.params.leave).toBe(12);
  });

  it("supports time-travel via query parameter ?at=", async () => {
    // Add a policy override valid for only 3 days in the future
    await pool.query(
      `INSERT INTO policies (key, value, valid_from, valid_to)
       VALUES ('headcount.fixed', '{"MORNING":15,"AFTERNOON":14,"NIGHT":6}', '2026-11-10T00:00:00Z', '2026-11-13T00:00:00Z');`
    );
    // Invalidate config service cache since we inserted directly into DB
    const configService = moduleRef.get(ConfigService);
    configService.invalidate("headcount.fixed");

    // 1. Before override window (2026-11-09)
    const beforeRes = await request(app.getHttpServer())
      .get("/staffing/calc?at=2026-11-09T12:00:00Z")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(beforeRes.body.perShift.MORNING.fixed).toBe(14);
    expect(beforeRes.body.slotsPerDay).toBe(44);

    // 2. During override window (2026-11-11) -> Scenario C3 requirement
    const duringRes = await request(app.getHttpServer())
      .get("/staffing/calc?at=2026-11-11T12:00:00Z")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(duringRes.body.perShift.MORNING.fixed).toBe(15);
    expect(duringRes.body.slotsPerDay).toBe(45);
    expect(duringRes.body.required).toBe(61);

    // 3. After override window expires (2026-11-14)
    const afterRes = await request(app.getHttpServer())
      .get("/staffing/calc?at=2026-11-14T12:00:00Z")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(afterRes.body.perShift.MORNING.fixed).toBe(14);
    expect(afterRes.body.slotsPerDay).toBe(44);
    expect(afterRes.body.required).toBe(60);
  });

  it("filters staffing requests by both shift and status", async () => {
    // Create staffing requests with different shifts and statuses
    await staffingService.createStaffingRequest({
      shift: "AFTERNOON",
      qty: 2,
      reason: "Peak traffic coverage",
      status: "OPEN"
    });

    await staffingService.createStaffingRequest({
      shift: "AFTERNOON",
      qty: 1,
      reason: "Handled request",
      status: "CLOSED"
    });

    const filtered = await staffingService.getStaffingRequests({
      shift: "AFTERNOON",
      status: "OPEN"
    });

    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(filtered.every((r) => r.shift === "AFTERNOON" && r.status === "OPEN")).toBe(true);
  });
});
