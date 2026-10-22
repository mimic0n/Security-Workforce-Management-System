import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { INestApplication } from "@nestjs/common";
import pg from "pg";
import { AppModule } from "../src/app.module.js";
import { VirtualClock } from "../src/core/clock/virtual-clock.js";
import { CLOCK_TOKEN } from "../src/core/clock/clock.interface.js";
import { runMigration } from "../../../db/migrate.js";
import { runSeed } from "../../../db/seed/seed.js";
import {
  StaffingResultSchema,
  computeKFromAnnualDays,
  StaffingRequestSchema
} from "@swms/contracts";

const testDbUrl = process.env.TEST_DATABASE_URL || "postgres://grey@localhost:5432/swms_test";
const { Pool } = pg;

describe("Milestone M3 Acceptance Criteria — Staffing Calculator & Endpoints", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let virtualClock: VirtualClock;
  let pool: pg.Pool;
  let adminToken: string;
  let guardToken: string;

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

    // Log in as admin
    const adminLoginRes = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: "admin", password: "password123" });
    adminToken = adminLoginRes.body.accessToken;

    // Log in as guard
    const guardLoginRes = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: "guard1", password: "password123" });
    guardToken = guardLoginRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe("1. Golden Test (Defaults)", () => {
    it("matches golden specification: 18/18/8, 44 slots, k=1.35, required=60, present=45, gap=15, 25%", async () => {
      const res = await request(app.getHttpServer())
        .get("/staffing/calc")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      const parsed = StaffingResultSchema.parse(res.body);

      // Shift totals
      expect(parsed.perShift.MORNING).toEqual({
        fixed: 14,
        floatT1: 2,
        floatGen: 1,
        sup: 1,
        total: 18
      });
      expect(parsed.perShift.AFTERNOON).toEqual({
        fixed: 14,
        floatT1: 2,
        floatGen: 1,
        sup: 1,
        total: 18
      });
      expect(parsed.perShift.NIGHT).toEqual({
        fixed: 6,
        floatT1: 0,
        floatGen: 1,
        sup: 1,
        total: 8
      });

      // Daily totals and calculations
      expect(parsed.slotsPerDay).toBe(44);
      expect(parsed.k).toBe(1.35);
      expect(parsed.required).toBe(60); // ceil(44 * 1.35) = ceil(59.4) = 60
      expect(parsed.present).toBe(45);
      expect(parsed.gap).toBe(15); // max(0, 60 - 45) = 15
      expect(parsed.gapPct).toBe(25); // (15 / 60) * 100 = 25%
    });
  });

  describe("2. Sensitivity Output", () => {
    it("generates sensitivity points across default range [1.25, 1.40] with step 0.05", async () => {
      const res = await request(app.getHttpServer())
        .get("/staffing/calc")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      const parsed = StaffingResultSchema.parse(res.body);
      const sensitivity = parsed.sensitivity;

      expect(sensitivity).toHaveLength(4);

      // K = 1.25: required = ceil(44 * 1.25) = 55, gap = 55 - 45 = 10
      expect(sensitivity[0]).toEqual({
        k: 1.25,
        required: 55,
        gap: 10
      });

      // K = 1.30: required = ceil(44 * 1.30) = ceil(57.2) = 58, gap = 58 - 45 = 13
      expect(sensitivity[1]).toEqual({
        k: 1.3,
        required: 58,
        gap: 13
      });

      // K = 1.35: required = ceil(44 * 1.35) = ceil(59.4) = 60, gap = 60 - 45 = 15
      expect(sensitivity[2]).toEqual({
        k: 1.35,
        required: 60,
        gap: 15
      });

      // K = 1.40: required = ceil(44 * 1.40) = ceil(61.6) = 62, gap = 62 - 45 = 17
      expect(sensitivity[3]).toEqual({
        k: 1.4,
        required: 62,
        gap: 17
      });
    });

    it("respects custom sensitivity range in simulation", async () => {
      const res = await request(app.getHttpServer())
        .post("/staffing/simulate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          "relief.k_sensitivity_range": [1.2, 1.35]
        })
        .expect(200);

      const parsed = StaffingResultSchema.parse(res.body);
      expect(parsed.sensitivity.map((s) => s.k)).toEqual([1.2, 1.25, 1.3, 1.35]);
    });
  });

  describe("3. Derived-K Helper (computeKFromAnnualDays)", () => {
    it("computes K from annual days according to spec §5: 365 / 293 ≈ 1.2457", () => {
      const k = computeKFromAnnualDays({
        workDaysMax: 313,
        leave: 12,
        sick: 6,
        training: 2
      });
      // 365 / (313 - 12 - 6 - 2) = 365 / 293 = 1.245733788...
      expect(k).toBe(1.2457);
    });

    it("handles custom parameters and extra days off", () => {
      const k = computeKFromAnnualDays({
        totalDays: 365,
        workDaysMax: 300,
        leave: 15,
        sick: 5,
        training: 5,
        other: 5
      });
      // 365 / (300 - 15 - 5 - 5 - 5) = 365 / 270 = 1.3518518...
      expect(k).toBe(1.3519);
    });

    it("throws an error when net work days are non-positive", () => {
      expect(() => {
        computeKFromAnnualDays({
          workDaysMax: 10,
          leave: 10,
          sick: 5,
          training: 0
        });
      }).toThrow("Net working days must be greater than zero");
    });
  });

  describe("4. Fallback Formula for K when k_override is null", () => {
    it("uses k_weekly_rest * (1 + leave_sick_ratio) when k_override is null", async () => {
      // Simulate with k_override: null
      const res = await request(app.getHttpServer())
        .post("/staffing/simulate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          "relief.k_override": null,
          "relief.k_weekly_rest": 1.1667,
          "relief.leave_sick_ratio": 0.15
        })
        .expect(200);

      const parsed = StaffingResultSchema.parse(res.body);
      // 1.1667 * (1 + 0.15) = 1.341705 -> 1.3417
      expect(parsed.k).toBe(1.3417);
      // required = ceil(44 * 1.3417) = ceil(59.0348) = 60
      expect(parsed.required).toBe(60);
    });
  });

  describe("5. Endpoint Contract Tests", () => {
    describe("GET /staffing/calc", () => {
      it("rejects unauthenticated requests with 401", async () => {
        await request(app.getHttpServer())
          .get("/staffing/calc")
          .expect(401);
      });

      it("allows authorized users to fetch staffing result", async () => {
        const res = await request(app.getHttpServer())
          .get("/staffing/calc")
          .set("Authorization", `Bearer ${adminToken}`)
          .expect(200);

        const parsed = StaffingResultSchema.parse(res.body);
        expect(parsed.slotsPerDay).toBe(44);
      });
    });

    describe("POST /staffing/simulate", () => {
      it("rejects unauthenticated requests with 401", async () => {
        await request(app.getHttpServer())
          .post("/staffing/simulate")
          .send({})
          .expect(401);
      });

      it("simulates overrides without modifying persistent database policies", async () => {
        // Simulate scenario C3 override: morning fixed = 15 (N_shift = 19, total slots = 45)
        const simRes = await request(app.getHttpServer())
          .post("/staffing/simulate")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            "headcount.fixed": { MORNING: 15, AFTERNOON: 14, NIGHT: 6 },
            present: 50
          })
          .expect(200);

        const simParsed = StaffingResultSchema.parse(simRes.body);
        expect(simParsed.perShift.MORNING.fixed).toBe(15);
        expect(simParsed.perShift.MORNING.total).toBe(19);
        expect(simParsed.slotsPerDay).toBe(45);
        expect(simParsed.present).toBe(50);
        // ceil(45 * 1.35) = ceil(60.75) = 61
        expect(simParsed.required).toBe(61);
        expect(simParsed.gap).toBe(11); // 61 - 50 = 11

        // Verify original GET /staffing/calc still returns unmodified defaults
        const baseRes = await request(app.getHttpServer())
          .get("/staffing/calc")
          .set("Authorization", `Bearer ${adminToken}`)
          .expect(200);

        const baseParsed = StaffingResultSchema.parse(baseRes.body);
        expect(baseParsed.slotsPerDay).toBe(44);
        expect(baseParsed.present).toBe(45);
      });

      it("supports shorthand override keys", async () => {
        const simRes = await request(app.getHttpServer())
          .post("/staffing/simulate")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            k_override: 1.4,
            present: 40
          })
          .expect(200);

        const simParsed = StaffingResultSchema.parse(simRes.body);
        expect(simParsed.k).toBe(1.4);
        expect(simParsed.present).toBe(40);
        // ceil(44 * 1.4) = ceil(61.6) = 62
        expect(simParsed.required).toBe(62);
        expect(simParsed.gap).toBe(22); // 62 - 40 = 22
      });
    });

    describe("GET and POST /staffing/requests", () => {
      it("rejects unauthenticated requests with 401", async () => {
        await request(app.getHttpServer())
          .get("/staffing/requests")
          .expect(401);

        await request(app.getHttpServer())
          .post("/staffing/requests")
          .send({ qty: 15, reason: "Gap" })
          .expect(401);
      });

      it("creates a new staffing request with Clock timestamp and retrieves it", async () => {
        // Set virtual clock to a known time
        const requestTime = new Date("2026-11-05T09:30:00.000Z");
        await virtualClock.jumpTo(requestTime);

        // POST /staffing/requests
        const postRes = await request(app.getHttpServer())
          .post("/staffing/requests")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            qty: 15,
            shift: "MORNING",
            reason: "Headcount gap coverage for Tier 1 relief"
          })
          .expect(201);

        const created = StaffingRequestSchema.parse(postRes.body);
        expect(created.qty).toBe(15);
        expect(created.shift).toBe("MORNING");
        expect(created.reason).toBe("Headcount gap coverage for Tier 1 relief");
        expect(created.status).toBe("OPEN");
        expect(new Date(created.created_at).toISOString()).toBe(requestTime.toISOString());

        // GET /staffing/requests
        const getRes = await request(app.getHttpServer())
          .get("/staffing/requests")
          .set("Authorization", `Bearer ${adminToken}`)
          .expect(200);

        expect(Array.isArray(getRes.body)).toBe(true);
        const match = getRes.body.find((r: any) => r.id === created.id);
        expect(match).toBeDefined();
        expect(match.qty).toBe(15);

        // Filter by shift
        const filteredShiftRes = await request(app.getHttpServer())
          .get("/staffing/requests?shift=MORNING")
          .set("Authorization", `Bearer ${adminToken}`)
          .expect(200);
        expect(filteredShiftRes.body.every((r: any) => r.shift === "MORNING")).toBe(true);

        // Filter by status
        const filteredStatusRes = await request(app.getHttpServer())
          .get("/staffing/requests?status=OPEN")
          .set("Authorization", `Bearer ${adminToken}`)
          .expect(200);
        expect(filteredStatusRes.body.every((r: any) => r.status === "OPEN")).toBe(true);
      });

      it("validates request body on POST /staffing/requests", async () => {
        // Missing reason and non-positive qty
        await request(app.getHttpServer())
          .post("/staffing/requests")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            qty: -5
          })
          .expect(400);
      });
    });
  });
});
