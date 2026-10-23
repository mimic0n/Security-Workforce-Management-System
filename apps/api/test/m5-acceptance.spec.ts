import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Pool } from "pg";
import { AppModule } from "../src/app.module.js";
import { DatabaseService } from "../src/core/database/database.service.js";
import { CLOCK_TOKEN } from "../src/core/clock/clock.interface.js";
import { VirtualClock } from "../src/core/clock/virtual-clock.js";
import { ScheduledJobsService } from "../src/core/jobs/scheduled-jobs.service.js";
import { DispatchService } from "../src/modules/dispatch/dispatch.service.js";
import { MealPlannerService } from "../src/modules/dispatch/meal-planner/meal-planner.service.js";
import { LegalGuardService } from "../src/modules/dispatch/legal-guard/legal-guard.service.js";
import { runMigration } from "../../../db/migrate.js";
import { runSeed } from "../../../db/seed/seed.js";

describe("Milestone M5 Acceptance Criteria — LegalGuard & Meal Planner Persistence/Jobs", () => {
  let app: INestApplication;
  let db: DatabaseService;
  let pool: Pool;
  let clock: VirtualClock;
  let scheduledJobs: ScheduledJobsService;
  let dispatchService: DispatchService;
  let mealPlannerService: MealPlannerService;
  let legalGuardService: LegalGuardService;
  let adminToken: string;

  const testDbUrl =
    process.env.DATABASE_URL || "postgres://grey@localhost:5432/swms_test";
  const baseTime = new Date("2026-10-24T06:00:00+07:00");

  beforeAll(async () => {
    await runMigration("up", testDbUrl);
    await runSeed(testDbUrl);

    clock = new VirtualClock(baseTime);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(CLOCK_TOKEN)
      .useValue(clock)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    db = moduleRef.get<DatabaseService>(DatabaseService);
    pool = (db as any).pool;
    scheduledJobs = moduleRef.get<ScheduledJobsService>(ScheduledJobsService);
    dispatchService = moduleRef.get<DispatchService>(DispatchService);
    mealPlannerService = moduleRef.get<MealPlannerService>(MealPlannerService);
    legalGuardService = moduleRef.get<LegalGuardService>(LegalGuardService);

    // Login Admin
    const adminRes = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: "admin", password: "password123" });
    adminToken = adminRes.body.accessToken;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("1. Generates and persists break plan into PostgreSQL break_plans table", async () => {
    const shiftKey = "2026-10-24:MORNING";

    // Clean previous break plans for this shift if any
    await pool.query(`DELETE FROM break_plans WHERE shift_key = $1;`, [shiftKey]);

    const result = await mealPlannerService.generateAndPersistPlan({
      shiftKey,
      shiftCode: "MORNING",
      date: "2026-10-24"
    });

    expect(result.feasible).toBe(true);
    expect(result.plan).toHaveLength(7);

    // Verify rows in Postgres break_plans table
    const rows = await pool.query(
      `SELECT shift_key, post_id, float_guard_id, slot, status 
       FROM break_plans 
       WHERE shift_key = $1 
       ORDER BY lower(slot) ASC;`,
      [shiftKey]
    );

    expect(rows.rows).toHaveLength(7);
    expect(rows.rows[0].post_id).toBe("G1");
    expect(rows.rows[0].status).toBe("PLANNED");
    expect(rows.rows[0].slot).toBeDefined();

    // REST API query GET /break-plans?shift=...
    const apiRes = await request(app.getHttpServer())
      .get(`/break-plans?shift=${encodeURIComponent(shiftKey)}`)
      .set("Authorization", `Bearer ${adminToken}`);

    if (apiRes.status !== 200) {
      console.log("apiRes 500 error:", apiRes.status, apiRes.body, apiRes.text);
    }

    expect(apiRes.status).toBe(200);
    expect(apiRes.body.shiftKey).toBe(shiftKey);
    expect(apiRes.body.slots).toHaveLength(7);
    expect(apiRes.body.slots[0].postId).toBe("G1");
  });

  it("2. Schedules slot jobs: jumping virtual clock triggers MEAL_WINDOW_OPEN transition", async () => {
    const shiftKey = "2026-10-24:MORNING";

    // First ensure post G1 is OCCUPIED by a guard
    const guardRes = await pool.query(`SELECT id FROM guards WHERE role = 'GUARD' LIMIT 1;`);
    const originalGuardId = Number(guardRes.rows[0].id);

    // Set G1 to OCCUPIED
    await pool.query(
      `UPDATE post_state 
       SET status = 'OCCUPIED', guard_id = $1, since = $2, deadline_at = NULL 
       WHERE post_id = 'G1';`,
      [originalGuardId, clock.now()]
    );

    // Schedule slot jobs for this shift
    // For G1, slot start is 10:00:00+07:00, handover buffer is 5 min -> job fires at 09:55:00+07:00
    await mealPlannerService.scheduleSlotJobs(shiftKey);

    // Confirm post G1 is still OCCUPIED before 09:55
    const preState = await pool.query(`SELECT status FROM post_state WHERE post_id = 'G1';`);
    expect(preState.rows[0].status).toBe("OCCUPIED");

    // Advance VirtualClock to 09:55:00+07:00 (slot start - handover buffer)
    const fireTime = new Date("2026-10-24T09:55:00+07:00");
    await clock.jumpTo(fireTime);

    // Give microtasks a tick to complete
    await new Promise((resolve) => process.nextTick(resolve));

    // Post G1 should now have transitioned to HANDOVER_PENDING
    const postState = await pool.query(
      `SELECT status, deadline_at FROM post_state WHERE post_id = 'G1';`
    );
    expect(postState.rows[0].status).toBe("HANDOVER_PENDING");
    expect(postState.rows[0].deadline_at).toBeDefined();

    // Verify outbox event emitted
    const outboxRes = await pool.query(
      `SELECT payload FROM outbox WHERE topic = 'post.state_changed' AND (payload->'payload'->>'postId' = 'G1' OR payload->>'postId' = 'G1') ORDER BY id DESC LIMIT 1;`
    );
    expect(outboxRes.rows.length).toBeGreaterThan(0);
    const parsedPayload =
      typeof outboxRes.rows[0].payload === "string"
        ? JSON.parse(outboxRes.rows[0].payload)
        : outboxRes.rows[0].payload;
    const innerPayload = parsedPayload.payload || parsedPayload;
    expect(innerPayload.toStatus).toBe("HANDOVER_PENDING");
  });

  it("3. Re-plan with 1 float (e.g. sick leave) via endpoint returns feasible: false and suggestions", async () => {
    const shiftKey = "2026-10-24:MORNING";

    // Mark 1 float as sick or pass availableFloatIds override with 1 float
    const floatsRes = await pool.query(
      `SELECT id FROM guards WHERE role = 'FLOAT' AND float_kind = 'TIER1_RELIEF' ORDER BY id ASC;`
    );
    expect(floatsRes.rows.length).toBeGreaterThanOrEqual(2);
    const remainingFloatId = Number(floatsRes.rows[0].id);

    // Call POST /break-plans/replan
    const replanRes = await request(app.getHttpServer())
      .post("/break-plans/replan")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        shiftKey,
        shiftCode: "MORNING",
        date: "2026-10-24",
        availableFloatIds: [remainingFloatId] // Only 1 float available
      });

    if (replanRes.status !== 200) {
      console.log("replan error:", replanRes.status, replanRes.body);
    }
    expect(replanRes.status).toBe(200);
    expect(replanRes.body.feasible).toBe(false);
    expect(replanRes.body.suggestions).toContain("EXTEND_WINDOW");
    expect(replanRes.body.suggestions).toContain("USE_TIER2_RELIEF");
    expect(replanRes.body.suggestions).toContain("CALL_IN_EXTRA_GUARD");
  });

  describe("4. DB-backed LegalGuard validation against seeded database", () => {
    it("accepts active guard with valid certifications and compliant rest", async () => {
      // Find a valid guard with valid cert
      const guardRes = await pool.query(
        `SELECT g.id, g.code 
         FROM guards g 
         JOIN certifications c ON c.guard_id = g.id 
         WHERE g.active = true AND c.expires_on > '2026-10-24' 
         LIMIT 1;`
      );
      const validGuardId = Number(guardRes.rows[0].id);

      const candidate = {
        guardId: validGuardId,
        startTime: new Date("2026-10-24T06:00:00+07:00"),
        endTime: new Date("2026-10-24T14:00:00+07:00"),
        isOvertime: false
      };

      const result = await legalGuardService.validate(candidate);
      expect(result.ok).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it("rejects guard with expired certification (deliberately seeded in M1)", async () => {
      // Per §2.3: "2 deliberately expired ones (used by LegalGuard tests)"
      const expiredRes = await pool.query(
        `SELECT g.id, g.code, c.expires_on 
         FROM guards g 
         JOIN certifications c ON c.guard_id = g.id 
         WHERE c.expires_on < '2026-10-24' 
         LIMIT 1;`
      );
      expect(expiredRes.rows.length).toBeGreaterThan(0);
      const expiredGuardId = Number(expiredRes.rows[0].id);

      const candidate = {
        guardId: expiredGuardId,
        startTime: new Date("2026-10-24T06:00:00+07:00"),
        endTime: new Date("2026-10-24T14:00:00+07:00"),
        isOvertime: false
      };

      const result = await legalGuardService.validate(candidate);
      expect(result.ok).toBe(false);
      expect(result.violations).toContain("CERTIFICATE_EXPIRED");
    });

    it("rejects guard with double-booking against existing active assignment", async () => {
      const guardRes = await pool.query(`SELECT id FROM guards WHERE active = true LIMIT 1;`);
      const testGuardId = Number(guardRes.rows[0].id);

      // Insert an active assignment
      await pool.query(
        `INSERT INTO assignments (guard_id, post_id, shift, period, status, role)
         VALUES ($1, 'G1', 'MORNING', tstzrange('2026-10-24 06:00:00+07', '2026-10-24 14:00:00+07', '[)'), 'ACTIVE', 'FIXED');`,
        [testGuardId]
      );

      // Attempt candidate overlapping 10:00 to 18:00
      const overlappingCandidate = {
        guardId: testGuardId,
        startTime: new Date("2026-10-24T10:00:00+07:00"),
        endTime: new Date("2026-10-24T18:00:00+07:00"),
        isOvertime: false
      };

      const result = await legalGuardService.validate(overlappingCandidate);
      expect(result.ok).toBe(false);
      expect(result.violations).toContain("DOUBLE_BOOKING");

      // Cleanup
      await pool.query(
        `DELETE FROM assignments WHERE guard_id = $1 AND post_id = 'G1' AND shift = 'MORNING';`,
        [testGuardId]
      );
    });
  });

  describe("5. REST Endpoints for LegalGuard & BreakPlans Generation", () => {
    it("POST /dispatch/legal-guard/validate validates candidate via REST API", async () => {
      const guardRes = await pool.query(
        `SELECT g.id FROM guards g JOIN certifications c ON c.guard_id = g.id WHERE g.active = true AND c.expires_on > '2026-10-24' LIMIT 1;`
      );
      const validGuardId = Number(guardRes.rows[0].id);

      const res = await request(app.getHttpServer())
        .post("/dispatch/legal-guard/validate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          guardId: validGuardId,
          startTime: "2026-10-24T06:00:00+07:00",
          endTime: "2026-10-24T14:00:00+07:00",
          isOvertime: false
        });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.violations).toHaveLength(0);
    });

    it("POST /dispatch/legal-guard/cost estimates cost via REST API", async () => {
      const res = await request(app.getHttpServer())
        .post("/dispatch/legal-guard/cost")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          startTime: "2026-10-24T22:00:00+07:00",
          endTime: "2026-10-25T06:00:00+07:00",
          isOvertime: false,
          baseHourlyRate: 100
        });

      expect(res.status).toBe(201);
      expect(res.body.totalCost).toBeCloseTo(1040, 1);
      expect(res.body.regularNightHours).toBe(8);
    });

    it("POST /break-plans/generate creates new plan via REST API", async () => {
      const shiftKey = "2026-10-25:MORNING";
      const res = await request(app.getHttpServer())
        .post("/break-plans/generate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          shiftKey,
          shiftCode: "MORNING",
          date: "2026-10-25",
          scheduleJobs: false
        });

      expect(res.status).toBe(201);
      expect(res.body.feasible).toBe(true);
      expect(res.body.plan).toHaveLength(7);
    });
  });
});
