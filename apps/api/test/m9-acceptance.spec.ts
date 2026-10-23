import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import supertest from "supertest";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { AppModule } from "../src/app.module.js";
import { DatabaseService } from "../src/core/database/database.service.js";
import { CLOCK_TOKEN } from "../src/core/clock/clock.interface.js";
import { VirtualClock } from "../src/core/clock/virtual-clock.js";
import { SimRunner } from "../src/sim/sim-runner.js";
import { ScenarioLoader } from "../src/sim/scenario-loader.js";
import { runMigration } from "../../../db/migrate.js";
import { runSeed } from "../../../db/seed/seed.js";

const { Pool } = pg;
const testDbUrl = process.env.TEST_DATABASE_URL || "postgres://grey@localhost:5432/swms_test";

describe("Milestone M9 Acceptance Criteria — Simulation Harness, Mock Adapters & 8 Scenarios (§13)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let clock: VirtualClock;
  let runner: SimRunner;
  let loader: ScenarioLoader;
  let pool: pg.Pool;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    pool = new Pool({ connectionString: testDbUrl });

    await runMigration("up", testDbUrl);
    await runSeed(testDbUrl);

    clock = new VirtualClock(new Date("2026-11-07T06:00:00+07:00"));

    moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(CLOCK_TOKEN)
      .useValue(clock)
      .compile();

    app = moduleRef.createNestApplication();
    app.enableCors();
    await app.init();

    db = moduleRef.get<DatabaseService>(DatabaseService);
    runner = moduleRef.get<SimRunner>(SimRunner);
    loader = moduleRef.get<ScenarioLoader>(ScenarioLoader);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe("1. Scenario Definitions Validation", () => {
    it("all 8 scenarios (A1, A2, B1, C1, C2, C3, D1, D2) exist and validate against zod schema", async () => {
      const scenarioIds = ["A1", "A2", "B1", "C1", "C2", "C3", "D1", "D2"];
      const listed = await loader.list();

      for (const id of scenarioIds) {
        expect(listed).toContain(id);
        const def = await loader.load(id);
        expect(def.id).toBe(id);
        expect(def.title).toBeTruthy();
        expect(def.seed).toBeDefined();
        expect(def.timeline).toBeDefined();
        expect(def.expect.length).toBeGreaterThan(0);
      }
    });
  });

  describe("2. Execution of the 8 Simulation Scenarios (§13.4)", () => {
    it("Scenario A1: Three absences Sat morning -> G4 occupied, P3 covered by pair, meal replan call-in, Tier 1 0 vacancy", async () => {
      const result = await runner.runScenario("A1");
      expect(result.passed).toBe(true);
      expect(result.assertions.every((a) => a.passed)).toBe(true);
    });

    it("Scenario A2: P8 presence loss -> 30s noise no alert, 120s escalation, filled within 5m, VIOLATION incident", async () => {
      const result = await runner.runScenario("A2");
      expect(result.passed).toBe(true);
      expect(result.assertions.every((a) => a.passed)).toBe(true);
    });

    it("Scenario B1: Understaffing 45/60 -> 7 Tier-1 posts fully staffed, 3 pairs merged, staffing request 15, KPI gap 15/25%", async () => {
      const result = await runner.runScenario("B1");
      expect(result.passed).toBe(true);
      expect(result.assertions.every((a) => a.passed)).toBe(true);
    });

    it("Scenario C1: Normal morning 18 present -> 7 Tier-1 meal relief slots execute via state machine, zero alerts, zero incidents", async () => {
      const result = await runner.runScenario("C1");
      expect(result.passed).toBe(true);
      expect(result.assertions.every((a) => a.passed)).toBe(true);
    });

    it("Scenario C2: Weekend event zone load surge -> REINFORCE proposal from Tier 2 (never Tier 1), accepted -> source=DISPATCH", async () => {
      const result = await runner.runScenario("C2");
      expect(result.passed).toBe(true);
      expect(result.assertions.every((a) => a.passed)).toBe(true);
    });

    it("Scenario C3: Temporary policy override 3 days -> 19 during window, 18 after window, audit log recorded", async () => {
      const result = await runner.runScenario("C3");
      expect(result.passed).toBe(true);
      expect(result.assertions.every((a) => a.passed)).toBe(true);
    });

    it("Scenario D1: Night camera AI motion at G5 -> only night G1 guard receives order, other sockets empty, incident MOTION opened, ack recorded", async () => {
      const result = await runner.runScenario("D1");
      expect(result.passed).toBe(true);
      expect(result.assertions.every((a) => a.passed)).toBe(true);
    });

    it("Scenario D2: Floor 1 fire alarm -> site_state EMERGENCY within 1s, routine timers cancelled, emergency.started broadcast, no VACANT alerts, resumes on clear", async () => {
      const result = await runner.runScenario("D2");
      expect(result.passed).toBe(true);
      expect(result.assertions.every((a) => a.passed)).toBe(true);
    });
  });

  describe("3. Simulation Persistence & Reports (§13.3)", () => {
    it("persists run results to PostgreSQL sim_runs table", async () => {
      const res = await pool.query(
        `SELECT scenario_id, passed, details FROM sim_runs ORDER BY id DESC LIMIT 8;`
      );
      expect(res.rows.length).toBeGreaterThanOrEqual(8);
      for (const row of res.rows) {
        expect(row.passed).toBe(true);
        expect(row.details).toBeDefined();
      }
    });

    it("writes JSON report files to sim-reports/*.json", async () => {
      const reportsDir = path.resolve(process.cwd(), "sim-reports");
      const files = await fs.readdir(reportsDir);

      const scenarioIds = ["A1", "A2", "B1", "C1", "C2", "C3", "D1", "D2"];
      for (const id of scenarioIds) {
        expect(files).toContain(`${id}.json`);
        const content = await fs.readFile(path.join(reportsDir, `${id}.json`), "utf-8");
        const parsed = JSON.parse(content);
        expect(parsed.id).toBe(id);
        expect(parsed.passed).toBe(true);
      }
    });
  });

  describe("4. Sim REST API Endpoints Contract (§12, §13)", () => {
    it("POST /sim/clock/jump jumps virtual clock to target ISO", async () => {
      const res = await supertest(app.getHttpServer())
        .post("/sim/clock/jump")
        .send({ to: "2026-11-07T12:00:00+07:00" });

      expect(res.status).toBe(201);
      expect(res.body.now).toBeDefined();
    });

    it("POST /sim/clock/speed updates simulation clock speed", async () => {
      const res = await supertest(app.getHttpServer())
        .post("/sim/clock/speed")
        .send({ speed: 60 });

      expect(res.status).toBe(201);
      expect(res.body.speed).toBe(60);
    });

    it("GET /sim/clock returns current clock state", async () => {
      const res = await supertest(app.getHttpServer()).get("/sim/clock");
      expect(res.status).toBe(200);
      expect(res.body.now).toBeDefined();
      expect(res.body.speed).toBe(60);
    });

    it("GET /sim/scenarios lists all available scenario IDs", async () => {
      const res = await supertest(app.getHttpServer()).get("/sim/scenarios");
      expect(res.status).toBe(200);
      expect(res.body.scenarios).toHaveLength(8);
    });

    it("POST /sim/scenario/:id/run triggers scenario execution from REST API", async () => {
      const res = await supertest(app.getHttpServer())
        .post("/sim/scenario/C3/run")
        .send({ speed: 1 });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("C3");
      expect(res.body.passed).toBe(true);
    });

    it("POST /sim/reset resets DB to fixture state", async () => {
      const res = await supertest(app.getHttpServer())
        .post("/sim/reset")
        .send({ fixtureSet: "full-roster", date: "2026-11-07" });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("5. Mock Adapters REST Endpoints (§12, §13.2)", () => {
    it("POST /api/mock/camera-ai reports camera motion and dispatches task", async () => {
      const res = await supertest(app.getHttpServer())
        .post("/api/mock/camera-ai")
        .send({ postId: "G5", confidence: 0.95 });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
    });

    it("POST /api/mock/fire-alarm triggers site-wide EMERGENCY mode", async () => {
      const res = await supertest(app.getHttpServer())
        .post("/api/mock/fire-alarm")
        .send({ zone: "FLOOR1" });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);

      const siteRes = await pool.query(
        `SELECT mode FROM site_state WHERE site_id = 'AEON_THANH_KHE_F1';`
      );
      expect(siteRes.rows[0].mode).toBe("EMERGENCY");
    });

    it("POST /api/mock/fire-alarm/clear clears emergency back to NORMAL", async () => {
      const res = await supertest(app.getHttpServer())
        .post("/api/mock/fire-alarm/clear")
        .send();

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);

      const siteRes = await pool.query(
        `SELECT mode FROM site_state WHERE site_id = 'AEON_THANH_KHE_F1';`
      );
      expect(siteRes.rows[0].mode).toBe("NORMAL");
    });

    it("POST /api/mock/gps-stream ingests guard GPS ping through debounce filter", async () => {
      const guardRes = await pool.query(`SELECT id FROM guards WHERE code = 'G01';`);
      const gId = Number(guardRes.rows[0].id);

      const res = await supertest(app.getHttpServer())
        .post("/api/mock/gps-stream")
        .send({
          guardId: gId,
          lat: 16.065,
          lon: 108.202,
          accuracy: 10,
          postId: "G1"
        });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
    });

    it("GET /incidents retrieves logged incidents", async () => {
      const res = await supertest(app.getHttpServer()).get("/incidents");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});
