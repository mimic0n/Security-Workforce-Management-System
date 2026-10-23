import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { io, Socket } from "socket.io-client";
import { AppModule } from "../src/app.module.js";
import { AuthService } from "../src/core/auth/auth.service.js";
import { DatabaseService } from "../src/core/database/database.service.js";
import { DispatchService } from "../src/modules/dispatch/dispatch.service.js";
import { OutboxService } from "../src/modules/dispatch/outbox.service.js";
import { CLOCK_TOKEN } from "../src/core/clock/clock.interface.js";
import { Clock, WebSocketRooms } from "@swms/contracts";
import { runMigration } from "../../../db/migrate.js";
import { runSeed } from "../../../db/seed/seed.js";
import supertest from "supertest";

import bcrypt from "bcryptjs";

const testDbUrl = process.env.TEST_DATABASE_URL || "postgres://grey@localhost:5432/swms_test";

describe("Milestone M8 Acceptance Criteria — Realtime Gateway & UI Contracts (§11, §15)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let authService: AuthService;
  let db: DatabaseService;
  let dispatchService: DispatchService;
  let outboxService: OutboxService;
  let clock: Clock;
  let serverPort: number;
  let serverUrl: string;

  let dispatcherToken: string;
  let guard10Token: string;
  let guard11Token: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    await runMigration("up", testDbUrl);
    await runSeed(testDbUrl);

    moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableCors();
    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address();
    serverPort = typeof address === "string" ? 3000 : address.port;
    serverUrl = `http://localhost:${serverPort}`;

    authService = moduleRef.get<AuthService>(AuthService);
    db = moduleRef.get<DatabaseService>(DatabaseService);
    dispatchService = moduleRef.get<DispatchService>(DispatchService);
    outboxService = moduleRef.get<OutboxService>(OutboxService);
    clock = moduleRef.get<Clock>(CLOCK_TOKEN);

    // Ensure test posts are OCCUPIED for transitions and outbox is clean
    await db.query("TRUNCATE TABLE outbox;");
    await db.query(
      `UPDATE post_state 
       SET status = 'OCCUPIED', guard_id = 1, since = clock_timestamp(), deadline_at = NULL, version = version + 1
       WHERE post_id IN ('G1', 'G4', 'G5', 'P1');`
    );
    const dispatcherLogin = await authService.login({
      username: "dispatcher",
      password: "password123"
    });
    dispatcherToken = dispatcherLogin.accessToken;

    // Ensure we have users for guard 10 and guard 11
    // Seed creates guard accounts or we can create them if needed
    const hash = await bcrypt.hash("password123", 10);
    const guard10Res = await db.query(`SELECT id FROM users WHERE guard_id = 10;`);
    let guard10User = guard10Res.rows[0];
    if (!guard10User) {
      await db.query(
        `INSERT INTO users (username, password_hash, role, guard_id)
         VALUES ('guard10', $1, 'GUARD', 10);`,
        [hash]
      );
    }
    const guard10Login = await authService.login({
      username: "guard10",
      password: "password123"
    });
    guard10Token = guard10Login.accessToken;

    const guard11Res = await db.query(`SELECT id FROM users WHERE guard_id = 11;`);
    if (guard11Res.rows.length === 0) {
      await db.query(
        `INSERT INTO users (username, password_hash, role, guard_id)
         VALUES ('guard11', $1, 'GUARD', 11);`,
        [hash]
      );
    }
    const guard11Login = await authService.login({
      username: "guard11",
      password: "password123"
    });
    guard11Token = guard11Login.accessToken;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe("1. Realtime Delivery Latency (< 1s)", () => {
    it("client receives post.state_changed in < 1 second upon state transition", async () => {
      const client = io(serverUrl, {
        auth: { token: dispatcherToken },
        transports: ["websocket"]
      });

      await new Promise<void>((resolve, reject) => {
        client.on("connect", () => resolve());
        client.on("connect_error", (err) => reject(err));
      });

      const messagePromise = new Promise<{ elapsed: number; data: any }>((resolve) => {
        const t0 = Date.now();
        client.on("post.state_changed", (data) => {
          const elapsed = Date.now() - t0;
          resolve({ elapsed, data });
        });
      });

      // Trigger transition
      await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "PRESENCE_UNCERTAIN",
        payload: { reason: "test latency" }
      });

      const { elapsed, data } = await messagePromise;
      client.disconnect();

      expect(elapsed).toBeLessThan(1000); // Latency < 1s per acceptance criteria
      expect(data.v).toBe(1);
      expect(data.type).toBe("post.state_changed");
      expect(data.seq).toBeGreaterThan(0);
      expect(data.payload.postId).toBe("G1");
      expect(data.payload.toStatus).toBe("UNCERTAIN");
    });
  });

  describe("2. Sequence Gap and Reconnection Snapshot", () => {
    it("reconnect with seq gap triggers GET /state/snapshot to synchronize state", async () => {
      await db.query(
        `UPDATE post_state SET status = 'OCCUPIED', guard_id = 1 WHERE post_id IN ('G1', 'G4');`
      );

      const client = io(serverUrl, {
        auth: { token: dispatcherToken },
        transports: ["websocket"]
      });

      await new Promise<void>((resolve) => client.on("connect", () => resolve()));

      let currentSeq = 0;
      const receivedMessages: any[] = [];
      let snapshotTriggered = false;

      // Simulated client-side gap detection logic per §11
      const onMessage = async (envelope: any) => {
        receivedMessages.push(envelope);
        if (currentSeq > 0 && envelope.seq > currentSeq + 1) {
          // Detected sequence gap!
          snapshotTriggered = true;
          const snapshotRes = await supertest(app.getHttpServer())
            .get("/state/snapshot")
            .set("Authorization", `Bearer ${dispatcherToken}`)
            .expect(200);

          currentSeq = snapshotRes.body.lastSeq;
        } else {
          currentSeq = envelope.seq;
        }
      };

      client.on("post.state_changed", onMessage);

      // Transition 1
      await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G1",
        kind: "PRESENCE_UNCERTAIN",
        payload: { reason: "gap test 1" }
      });

      // Wait a moment for first transition to be received
      await new Promise((r) => setTimeout(r, 100));
      expect(currentSeq).toBeGreaterThan(0);
      const firstSeq = currentSeq;

      // Simulate a gap by artificially jumping the sequence via multiple outbox events or DB sequence
      await db.query(`SELECT nextval('site_event_seq'), nextval('site_event_seq');`);

      // Transition 2
      await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G4",
        kind: "PRESENCE_UNCERTAIN",
        payload: { reason: "gap test" }
      });

      // Wait for client to process and trigger snapshot
      await new Promise((r) => setTimeout(r, 200));
      client.disconnect();

      expect(snapshotTriggered).toBe(true);
      expect(currentSeq).toBeGreaterThan(firstSeq + 1);
    });
  });

  describe("3. Role-Based Room Isolation", () => {
    it("rejects unauthenticated socket connections", async () => {
      const unauthClient = io(serverUrl, {
        auth: { token: "invalid-token-xyz" },
        transports: ["websocket"]
      });

      const connectError = await new Promise<any>((resolve) => {
        unauthClient.on("connect_error", (err) => resolve(err));
        unauthClient.on("connect", () => resolve(null));
      });

      unauthClient.disconnect();
      expect(connectError).not.toBeNull();
    });

    it("enforces room isolation: GUARD cannot receive dashboard messages or other guard messages", async () => {
      const guardClient = io(serverUrl, {
        auth: { token: guard10Token },
        transports: ["websocket"]
      });

      const otherGuardClient = io(serverUrl, {
        auth: { token: guard11Token },
        transports: ["websocket"]
      });

      const dispatcherClient = io(serverUrl, {
        auth: { token: dispatcherToken },
        transports: ["websocket"]
      });

      await Promise.all([
        new Promise<void>((resolve) => guardClient.on("connect", () => resolve())),
        new Promise<void>((resolve) => otherGuardClient.on("connect", () => resolve())),
        new Promise<void>((resolve) => dispatcherClient.on("connect", () => resolve()))
      ]);

      const guardDashboardMessages: any[] = [];
      const dispatcherDashboardMessages: any[] = [];
      const guard10Orders: any[] = [];
      const guard11Orders: any[] = [];

      guardClient.on("post.state_changed", (msg) => guardDashboardMessages.push(msg));
      dispatcherClient.on("post.state_changed", (msg) => dispatcherDashboardMessages.push(msg));

      guardClient.on("dispatch.order", (msg) => guard10Orders.push(msg));
      otherGuardClient.on("dispatch.order", (msg) => guard11Orders.push(msg));

      // 1. Emit a dashboard event
      await db.query(
        `UPDATE post_state SET status = 'OCCUPIED', guard_id = 1 WHERE post_id = 'G5';`
      );
      await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "G5",
        kind: "PRESENCE_UNCERTAIN",
        payload: { reason: "room isolation test" }
      });

      await new Promise((r) => setTimeout(r, 150));

      // Dispatcher receives dashboard event, guard does NOT
      expect(dispatcherDashboardMessages.length).toBeGreaterThanOrEqual(1);
      expect(guardDashboardMessages.length).toBe(0);

      // 2. Emit a direct order to guard 10
      await db.transaction(async (tx) => {
        await outboxService.enqueue(tx, "dispatch.order", {
          guardId: 10,
          orderId: 999,
          toPost: "G4"
        });
      });
      await outboxService.publishPending();

      await new Promise((r) => setTimeout(r, 150));

      // Guard 10 receives order, Guard 11 does NOT
      expect(guard10Orders.length).toBe(1);
      expect(guard11Orders.length).toBe(0);

      // 3. Emit emergency event: BOTH must receive emergency
      const guardEmergency: any[] = [];
      const dispatcherEmergency: any[] = [];

      guardClient.on("emergency.started", (msg) => guardEmergency.push(msg));
      dispatcherClient.on("emergency.started", (msg) => dispatcherEmergency.push(msg));

      await db.transaction(async (tx) => {
        await outboxService.enqueue(tx, "emergency.started", {
          siteId: "AEON_THANH_KHE_F1",
          zone: "ZONE_A"
        });
      });
      await outboxService.publishPending();

      await new Promise((r) => setTimeout(r, 150));

      expect(guardEmergency.length).toBe(1);
      expect(dispatcherEmergency.length).toBe(1);

      guardClient.disconnect();
      otherGuardClient.disconnect();
      dispatcherClient.disconnect();
    });
  });

  describe("4. Mobile 'Break' Button Locked Until Relief Checks In", () => {
    it("locks break button while on duty; unlocks when relief checks in", async () => {
      // 1. Reset post P1 to OCCUPIED by guard 10
      await db.query(
        `UPDATE post_state 
         SET status = 'OCCUPIED', guard_id = 10, since = clock_timestamp(), deadline_at = NULL, version = version + 1
         WHERE post_id = 'P1';`
      );

      // Guard 10 attempts to start break without relief -> REJECTED by handshake lock
      const breakAttemptRes = await supertest(app.getHttpServer())
        .post("/state/break/start")
        .set("Authorization", `Bearer ${guard10Token}`)
        .send({
          guardId: 10,
          postId: "P1"
        });

      expect(breakAttemptRes.status).toBe(400);
      expect(breakAttemptRes.body.detail.toLowerCase()).toContain("handshake");

      // 2. Relief float arrives and checks in (FLOAT_CHECKIN)
      // Transition post P1 from OCCUPIED to HANDOVER_PENDING then RELIEVED_FOR_MEAL
      await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "P1",
        kind: "MEAL_WINDOW_OPEN",
        payload: { floatId: 2 }
      });

      await dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        postId: "P1",
        kind: "FLOAT_CHECKIN",
        payload: { floatId: 2, guardId: 10 }
      });

      // 3. Now relief has checked in -> Guard 10 calls /state/break/start -> SUCCEEDS
      const breakAllowedRes = await supertest(app.getHttpServer())
        .post("/state/break/start")
        .set("Authorization", `Bearer ${guard10Token}`)
        .send({
          guardId: 10,
          postId: "P1"
        });

      expect(breakAllowedRes.status).toBe(201);
      expect(breakAllowedRes.body.allowed).toBe(true);
      expect(breakAllowedRes.body.message).toContain("authorized by Two-Way Handshake Lock");
    });
  });

  describe("5. Client App-Level Acknowledgment over Socket.IO", () => {
    it("acknowledges a dispatch order over WS and updates order to ACKED", async () => {
      // Ensure target post G4 is in VACANT_ALERT state ready for replacement checkin
      await db.query(
        `UPDATE post_state SET status = 'VACANT_ALERT', guard_id = NULL WHERE post_id = 'G4';`
      );

      // Insert a test dispatch order for guard 10
      const orderInsertRes = await db.query(
        `INSERT INTO dispatch_orders (shift_key, kind, to_guard_id, to_post, status, explain, sent_at)
         VALUES ('MORNING', 'ASSIGNMENT', 10, 'G4', 'SENT', '{"test":true}', clock_timestamp())
         RETURNING id;`
      );
      const orderId = Number(orderInsertRes.rows[0].id);

      const guardClient = io(serverUrl, {
        auth: { token: guard10Token },
        transports: ["websocket"]
      });

      await new Promise<void>((resolve) => guardClient.on("connect", () => resolve()));

      // Send dispatch.ack event over socket
      const ackResponse = await new Promise<any>((resolve) => {
        guardClient.emit("dispatch.ack", { orderId, guardId: 10 }, (response: any) => {
          resolve(response);
        });
      });

      guardClient.disconnect();

      expect(ackResponse?.success).toBe(true);

      const checkOrderRes = await db.query(
        `SELECT status, ack_at FROM dispatch_orders WHERE id = $1;`,
        [orderId]
      );
      expect(checkOrderRes.rows[0].status).toBe("ACKED");
      expect(checkOrderRes.rows[0].ack_at).not.toBeNull();
    });
  });
});
