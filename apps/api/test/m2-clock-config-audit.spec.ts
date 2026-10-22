import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module.js";
import { RealClock } from "../src/core/clock/real-clock.js";
import { VirtualClock } from "../src/core/clock/virtual-clock.js";
import { CLOCK_TOKEN } from "../src/core/clock/clock.interface.js";
import { ScheduledJobsService } from "../src/core/jobs/scheduled-jobs.service.js";
import { AuditService } from "../src/core/audit/audit.service.js";
import { ConfigService } from "../src/modules/policies/config.service.js";
import { runMigration } from "../../../db/migrate.js";
import { runSeed } from "../../../db/seed/seed.js";

const testDbUrl = process.env.TEST_DATABASE_URL || "postgres://grey@localhost:5432/swms_test";

describe("Milestone M2 Detailed Unit & Integration Tests", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let virtualClock: VirtualClock;
  let scheduledJobsService: ScheduledJobsService;
  let auditService: AuditService;
  let configService: ConfigService;
  let adminToken: string;
  let guardToken: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    process.env.SIM_MODE = "true";

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

    scheduledJobsService = moduleRef.get<ScheduledJobsService>(ScheduledJobsService);
    auditService = moduleRef.get<AuditService>(AuditService);
    configService = moduleRef.get<ConfigService>(ConfigService);

    // Admin login
    const adminLogin = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: "admin", password: "password123" });
    adminToken = adminLogin.body.accessToken;

    // Guard login
    const guardLogin = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: "guard01", password: "password123" });
    guardToken = guardLogin.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe("RealClock & VirtualClock", () => {
    it("RealClock returns a valid current date and can schedule", async () => {
      const realClock = new RealClock();
      const now = realClock.now();
      expect(now).toBeInstanceOf(Date);
      expect(Number.isNaN(now.getTime())).toBe(false);

      let executed = false;
      const cancel = realClock.schedule(new Date(Date.now() + 50), () => {
        executed = true;
      });
      expect(typeof cancel).toBe("function");
      cancel();
      // Wait to ensure cancelled timer does not fire
      await new Promise((r) => setTimeout(r, 70));
      expect(executed).toBe(false);
    });

    it("VirtualClock setSpeed can be activated and destroyed safely", () => {
      const clock = new VirtualClock();
      clock.setSpeed(10);
      clock.setSpeed(0);
      clock.destroy();
    });
  });

  describe("ScheduledJobsService", () => {
    it("schedules a job and executes handler upon clock jump", async () => {
      const executedJobs: any[] = [];

      scheduledJobsService.registerHandler("test.meal_window", async (job) => {
        executedJobs.push({
          data: job.data,
          firedAt: virtualClock.now().toISOString()
        });
      });

      const targetDate = new Date(virtualClock.now().getTime() + 60000); // +1 min
      await scheduledJobsService.schedule("test.meal_window", { postId: "G1" }, targetDate);

      expect(executedJobs.length).toBe(0);

      // Jump clock past target
      await virtualClock.jumpTo(new Date(targetDate.getTime() + 1000));

      expect(executedJobs.length).toBe(1);
      expect(executedJobs[0].data.postId).toBe("G1");
      expect(executedJobs[0].firedAt).toBe(targetDate.toISOString());
    });

    it("cancelling a job prevents it from running", async () => {
      let run = false;
      scheduledJobsService.registerHandler("test.cancel", () => {
        run = true;
      });

      const target = new Date(virtualClock.now().getTime() + 30000);
      const jobId = await scheduledJobsService.schedule("test.cancel", {}, target, { key: "cancel_me" });
      await scheduledJobsService.cancel(jobId);

      await virtualClock.jumpTo(new Date(target.getTime() + 5000));
      expect(run).toBe(false);
    });
  });

  describe("AuditService", () => {
    it("records audit logs with actor and payload", async () => {
      const entry = await auditService.log({
        actor_id: 1,
        action: "TEST_ACTION",
        entity: "guards",
        before: { phone: "0900000001" },
        after: { phone: "0900000002" }
      });

      expect(entry.id).toBeDefined();
      expect(entry.action).toBe("TEST_ACTION");

      const recent = await auditService.getRecent(10, "guards");
      expect(recent.length).toBeGreaterThan(0);
      expect(recent[0].action).toBe("TEST_ACTION");
    });
  });

  describe("ConfigService & Policies REST API", () => {
    it("GET /policies returns all active policies", async () => {
      const res = await request(app.getHttpServer())
        .get("/policies")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(20);
    });

    it("GET /policies/:key returns specific policy or 404 for unknown", async () => {
      const res = await request(app.getHttpServer())
        .get("/policies/meal.handover_buffer_min")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.key).toBe("meal.handover_buffer_min");
      expect(res.body.value).toBe(5);

      const notFound = await request(app.getHttpServer())
        .get("/policies/non_existent_key")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(notFound.status).toBe(404);
    });

    it("PUT /policies/:key is forbidden for GUARD role (RBAC)", async () => {
      const res = await request(app.getHttpServer())
        .put("/policies/relief.k_override")
        .set("Authorization", `Bearer ${guardToken}`)
        .send({ value: 1.5 });

      expect(res.status).toBe(403);
    });

    it("ConfigService.getAll returns key-value map of active policies", async () => {
      const all = await configService.getAll();
      expect(all["meal.handover_buffer_min"]).toBe(5);
      expect(all["headcount.fixed"]).toBeDefined();
    });
  });
});
