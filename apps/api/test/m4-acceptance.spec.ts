import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Pool } from "pg";
import {
  PostTier,
  PostStatus,
  StateTransitionEvent,
  TransitionResult
} from "@swms/contracts";
import { AppModule } from "../src/app.module.js";
import { DatabaseService } from "../src/core/database/database.service.js";
import { CLOCK_TOKEN } from "../src/core/clock/clock.interface.js";
import { VirtualClock } from "../src/core/clock/virtual-clock.js";
import { DispatchService } from "../src/modules/dispatch/dispatch.service.js";
import { OutboxService } from "../src/modules/dispatch/outbox.service.js";
import { OptimisticLockError } from "../src/modules/dispatch/state-machine/optimistic-lock.error.js";
import { Tier1InvariantError } from "../src/modules/dispatch/state-machine/tier1-invariant.error.js";
import { runMigration } from "../../../db/migrate.js";
import { runSeed } from "../../../db/seed/seed.js";

describe("Milestone M4 Acceptance Criteria — State Machine, Events & Outbox", () => {
  let app: INestApplication;
  let db: DatabaseService;
  let pool: Pool;
  let dispatchService: DispatchService;
  let outboxService: OutboxService;
  let clock: VirtualClock;
  let adminToken: string;
  let guardToken: string;
  let guardId: number;

  const testDbUrl =
    process.env.DATABASE_URL || "postgres://grey@localhost:5432/swms_test";
  const baseTime = new Date("2026-10-23T06:00:00.000Z");

  beforeAll(async () => {
    // 1. Ensure migrations and seed are clean
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
    dispatchService = moduleRef.get<DispatchService>(DispatchService);
    outboxService = moduleRef.get<OutboxService>(OutboxService);

    // Login Admin
    const adminRes = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: "admin", password: "password123" });
    adminToken = adminRes.body.accessToken;

    // Login Guard
    const guardRes = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: "guard01", password: "password123" });
    guardToken = guardRes.body.accessToken;
    guardId = guardRes.body.user.guard_id;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    // Reset posts to clean NOT_ACTIVE state and site to NORMAL
    await db.query(`UPDATE site_state SET mode = 'NORMAL', version = 0, since = $1;`, [baseTime]);
    await db.query(`UPDATE post_state SET status = 'NOT_ACTIVE', guard_id = NULL, deadline_at = NULL, version = 0, since = $1;`, [baseTime]);
    await db.query(`DELETE FROM state_events;`);
    await db.query(`DELETE FROM outbox;`);
  });

  describe("1. Table-Driven Transitions Against Postgres DB", () => {
    it("progresses a Tier 1 post through full lifecycle in DB", async () => {
      // 1. SHIFT_START: NOT_ACTIVE -> VACANT_ALERT
      const res1 = await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "SHIFT_START",
        payload: { postActive: true }
      });
      expect(res1.toStatus).toBe("VACANT_ALERT");
      expect(res1.version).toBe(1);

      // Verify post_state in DB
      const postDb1 = await db.query(`SELECT status, version FROM post_state WHERE post_id = 'G1';`);
      expect(postDb1.rows[0].status).toBe("VACANT_ALERT");
      expect(Number(postDb1.rows[0].version)).toBe(1);

      // 2. CHECKIN_ACCEPTED: VACANT_ALERT -> OCCUPIED
      const res2 = await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "CHECKIN_ACCEPTED",
        actorId: guardId,
        payload: { guardId }
      });
      expect(res2.toStatus).toBe("OCCUPIED");
      expect(res2.guardId).toBe(guardId);
      expect(res2.version).toBe(2);

      // 3. MEAL_WINDOW_OPEN: OCCUPIED -> HANDOVER_PENDING
      const res3 = await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "MEAL_WINDOW_OPEN",
        payload: { breakPlanId: 101, floatId: 2 }
      });
      expect(res3.toStatus).toBe("HANDOVER_PENDING");
      expect(res3.version).toBe(3);

      // 4. FLOAT_CHECKIN: HANDOVER_PENDING -> RELIEVED_FOR_MEAL
      const res4 = await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "FLOAT_CHECKIN",
        payload: { floatId: 2, plannedFloatId: 2 }
      });
      expect(res4.toStatus).toBe("RELIEVED_FOR_MEAL");
      expect(res4.version).toBe(4);

      // 5. ORIGINAL_BACK: RELIEVED_FOR_MEAL -> OCCUPIED
      const res5 = await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "ORIGINAL_BACK",
        payload: { originalGuardId: guardId, guardId }
      });
      expect(res5.toStatus).toBe("OCCUPIED");
      expect(res5.guardId).toBe(guardId);
      expect(res5.version).toBe(5);

      // 6. PRESENCE_UNCERTAIN: OCCUPIED -> UNCERTAIN
      const res6 = await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "PRESENCE_UNCERTAIN",
        payload: { escalateAfterSec: 120 }
      });
      expect(res6.toStatus).toBe("UNCERTAIN");
      expect(res6.version).toBe(6);

      // 7. QR_CONFIRMED: UNCERTAIN -> OCCUPIED
      const res7 = await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "QR_CONFIRMED",
        payload: { nonceValid: true }
      });
      expect(res7.toStatus).toBe("OCCUPIED");
      expect(res7.version).toBe(7);

      // 8. ABSENCE_REPORTED: OCCUPIED -> VACANT_ALERT
      const res8 = await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "ABSENCE_REPORTED",
        payload: { reason: "Sick" }
      });
      expect(res8.toStatus).toBe("VACANT_ALERT");
      expect(res8.guardId).toBeNull();
      expect(res8.version).toBe(8);

      // 9. SHIFT_END: VACANT_ALERT -> NOT_ACTIVE
      const res9 = await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "SHIFT_END",
        payload: {}
      });
      expect(res9.toStatus).toBe("NOT_ACTIVE");
      expect(res9.version).toBe(9);
    });
  });

  describe("2. Idempotent Replay", () => {
    it("returns identical result without re-executing or incrementing version on same idem_key", async () => {
      const idemKey = "test-idem-key-12345";
      const event: StateTransitionEvent = {
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "SHIFT_START",
        idemKey,
        payload: { postActive: true }
      };

      // First run
      const firstResult = await dispatchService.applyWithRetry(event);
      expect(firstResult.success).toBe(true);
      expect(firstResult.isReplay).toBe(false);
      expect(firstResult.version).toBe(1);

      const eventsCount1 = await db.query(`SELECT count(*) FROM state_events WHERE idem_key = $1;`, [idemKey]);
      expect(Number(eventsCount1.rows[0].count)).toBe(1);

      // Second run with same idemKey
      const secondResult = await dispatchService.applyWithRetry(event);
      expect(secondResult.success).toBe(true);
      expect(secondResult.isReplay).toBe(true);
      expect(secondResult.version).toBe(1); // unchanged
      expect(secondResult.eventId).toBe(firstResult.eventId);

      // Confirm no duplicate state_events was created
      const eventsCount2 = await db.query(`SELECT count(*) FROM state_events WHERE idem_key = $1;`, [idemKey]);
      expect(Number(eventsCount2.rows[0].count)).toBe(1);
    });
  });

  describe("3. Optimistic-Lock Conflict & Retry", () => {
    it("throws OptimisticLockError on version mismatch in raw apply", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN;");
        // Simulate a concurrent modification: advance version of G1 directly
        await db.query(`UPDATE post_state SET version = 99 WHERE post_id = 'G1';`);

        // raw apply will expect version 0 but DB has 99
        await expect(
          dispatchService.apply(client, {
            siteId: "AEON_THANH_KHE_F1",
            postId: "G1",
            kind: "SHIFT_START",
            payload: { expectedVersion: 0 }
          })
        ).rejects.toThrow(OptimisticLockError);
      } finally {
        await client.query("ROLLBACK;");
        client.release();
      }
    });

    it("automatically retries and succeeds when using applyWithRetry under concurrent update", async () => {
      // Set G1 to clean state
      await db.query(`UPDATE post_state SET status = 'NOT_ACTIVE', version = 5 WHERE post_id = 'G1';`);

      const res = await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "SHIFT_START",
        payload: {}
      });

      expect(res.success).toBe(true);
      expect(res.version).toBe(6);
    });
  });

  describe("4. Tier 1 Zero-Vacancy Invariant Checks in DB", () => {
    it("strictly rejects ACCEPT_PLANNED_GAP on Tier 1 posts (G1)", async () => {
      // Put G1 into VACANT_ALERT
      await db.query(`UPDATE post_state SET status = 'VACANT_ALERT', version = 1 WHERE post_id = 'G1';`);

      await expect(
        dispatchService.applyWithRetry({
          siteId: "AEON_THANH_KHE_F1",
          postId: "G1",
          kind: "ACCEPT_PLANNED_GAP",
          payload: {}
        })
      ).rejects.toThrow(Tier1InvariantError);
    });

    it("strictly rejects MERGE_WITH_PAIR on Tier 1 posts (G4)", async () => {
      // Put G4 into VACANT_ALERT
      await db.query(`UPDATE post_state SET status = 'VACANT_ALERT', version = 1 WHERE post_id = 'G4';`);

      await expect(
        dispatchService.applyWithRetry({
          siteId: "AEON_THANH_KHE_F1",
          postId: "G4",
          kind: "MERGE_WITH_PAIR",
          payload: { pairPostStatus: "OCCUPIED" }
        })
      ).rejects.toThrow(Tier1InvariantError);
    });

    it("allows ACCEPT_PLANNED_GAP on Tier 2 post (G2)", async () => {
      await db.query(`UPDATE post_state SET status = 'VACANT_ALERT', version = 1 WHERE post_id = 'G2';`);

      const res = await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G2",
        kind: "ACCEPT_PLANNED_GAP",
        payload: {}
      });

      expect(res.toStatus).toBe("VACANT_PLANNED");
    });

    it("allows MERGE_WITH_PAIR on Tier 2 post (P2) when pair post (P3) is OCCUPIED", async () => {
      await db.query(`UPDATE post_state SET status = 'VACANT_ALERT', version = 1 WHERE post_id = 'P2';`);
      await db.query(`UPDATE post_state SET status = 'OCCUPIED', version = 1 WHERE post_id = 'P3';`);

      const res = await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "P2",
        kind: "MERGE_WITH_PAIR",
        payload: { pairGuardId: 10 }
      });

      expect(res.toStatus).toBe("COVERED_BY_PAIR");
    });
  });

  describe("5. Outbox Monotonic Sequence & Delivery", () => {
    it("generates strictly monotonic seq numbers per site in outbox table", async () => {
      await db.query(`DELETE FROM outbox;`);

      // Trigger 3 transitions
      await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "SHIFT_START",
        payload: {}
      });

      await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "CHECKIN_ACCEPTED",
        payload: { guardId }
      });

      await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "PRESENCE_UNCERTAIN",
        payload: {}
      });

      const outboxRes = await db.query(
        `SELECT id, topic, payload, sent_at FROM outbox ORDER BY id ASC;`
      );
      expect(outboxRes.rows.length).toBe(3);

      const seqs = outboxRes.rows.map((r) => {
        const p = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
        return p.seq;
      });

      // Verify sequence is strictly increasing
      expect(seqs[1]).toBeGreaterThan(seqs[0]);
      expect(seqs[2]).toBeGreaterThan(seqs[1]);

      // Verify sent_at was marked after commit
      expect(outboxRes.rows[0].sent_at).not.toBeNull();
    });
  });

  describe("6. REST Endpoints Contract Tests", () => {
    it("GET /state/snapshot returns current site state, 14 posts, and lastSeq", async () => {
      const res = await request(app.getHttpServer())
        .get("/state/snapshot")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.site).toBeDefined();
      expect(res.body.site.site_id).toBe("AEON_THANH_KHE_F1");
      expect(res.body.site.mode).toBe("NORMAL");
      expect(Array.isArray(res.body.posts)).toBe(true);
      expect(res.body.posts.length).toBe(14);
      expect(typeof res.body.lastSeq).toBe("number");
    });

    it("POST /state/break/start enforces Handshake Lock", async () => {
      // 1. Post G1 is currently NOT_ACTIVE -> reject
      const failRes = await request(app.getHttpServer())
        .post("/state/break/start")
        .set("Authorization", `Bearer ${guardToken}`)
        .send({ guardId, postId: "G1" });

      expect(failRes.status).toBe(400);
      expect(failRes.body.detail).toContain("Handshake requires RELIEVED_FOR_MEAL");

      // 2. Update G1 to RELIEVED_FOR_MEAL with this guard
      await db.query(
        `UPDATE post_state SET status = 'RELIEVED_FOR_MEAL', guard_id = $1 WHERE post_id = 'G1';`,
        [guardId]
      );

      const okRes = await request(app.getHttpServer())
        .post("/state/break/start")
        .set("Authorization", `Bearer ${guardToken}`)
        .send({ guardId, postId: "G1" });

      expect(okRes.status).toBe(201);
      expect(okRes.body.allowed).toBe(true);
    });

    it("POST /state/events executes state transition via API", async () => {
      const res = await request(app.getHttpServer())
        .post("/state/events")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          siteId: "AEON_THANH_KHE_F1",
          postId: "G3",
          kind: "SHIFT_START",
          payload: { postActive: true }
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.toStatus).toBe("VACANT_ALERT");
    });
  });

  describe("7. Emergency Mode Workflow", () => {
    it("FIRE_ALARM transitions site to EMERGENCY, suspends post events, EMERGENCY_CLEARED restores", async () => {
      // 1. Fire alarm
      const fireRes = await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        kind: "FIRE_ALARM",
        payload: { area: "Food Court" }
      });

      expect(fireRes.siteMode).toBe("EMERGENCY");

      const siteDb = await db.query(`SELECT mode FROM site_state WHERE site_id = 'AEON_THANH_KHE_F1';`);
      expect(siteDb.rows[0].mode).toBe("EMERGENCY");

      // 2. Normal post transition must be rejected during EMERGENCY
      await expect(
        dispatchService.applyWithRetry({
          siteId: "AEON_THANH_KHE_F1",
          postId: "G1",
          kind: "SHIFT_START",
          payload: {}
        })
      ).rejects.toThrow();

      // 3. Clear emergency
      const clearRes = await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        kind: "EMERGENCY_CLEARED",
        payload: {}
      });

      expect(clearRes.siteMode).toBe("NORMAL");

      const siteDbAfter = await db.query(`SELECT mode FROM site_state WHERE site_id = 'AEON_THANH_KHE_F1';`);
      expect(siteDbAfter.rows[0].mode).toBe("NORMAL");
    });
  });
});
