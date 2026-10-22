import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { INestApplication } from "@nestjs/common";
import pg from "pg";
import { AppModule } from "../src/app.module.js";
import { VirtualClock } from "../src/core/clock/virtual-clock.js";
import { ConfigService } from "../src/modules/policies/config.service.js";
import { CLOCK_TOKEN } from "../src/core/clock/clock.interface.js";
import { runMigration } from "../../../db/migrate.js";
import { runSeed } from "../../../db/seed/seed.js";

const testDbUrl = process.env.TEST_DATABASE_URL || "postgres://grey@localhost:5432/swms_test";
const { Pool } = pg;

describe("Milestone M2 Acceptance Criteria", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let virtualClock: VirtualClock;
  let configService: ConfigService;
  let pool: pg.Pool;
  let adminToken: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    process.env.SIM_MODE = "true";

    pool = new Pool({ connectionString: testDbUrl });
    await runMigration("up", testDbUrl);
    await runSeed(testDbUrl);

    // Initial virtual clock starts at 2026-11-01T00:00:00Z
    virtualClock = new VirtualClock(new Date("2026-11-01T00:00:00.000Z"));

    moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(CLOCK_TOKEN)
      .useValue(virtualClock)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    configService = moduleRef.get<ConfigService>(ConfigService);

    // Log in as admin to get auth token for API calls
    const loginRes = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: "admin", password: "password123" });
    adminToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("1. Virtual clock jump fires timers in order", async () => {
    const clock = new VirtualClock(new Date("2026-11-01T00:00:00.000Z"));
    const events: { name: string; atTime: string; executedAt: string }[] = [];

    // Schedule Timer A at +10s
    clock.schedule(new Date("2026-11-01T00:00:10.000Z"), async () => {
      events.push({
        name: "Timer A",
        atTime: "2026-11-01T00:00:10.000Z",
        executedAt: clock.now().toISOString()
      });
    });

    // Schedule Timer B at +5s, which in turn schedules Timer D at +8s
    clock.schedule(new Date("2026-11-01T00:00:05.000Z"), async () => {
      events.push({
        name: "Timer B",
        atTime: "2026-11-01T00:00:05.000Z",
        executedAt: clock.now().toISOString()
      });

      // Chained timer scheduled during execution
      clock.schedule(new Date("2026-11-01T00:00:08.000Z"), () => {
        events.push({
          name: "Timer D (chained)",
          atTime: "2026-11-01T00:00:08.000Z",
          executedAt: clock.now().toISOString()
        });
      });
    });

    // Schedule Timer C at +15s
    clock.schedule(new Date("2026-11-01T00:00:15.000Z"), () => {
      events.push({
        name: "Timer C",
        atTime: "2026-11-01T00:00:15.000Z",
        executedAt: clock.now().toISOString()
      });
    });

    // Schedule Timer X at +7s, but cancel it immediately
    const cancelX = clock.schedule(new Date("2026-11-01T00:00:07.000Z"), () => {
      events.push({
        name: "Timer X (cancelled)",
        atTime: "2026-11-01T00:00:07.000Z",
        executedAt: clock.now().toISOString()
      });
    });
    cancelX();

    // Before jump, current time is T0
    expect(clock.now().toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(events.length).toBe(0);

    // Jump to +20s
    await clock.jumpTo(new Date("2026-11-01T00:00:20.000Z"));

    // Verify all timers fired in exact chronological order: B (5s) -> D (8s) -> A (10s) -> C (15s)
    expect(events.map((e) => e.name)).toEqual([
      "Timer B",
      "Timer D (chained)",
      "Timer A",
      "Timer C"
    ]);

    // Verify that at the time each callback ran, clock.now() matched the scheduled time
    expect(events[0].executedAt).toBe("2026-11-01T00:00:05.000Z");
    expect(events[1].executedAt).toBe("2026-11-01T00:00:08.000Z");
    expect(events[2].executedAt).toBe("2026-11-01T00:00:10.000Z");
    expect(events[3].executedAt).toBe("2026-11-01T00:00:15.000Z");

    // After jump completed, clock.now() is exactly the target time
    expect(clock.now().toISOString()).toBe("2026-11-01T00:00:20.000Z");

    // Further jump without timers simply advances time
    await clock.advance(5000);
    expect(clock.now().toISOString()).toBe("2026-11-01T00:00:25.000Z");
  });

  it("2. Policy with valid_to expires after a jump", async () => {
    // Set virtual clock to before the override window
    virtualClock.reset(new Date("2026-10-31T00:00:00.000Z"));

    // Check base policy: headcount.fixed MORNING is 14
    const baseFixed = await configService.get<any>("headcount.fixed");
    expect(baseFixed.MORNING).toBe(14);

    // Insert a temporary event override row valid for 3 days:
    // valid_from: 2026-11-01T00:00:00Z, valid_to: 2026-11-04T00:00:00Z, MORNING: 15
    await pool.query(
      `INSERT INTO policies (key, value, valid_from, valid_to)
       VALUES ($1, $2, '2026-11-01T00:00:00.000Z', '2026-11-04T00:00:00.000Z')
       ON CONFLICT (key, valid_from) DO UPDATE SET value = EXCLUDED.value, valid_to = EXCLUDED.valid_to;`,
      ["headcount.fixed", JSON.stringify({ MORNING: 15, AFTERNOON: 14, NIGHT: 6 })]
    );
    configService.invalidate("headcount.fixed");

    // Jump into the active window: 2026-11-02T10:00:00Z
    await virtualClock.jumpTo(new Date("2026-11-02T10:00:00.000Z"));

    // ConfigService.get resolves the active override (MORNING = 15)
    const activeOverride = await configService.get<any>("headcount.fixed");
    expect(activeOverride.MORNING).toBe(15);

    // Also verify via REST API endpoint GET /policies/headcount.fixed
    const resInside = await request(app.getHttpServer())
      .get("/policies/headcount.fixed")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(resInside.status).toBe(200);
    expect(resInside.body.value.MORNING).toBe(15);

    // Jump past valid_to: 2026-11-05T00:00:00Z
    await virtualClock.jumpTo(new Date("2026-11-05T00:00:00.000Z"));

    // Without any code path or background job restoring it, ConfigService resolves the base policy (MORNING = 14)
    const afterExpire = await configService.get<any>("headcount.fixed");
    expect(afterExpire.MORNING).toBe(14);

    const resAfter = await request(app.getHttpServer())
      .get("/policies/headcount.fixed")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(resAfter.status).toBe(200);
    expect(resAfter.body.value.MORNING).toBe(14);
  });

  it("3. Changing K via API changes next calc without restart", async () => {
    // Ensure virtual clock is at a clean timestamp
    virtualClock.reset(new Date("2026-11-10T08:00:00.000Z"));

    // Check initial staffing calc before change
    const initialCalc = await configService.calculateStaffing();
    // Default slots = 44, K = 1.35 -> required = 60, present = 45, gap = 15
    expect(initialCalc.slotsPerDay).toBe(44);
    expect(initialCalc.k).toBe(1.35);
    expect(initialCalc.required).toBe(60);
    expect(initialCalc.present).toBe(45);
    expect(initialCalc.gap).toBe(15);

    // Change K via API: PUT /policies/relief.k_override with value 1.40
    const updateRes = await request(app.getHttpServer())
      .put("/policies/relief.k_override")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ value: 1.40 });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.key).toBe("relief.k_override");
    expect(updateRes.body.value).toBe(1.40);

    // Verify audit_log entry was recorded in the database
    const auditRes = await pool.query(
      `SELECT * FROM audit_log WHERE entity = 'policies' ORDER BY id DESC LIMIT 1;`
    );
    expect(auditRes.rows.length).toBe(1);
    const auditEntry = auditRes.rows[0];
    expect(auditEntry.action).toBe("POLICY_UPDATE");
    expect(auditEntry.before).toBe(1.35);
    expect(auditEntry.after).toBe(1.40);

    // Verify the very next calc immediately reflects the change WITHOUT app restart
    const nextCalc = await configService.calculateStaffing();
    // With K = 1.40: required = ceil(44 * 1.40) = 62, gap = 62 - 45 = 17
    expect(nextCalc.k).toBe(1.40);
    expect(nextCalc.required).toBe(62);
    expect(nextCalc.gap).toBe(17);

    // Also verify POST /policies/preview works for dry-run overrides without saving
    const previewRes = await request(app.getHttpServer())
      .post("/policies/preview")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        overrides: {
          "relief.k_override": 1.50
        }
      });

    expect(previewRes.status).toBe(200);
    // Preview with K = 1.50: required = ceil(44 * 1.50) = 66, gap = 21
    expect(previewRes.body.k).toBe(1.50);
    expect(previewRes.body.required).toBe(66);
    expect(previewRes.body.gap).toBe(21);

    // After preview, actual calc is STILL 1.40 (not overwritten)
    const currentCalc = await configService.calculateStaffing();
    expect(currentCalc.k).toBe(1.40);
    expect(currentCalc.required).toBe(62);
  });
});
