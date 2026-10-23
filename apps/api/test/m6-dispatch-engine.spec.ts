import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import pg from "pg";
import { AppModule } from "../src/app.module.js";
import { DatabaseService } from "../src/core/database/database.service.js";
import { CLOCK_TOKEN } from "../src/core/clock/clock.interface.js";
import { VirtualClock } from "../src/core/clock/virtual-clock.js";
import { DispatchService } from "../src/modules/dispatch/dispatch.service.js";
import { FillVacancyService } from "../src/modules/dispatch/engine/fill-vacancy.service.js";
import { RankingService } from "../src/modules/dispatch/engine/ranking.service.js";
import { runMigration } from "../../../db/migrate.js";
import { runSeed } from "../../../db/seed/seed.js";

const { Pool } = pg;

describe("Milestone M6 Acceptance Criteria — Dispatch Engine & Cascade", () => {
  let app: INestApplication;
  let db: DatabaseService;
  let clock: VirtualClock;
  let pool: pg.Pool;
  let dispatchService: DispatchService;
  let fillVacancyService: FillVacancyService;
  let rankingService: RankingService;
  let adminToken: string;
  let dispatcherToken: string;
  let guardToken: string;

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

    db = moduleRef.get(DatabaseService);
    pool = db.getPool();
    dispatchService = moduleRef.get(DispatchService);
    fillVacancyService = moduleRef.get(FillVacancyService);
    rankingService = moduleRef.get(RankingService);

    // Obtain JWT tokens for testing
    const adminRes = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: "admin", password: "password123" });
    adminToken = adminRes.body.accessToken;

    const dispRes = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: "dispatcher", password: "password123" });
    dispatcherToken = dispRes.body.accessToken;

    const guardRes = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: "guard01", password: "password123" });
    guardToken = guardRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Reset seed for a pristine baseline
    await runSeed(dbUrl);
    clock.jumpTo(new Date("2026-11-07T07:30:00+07:00"));
  });

  describe("1. Candidate Ranking Function (§8.2)", () => {
    it("should calculate ranking score based on distance, OT, and dispatches today", async () => {
      // weights: distance=1, ot=2, load=1.5
      // candidate 1: travel 5m, OT 120m (2h), dispatches 1 => 1*5 + 2*2 + 1.5*1 = 10.5
      // candidate 2: travel 10m, OT 0m, dispatches 0 => 1*10 + 0 + 0 = 10.0
      // candidate 3: travel 5m, OT 60m (1h), dispatches 3 => 1*5 + 2*1 + 1.5*3 = 11.5
      const candidates = [
        { id: 1, code: "G01", role: "GUARD", floatKind: null, otMinutesMonth: 120, dispatchesToday: 1, currentPostId: "G2" },
        { id: 2, code: "G02", role: "GUARD", floatKind: null, otMinutesMonth: 0, dispatchesToday: 0, currentPostId: "G1" },
        { id: 3, code: "G03", role: "GUARD", floatKind: null, otMinutesMonth: 60, dispatchesToday: 3, currentPostId: "G3" }
      ];

      const ranked = await rankingService.rankCandidates(candidates, "G4", {
        weights: { distance: 1, ot: 2, load: 1.5 }
      });

      expect(ranked).toHaveLength(3);
      // G02 has score 10.0, G01 has score 10.5, G03 has score 11.5
      expect(ranked[0].candidate.code).toBe("G02");
      expect(ranked[1].candidate.code).toBe("G01");
      expect(ranked[2].candidate.code).toBe("G03");
    });

    it("should break ranking score ties by guard.id ASC", async () => {
      const candidates = [
        { id: 25, code: "G25", role: "GUARD", floatKind: null, otMinutesMonth: 0, dispatchesToday: 0, currentPostId: "G1" },
        { id: 10, code: "G10", role: "GUARD", floatKind: null, otMinutesMonth: 0, dispatchesToday: 0, currentPostId: "G1" },
        { id: 18, code: "G18", role: "GUARD", floatKind: null, otMinutesMonth: 0, dispatchesToday: 0, currentPostId: "G1" }
      ];

      const ranked = await rankingService.rankCandidates(candidates, "G1", {
        weights: { distance: 1, ot: 2, load: 1.5 }
      });

      expect(ranked.map((r) => r.candidate.id)).toEqual([10, 18, 25]);
    });
  });

  describe("2. The 6-Step FillVacancy Cascade for Tier 1 Posts (§8.2)", () => {
    it("Step 1: Should fill Tier 1 vacancy with available FLOAT_T1", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN;");

        // Seed an active MORNING assignment for Float 1 (TIER1_RELIEF)
        const floatRes = await client.query(
          `SELECT id FROM guards WHERE float_kind = 'TIER1_RELIEF' LIMIT 1;`
        );
        const floatId = floatRes.rows[0].id;

        await client.query(
          `INSERT INTO assignments (guard_id, role, shift, period, source, status)
           VALUES ($1, 'FLOAT_T1', 'MORNING', tstzrange('2026-11-07 06:00:00+07', '2026-11-07 14:00:00+07', '[)'), 'ROSTER', 'ACTIVE');`,
          [floatId]
        );

        // Call fillVacancy for G4 (Tier 1)
        const res = await fillVacancyService.fillVacancy(client, {
          postId: "G4",
          shiftKey: "2026-11-07:MORNING",
          now: clock.now()
        });

        await client.query("COMMIT;");

        expect(res.success).toBe(true);
        expect(res.step).toBe(1);
        expect(res.stepName).toBe("FLOAT_T1");
        expect(res.winner?.id).toBe(Number(floatId));
        expect(res.actions[0].action).toBe("ASSIGN_FLOAT_T1");

        // Verify post_state is now OCCUPIED by floatId
        const postState = await pool.query(`SELECT status, guard_id FROM post_state WHERE post_id = 'G4';`);
        expect(postState.rows[0].status).toBe("OCCUPIED");
        expect(Number(postState.rows[0].guard_id)).toBe(Number(floatId));
      } finally {
        client.release();
      }
    });

    it("Step 2: Should fill Tier 1 vacancy with FLOAT_GEN when no FLOAT_T1 is free", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN;");

        // Seed active assignment for FLOAT_GEN
        const floatGenRes = await client.query(
          `SELECT id FROM guards WHERE float_kind = 'GENERAL' LIMIT 1;`
        );
        const floatGenId = floatGenRes.rows[0].id;

        await client.query(
          `INSERT INTO assignments (guard_id, role, shift, period, source, status)
           VALUES ($1, 'FLOAT_GEN', 'MORNING', tstzrange('2026-11-07 06:00:00+07', '2026-11-07 14:00:00+07', '[)'), 'ROSTER', 'ACTIVE');`,
          [floatGenId]
        );

        // Fill vacancy on G5 (Tier 1)
        const res = await fillVacancyService.fillVacancy(client, {
          postId: "G5",
          shiftKey: "2026-11-07:MORNING",
          now: clock.now()
        });

        await client.query("COMMIT;");

        expect(res.success).toBe(true);
        expect(res.step).toBe(2);
        expect(res.stepName).toBe("FLOAT_GEN");
        expect(res.winner?.id).toBe(Number(floatGenId));
      } finally {
        client.release();
      }
    });

    it("Step 3: Should pull Tier-2 guard when no floats are free and transition source post", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN;");

        // Setup: P2 (Tier 2, paired with P3) is OCCUPIED by guard 10
        // P3 is also OCCUPIED by guard 11 (so P2 is safe to pull, becoming COVERED_BY_PAIR)
        const g10Res = await client.query(`SELECT id FROM guards WHERE code = 'G10';`);
        const g11Res = await client.query(`SELECT id FROM guards WHERE code = 'G11';`);
        const g10 = g10Res.rows[0].id;
        const g11 = g11Res.rows[0].id;

        await client.query(
          `UPDATE post_state SET status = 'OCCUPIED', guard_id = $1 WHERE post_id = 'P2';`,
          [g10]
        );
        await client.query(
          `UPDATE post_state SET status = 'OCCUPIED', guard_id = $1 WHERE post_id = 'P3';`,
          [g11]
        );

        // Fill vacancy on P1 (Tier 1)
        const res = await fillVacancyService.fillVacancy(client, {
          postId: "P1",
          shiftKey: "2026-11-07:MORNING",
          now: clock.now()
        });

        await client.query("COMMIT;");

        expect(res.success).toBe(true);
        expect(res.step).toBe(3);
        expect(res.stepName).toBe("TIER2_PULL");
        expect(res.winner?.id).toBe(Number(g10));

        // P1 should now be OCCUPIED by g10
        const p1State = await pool.query(`SELECT status, guard_id FROM post_state WHERE post_id = 'P1';`);
        expect(p1State.rows[0].status).toBe("OCCUPIED");
        expect(Number(p1State.rows[0].guard_id)).toBe(Number(g10));

        // P2 (the source post) should have transitioned to COVERED_BY_PAIR
        const p2State = await pool.query(`SELECT status, guard_id FROM post_state WHERE post_id = 'P2';`);
        expect(p2State.rows[0].status).toBe("COVERED_BY_PAIR");
      } finally {
        client.release();
      }
    });

    it("Step 5: Should propose EARLY_CALL_IN to off-shift guard passing LegalGuard and reject failing ones", async () => {
      // Expire certificate for one guard in DB so LegalGuard rejects them
      await pool.query(
        `UPDATE certifications SET expires_on = '2024-01-01' WHERE guard_id = (SELECT id FROM guards WHERE role = 'GUARD' LIMIT 1);`
      );

      const client = await pool.connect();
      try {
        await client.query("BEGIN;");

        // Ensure no on-duty floats, no pullable tier 2 guards, no supervisor
        // Fill vacancy on P8 (Tier 1)
        const res = await fillVacancyService.fillVacancy(client, {
          postId: "P8",
          shiftKey: "2026-11-07:MORNING",
          now: clock.now()
        });

        await client.query("COMMIT;");

        expect(res.success).toBe(true);
        expect(res.step).toBe(5);
        expect(res.stepName).toBe("EARLY_CALL_IN");
        expect(res.orderKind).toBe("EARLY_CALL_IN");
        expect(res.orderStatus).toBe("SENT");
        expect(res.winner).toBeDefined();

        // Explain must list rejected candidates with reasons
        expect(res.rejected.length).toBeGreaterThan(0);
        // Candidate with expired certificate (guard 44 or 45 from seed) must be rejected with CERTIFICATE_EXPIRED
        const expiredReject = res.rejected.find((r) => r.reason.includes("CERTIFICATE_EXPIRED"));
        expect(expiredReject).toBeDefined();

        // Verify proposal in dispatch_orders
        const orderRes = await pool.query(
          `SELECT id, status, kind, to_guard_id, to_post FROM dispatch_orders WHERE to_post = 'P8';`
        );
        expect(orderRes.rows.length).toBe(1);
        expect(orderRes.rows[0].status).toBe("SENT");
        expect(orderRes.rows[0].kind).toBe("EARLY_CALL_IN");
      } finally {
        client.release();
      }
    });
  });

  describe("3. Tier 2 Vacancy Merge & Gap Tolerance (§8.2)", () => {
    it("should merge with pair post (COVERED_BY_PAIR) when paired post is OCCUPIED", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN;");

        // Set P2 to OCCUPIED by guard 1
        const gRes = await client.query(`SELECT id FROM guards LIMIT 1;`);
        const gId = gRes.rows[0].id;
        await client.query(`UPDATE post_state SET status = 'OCCUPIED', guard_id = $1 WHERE post_id = 'P2';`, [gId]);

        // Vacancy at P3 (paired with P2)
        const res = await fillVacancyService.fillVacancy(client, {
          postId: "P3",
          shiftKey: "2026-11-07:MORNING",
          now: clock.now()
        });

        await client.query("COMMIT;");

        expect(res.success).toBe(true);
        expect(res.stepName).toBe("TIER2_PAIR_MERGE");
        expect(res.orderKind).toBe("MERGE_POST");

        const p3State = await pool.query(`SELECT status, guard_id FROM post_state WHERE post_id = 'P3';`);
        expect(p3State.rows[0].status).toBe("COVERED_BY_PAIR");
        expect(Number(p3State.rows[0].guard_id)).toBe(Number(gId));
      } finally {
        client.release();
      }
    });

    it("should transition to VACANT_PLANNED if pair post is not occupied but max_vacant_sec > 0", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN;");

        // Ensure P2 is NOT occupied
        await client.query(`UPDATE post_state SET status = 'NOT_ACTIVE', guard_id = NULL WHERE post_id = 'P2';`);

        // Vacancy at P3 (Tier 2, max_vacant_sec = 900)
        const res = await fillVacancyService.fillVacancy(client, {
          postId: "P3",
          shiftKey: "2026-11-07:MORNING",
          now: clock.now()
        });

        await client.query("COMMIT;");

        expect(res.success).toBe(true);
        expect(res.stepName).toBe("TIER2_ACCEPT_GAP");

        const p3State = await pool.query(`SELECT status, deadline_at FROM post_state WHERE post_id = 'P3';`);
        expect(p3State.rows[0].status).toBe("VACANT_PLANNED");
        expect(p3State.rows[0].deadline_at).toBeDefined();
      } finally {
        client.release();
      }
    });
  });

  describe("4. Dispatch Orders Lifecycle (Ack, Decline, Expire, Override) (§11, §12)", () => {
    it("Ack: guard acknowledges order -> post becomes OCCUPIED and assignment created", async () => {
      // 1. Create a SENT order
      const gRes = await pool.query(`SELECT id FROM guards WHERE code = 'G01';`);
      const gId = Number(gRes.rows[0].id);

      const insRes = await pool.query(
        `INSERT INTO dispatch_orders (shift_key, kind, to_guard_id, to_post, status, explain, sent_at)
         VALUES ('2026-11-07:MORNING', 'EARLY_CALL_IN', $1, 'G4', 'SENT', '{}', now())
         RETURNING id;`,
        [gId]
      );
      const orderId = Number(insRes.rows[0].id);

      // 2. Ack order via API
      const res = await request(app.getHttpServer())
        .post(`/dispatch/orders/${orderId}/ack`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send();

      if (res.status !== 201) {
        console.error("DEBUG ACK ERROR:", res.status, res.body);
      }

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("ACKED");
      expect(res.body.ackAt).toBeDefined();

      // Verify post G4 is now OCCUPIED
      const postState = await pool.query(`SELECT status, guard_id FROM post_state WHERE post_id = 'G4';`);
      expect(postState.rows[0].status).toBe("OCCUPIED");
      expect(Number(postState.rows[0].guard_id)).toBe(gId);
    });

    it("Decline: guard declines order -> status becomes DECLINED and triggers re-fill", async () => {
      const gRes = await pool.query(`SELECT id FROM guards WHERE code = 'G02';`);
      const gId = Number(gRes.rows[0].id);

      const insRes = await pool.query(
        `INSERT INTO dispatch_orders (shift_key, kind, to_guard_id, to_post, status, explain, sent_at)
         VALUES ('2026-11-07:MORNING', 'EARLY_CALL_IN', $1, 'G5', 'SENT', '{}', now())
         RETURNING id;`,
        [gId]
      );
      const orderId = Number(insRes.rows[0].id);

      const res = await request(app.getHttpServer())
        .post(`/dispatch/orders/${orderId}/decline`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "Cannot make it" });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("DECLINED");
    });

    it("Expire: checkExpiredOrders expires stale SENT orders past ack_timeout_sec", async () => {
      // Create order sent 120s ago (timeout is 60s)
      const pastTime = new Date(clock.now().getTime() - 120 * 1000);
      const insRes = await pool.query(
        `INSERT INTO dispatch_orders (shift_key, kind, to_guard_id, to_post, status, explain, sent_at)
         VALUES ('2026-11-07:MORNING', 'EARLY_CALL_IN', 1, 'G1', 'SENT', '{}', $1)
         RETURNING id;`,
        [pastTime]
      );
      const orderId = Number(insRes.rows[0].id);

      const expiredCount = await dispatchService.checkExpiredOrders("2026-11-07:MORNING");
      expect(expiredCount).toBeGreaterThanOrEqual(1);

      const order = await dispatchService.getOrderById(orderId);
      expect(order.status).toBe("EXPIRED");
    });

    it("Override: Dispatcher manual override assigns guard and records explain", async () => {
      const gRes = await pool.query(`SELECT id FROM guards WHERE code = 'G05';`);
      const gId = Number(gRes.rows[0].id);

      const res = await request(app.getHttpServer())
        .post("/dispatch/override")
        .set("Authorization", `Bearer ${dispatcherToken}`)
        .send({
          postId: "G1",
          guardId: gId,
          shiftKey: "2026-11-07:MORNING",
          reason: "Dispatcher manual intervention"
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("ACKED");
      expect(res.body.kind).toBe("OVERRIDE");
      expect(res.body.toGuardId).toBe(gId);

      // Verify post_state
      const postState = await pool.query(`SELECT status, guard_id FROM post_state WHERE post_id = 'G1';`);
      expect(postState.rows[0].status).toBe("OCCUPIED");
      expect(Number(postState.rows[0].guard_id)).toBe(gId);
    });
  });

  describe("5. Absence Reporting API & Idempotency (§12)", () => {
    it("POST /absences reports absence and triggers automated dispatch", async () => {
      const gRes = await pool.query(`SELECT id FROM guards WHERE code = 'G04';`);
      const gId = Number(gRes.rows[0].id);

      // Set guard assigned to G4
      await pool.query(
        `INSERT INTO assignments (guard_id, post_id, role, shift, period, source, status)
         VALUES ($1, 'G4', 'FIXED', 'MORNING', tstzrange('2026-11-07 06:00:00+07', '2026-11-07 14:00:00+07', '[)'), 'ROSTER', 'ACTIVE');`,
        [gId]
      );
      await pool.query(`UPDATE post_state SET status = 'OCCUPIED', guard_id = $1 WHERE post_id = 'G4';`, [gId]);

      const res = await request(app.getHttpServer())
        .post("/absences")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Idempotency-Key", "test-absence-001")
        .send({
          guardId: gId,
          forShift: "MORNING",
          forDate: "2026-11-07",
          reason: "Sudden illness"
        });

      expect(res.status).toBe(201);
      expect(Number(res.body.guard_id)).toBe(gId);
      expect(res.body.status).toBe("HANDLED");

      // Verify idempotent replay with same key returns identical record
      const replayRes = await request(app.getHttpServer())
        .post("/absences")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Idempotency-Key", "test-absence-001")
        .send({
          guardId: gId,
          forShift: "MORNING",
          forDate: "2026-11-07"
        });

      expect(replayRes.status).toBe(201);
      expect(replayRes.body.id).toBe(res.body.id);
    });
  });
});
