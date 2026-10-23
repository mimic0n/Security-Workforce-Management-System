import { Injectable, Inject, NotFoundException, BadRequestException, Optional, forwardRef } from "@nestjs/common";
import { PoolClient } from "pg";
import {
  Clock,
  PostStateRecord,
  SiteStateRecord,
  StateTransitionEvent,
  TransitionResult,
  StateSnapshotResponse,
  DispatchOverrideDto,
  DispatchOrder
} from "@swms/contracts";
import { CLOCK_TOKEN } from "../../core/clock/clock.interface.js";
import { DatabaseService } from "../../core/database/database.service.js";
import { ConfigService } from "../policies/config.service.js";
import { OutboxService } from "./outbox.service.js";
import { StateMachineService } from "./state-machine/state-machine.service.js";
import { OptimisticLockError } from "./state-machine/optimistic-lock.error.js";
import { InvalidTransitionError } from "./state-machine/invalid-transition.error.js";
import { PostContext } from "./state-machine/transitions.js";
import { DispatchQueueService } from "./engine/queue.service.js";
import { LegalGuardService } from "./legal-guard/legal-guard.service.js";

@Injectable()
export class DispatchService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(StateMachineService) private readonly stateMachineService: StateMachineService,
    @Inject(OutboxService) private readonly outboxService: OutboxService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Optional() @Inject(ConfigService) private readonly configService?: ConfigService,
    @Optional() @Inject(forwardRef(() => DispatchQueueService)) private readonly queueService?: DispatchQueueService,
    @Optional() @Inject(LegalGuardService) private readonly legalGuardService?: LegalGuardService
  ) {}

  /**
   * Helper to resolve the active site ID dynamically from site_state
   */
  async getPrimarySiteId(client?: PoolClient): Promise<string> {
    if (client) {
      const res = await client.query(`SELECT site_id FROM site_state LIMIT 1;`);
      return res.rows.length > 0 ? res.rows[0].site_id : "AEON_THANH_KHE_F1";
    }
    const res = await this.db.query(`SELECT site_id FROM site_state LIMIT 1;`);
    return res.rows.length > 0 ? res.rows[0].site_id : "AEON_THANH_KHE_F1";
  }

  /**
   * Apply a state transition event within an existing database transaction client (tx).
   * Implements §6.2: FOR UPDATE locking, state machine validation, optimistic locking check,
   * append-only state_events with idem_key, outbox enqueueing.
   */
  async apply(tx: PoolClient, event: StateTransitionEvent): Promise<TransitionResult> {
    const siteId = event.siteId || (await this.getPrimarySiteId(tx));
    const now = event.simTs ? new Date(event.simTs) : this.clock.now();

    const resolveIdempotentResult = async (): Promise<TransitionResult | null> => {
      if (!event.idemKey) return null;
      const existingRes = await tx.query(
        `SELECT id, site_id, post_id, from_status, to_status, payload, idem_key 
         FROM state_events 
         WHERE idem_key = $1;`,
        [event.idemKey]
      );

      if (existingRes.rows.length === 0) return null;
      const row = existingRes.rows[0];
      let currentVer = 0;
      let guardId: number | null = null;
      let deadlineAt: string | null = null;

      if (row.post_id) {
        const postState = await tx.query(
          `SELECT version, guard_id, deadline_at FROM post_state WHERE post_id = $1;`,
          [row.post_id]
        );
        if (postState.rows.length > 0) {
          currentVer = Number(postState.rows[0].version);
          guardId = postState.rows[0].guard_id ? Number(postState.rows[0].guard_id) : null;
          deadlineAt = postState.rows[0].deadline_at
            ? new Date(postState.rows[0].deadline_at).toISOString()
            : null;
        }
      } else {
        const siteState = await tx.query(
          `SELECT version FROM site_state WHERE site_id = $1;`,
          [siteId]
        );
        if (siteState.rows.length > 0) {
          currentVer = Number(siteState.rows[0].version);
        }
      }

      return {
        success: true,
        siteId: row.site_id,
        postId: row.post_id,
        fromStatus: row.from_status,
        toStatus: row.to_status,
        guardId,
        deadlineAt,
        version: currentVer,
        eventId: Number(row.id),
        idemKey: row.idem_key,
        isReplay: true
      };
    };

    // 1. Initial Idempotency Check: if idemKey already processed, return stored result
    const initialReplay = await resolveIdempotentResult();
    if (initialReplay) return initialReplay;

    // 2. Handle Site-wide Events (FIRE_ALARM / EMERGENCY_CLEARED)
    if (event.kind === "FIRE_ALARM" || event.kind === "EMERGENCY_CLEARED") {
      const siteRes = await tx.query(
        `SELECT site_id, mode, version, since 
         FROM site_state 
         WHERE site_id = $1 
         FOR UPDATE;`,
        [siteId]
      );

      if (siteRes.rows.length === 0) {
        throw new NotFoundException(`Site '${siteId}' not found in site_state`);
      }

      // Re-check idempotency under lock in case another transaction just committed with same idem_key
      const lockedReplay = await resolveIdempotentResult();
      if (lockedReplay) return lockedReplay;

      const currentSite: SiteStateRecord = siteRes.rows[0];
      const output = this.stateMachineService.evaluateSiteTransition(currentSite, event);

      const expectedSiteVersion = event.payload?.expectedVersion !== undefined
        ? Number(event.payload.expectedVersion)
        : Number(currentSite.version);

      // Optimistic update of site_state
      const updateSiteRes = await tx.query(
        `UPDATE site_state 
         SET mode = $1, version = version + 1, since = $2 
         WHERE site_id = $3 AND version = $4 
         RETURNING version;`,
        [output.siteMode, now, siteId, expectedSiteVersion]
      );

      if (updateSiteRes.rows.length === 0) {
        throw new OptimisticLockError(siteId, expectedSiteVersion);
      }

      const nextVersion = Number(updateSiteRes.rows[0].version);

      // Append state_events
      const eventRes = await tx.query(
        `INSERT INTO state_events (site_id, post_id, from_status, to_status, cause, actor_id, payload, sim_ts, real_ts, idem_key)
         VALUES ($1, NULL, NULL, NULL, $2, $3, $4, $5, clock_timestamp(), $6)
         RETURNING id;`,
        [
          siteId,
          event.kind,
          event.actorId ?? null,
          JSON.stringify(output.payload),
          now,
          event.idemKey ?? null
        ]
      );
      const eventId = Number(eventRes.rows[0].id);

      // Enqueue Outbox message with monotonic sequence
      await this.outboxService.enqueue(tx, output.topic, output.payload);

      return {
        success: true,
        siteId,
        postId: null,
        fromStatus: null,
        toStatus: null,
        siteMode: output.siteMode,
        guardId: null,
        deadlineAt: null,
        version: nextVersion,
        eventId,
        idemKey: event.idemKey ?? null,
        isReplay: false
      };
    }

    // 3. Handle Per-Post Transitions
    if (!event.postId) {
      throw new BadRequestException(`Event kind '${event.kind}' requires a postId`);
    }

    // Load post rule to get tier, max_vacant_sec, pair_with, active_shifts
    const ruleRes = await tx.query(
      `SELECT post_id, tier, max_vacant_sec, pair_with, active_shifts, needs_meal_cover 
       FROM post_rules 
       WHERE post_id = $1;`,
      [event.postId]
    );

    if (ruleRes.rows.length === 0) {
      throw new NotFoundException(`Post '${event.postId}' not found in post_rules`);
    }

    const postRule = ruleRes.rows[0];

    // Load current site mode
    const siteRes = await tx.query(`SELECT mode FROM site_state WHERE site_id = $1;`, [siteId]);
    const siteMode = siteRes.rows.length > 0 ? siteRes.rows[0].mode : "NORMAL";

    // Load post_state FOR UPDATE
    const postRes = await tx.query(
      `SELECT post_id, status, guard_id, since, deadline_at, version 
       FROM post_state 
       WHERE post_id = $1 
       FOR UPDATE;`,
      [event.postId]
    );

    if (postRes.rows.length === 0) {
      throw new NotFoundException(`Post state for '${event.postId}' not found in post_state`);
    }

    // Re-check idempotency under lock in case a concurrent transaction just committed with same idem_key
    const lockedReplay = await resolveIdempotentResult();
    if (lockedReplay) return lockedReplay;

    const currentPost = postRes.rows[0];

    // If MERGE_WITH_PAIR, look up pair post status if pair exists
    let pairPostStatus = undefined;
    if (event.kind === "MERGE_WITH_PAIR" && postRule.pair_with && postRule.pair_with.length > 0) {
      const pairId = postRule.pair_with[0];
      const pairRes = await tx.query(
        `SELECT status FROM post_state WHERE post_id = $1;`,
        [pairId]
      );
      if (pairRes.rows.length > 0) {
        pairPostStatus = pairRes.rows[0].status;
      }
    }

    const postContext: PostContext = {
      id: currentPost.post_id,
      tier: postRule.tier,
      status: currentPost.status,
      guardId: currentPost.guard_id ? Number(currentPost.guard_id) : null,
      deadlineAt: currentPost.deadline_at ? new Date(currentPost.deadline_at) : null,
      pairWith: postRule.pair_with,
      maxVacantSec: postRule.max_vacant_sec
    };

    // Load active policies via ConfigService
    let handoverBufferMin = 5;
    let tier1EscalateSec = 120;
    if (this.configService) {
      try {
        handoverBufferMin = await this.configService.get<number>("meal.handover_buffer_min", now);
        tier1EscalateSec = await this.configService.get<number>("attendance.tier1_escalate_after_sec", now);
      } catch {
        // Fallback to defaults if policies not yet seeded in lightweight tests
      }
    }

    let breakMinutes = 30;
    const hour = (now.getUTCHours() + 7) % 24;
    const currentShift = hour >= 6 && hour < 14 ? "MORNING" : hour >= 14 && hour < 22 ? "AFTERNOON" : "NIGHT";
    const shiftRes = await tx.query(
      `SELECT break_minutes FROM shift_templates WHERE code = $1;`,
      [event.payload?.shift || currentShift]
    );
    if (shiftRes.rows.length > 0 && shiftRes.rows[0].break_minutes != null) {
      breakMinutes = Number(shiftRes.rows[0].break_minutes);
    }

    // Evaluate transition using StateMachineService
    const output = this.stateMachineService.evaluatePostTransition(
      postContext,
      event,
      siteMode,
      {
        config: {
          handoverBufferMin,
          breakMinutes,
          tier1EscalateSec,
          maxVacantSec: postRule.max_vacant_sec
        },
        pairPostStatus,
        breakPlanExists: event.payload?.breakPlanExists,
        plannedFloatId: event.payload?.plannedFloatId,
        postActiveThisShift: event.payload?.postActiveThisShift,
        nonceValid: event.payload?.nonceValid,
        legalGuardOk: event.payload?.legalGuardOk,
        vacantSeconds: event.payload?.vacantSeconds
      }
    );

    const expectedVersion = event.payload?.expectedVersion !== undefined
      ? Number(event.payload.expectedVersion)
      : Number(currentPost.version);

    // Optimistic lock update: WHERE post_id = $1 AND version = $2
    const updateRes = await tx.query(
      `UPDATE post_state 
       SET status = $1, guard_id = $2, since = $3, deadline_at = $4, version = version + 1 
       WHERE post_id = $5 AND version = $6 
       RETURNING version;`,
      [
        output.toStatus,
        output.guardId,
        now,
        output.deadlineAt,
        event.postId,
        expectedVersion
      ]
    );

    if (updateRes.rows.length === 0) {
      throw new OptimisticLockError(event.postId, expectedVersion);
    }

    const nextVersion = Number(updateRes.rows[0].version);

    // Append to state_events
    const eventRes = await tx.query(
      `INSERT INTO state_events (
         site_id, post_id, from_status, to_status, cause, actor_id, 
         payload, sim_ts, real_ts, idem_key
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp(), $9)
       RETURNING id;`,
      [
        siteId,
        event.postId,
        output.fromStatus,
        output.toStatus,
        event.kind,
        event.actorId ?? null,
        JSON.stringify(output.payload),
        now,
        event.idemKey ?? null
      ]
    );
    const eventId = Number(eventRes.rows[0].id);

    // Enqueue Outbox message
    await this.outboxService.enqueue(tx, output.topic, output.payload);

    return {
      success: true,
      siteId,
      postId: event.postId,
      fromStatus: output.fromStatus,
      toStatus: output.toStatus,
      guardId: output.guardId,
      deadlineAt: output.deadlineAt ? output.deadlineAt.toISOString() : null,
      version: nextVersion,
      eventId,
      idemKey: event.idemKey ?? null,
      isReplay: false
    };
  }

  /**
   * High-level entry point: executes apply(tx, event) within a transaction,
   * automatically publishes outbox messages post-commit, and retries on optimistic-lock conflicts.
   */
  async applyWithRetry(
    event: StateTransitionEvent,
    maxRetries = 3
  ): Promise<TransitionResult> {
    let attempt = 0;
    const workingEvent: StateTransitionEvent = {
      ...event,
      payload: event.payload ? { ...event.payload } : {}
    };

    while (attempt < maxRetries) {
      attempt++;
      try {
        const result = await this.db.transaction(async (tx) => {
          return await this.apply(tx, workingEvent);
        });

        // Publish outbox strictly post-commit
        await this.outboxService.publishPending();

        return result;
      } catch (err: any) {
        const isOptimisticLock = err instanceof OptimisticLockError;
        const isPostgresRetryable =
          err?.code === "40001" || err?.code === "40P01" || err?.code === "23505";

        if ((isOptimisticLock || isPostgresRetryable) && attempt < maxRetries) {
          // If optimistic lock failed due to explicit stale expectedVersion, refresh for retry
          if (workingEvent.payload?.expectedVersion !== undefined) {
            delete workingEvent.payload.expectedVersion;
          }
          continue;
        }
        throw err;
      }
    }

    throw new Error(`Failed to apply transition event after ${maxRetries} attempts`);
  }

  /**
   * Handshake check: Guard "start break" action (§6.2, §12)
   */
  async canStartBreak(
    postId: string,
    guardId: number
  ): Promise<{ allowed: boolean; reason?: string }> {
    const postRes = await this.db.query(
      `SELECT post_id, status, guard_id, since, deadline_at, version 
       FROM post_state 
       WHERE post_id = $1;`,
      [postId]
    );

    if (postRes.rows.length === 0) {
      return { allowed: false, reason: `Post '${postId}' not found` };
    }

    const postState: PostStateRecord = postRes.rows[0];

    // Check if guard is the one assigned
    if (postState.guard_id && Number(postState.guard_id) !== Number(guardId)) {
      return {
        allowed: false,
        reason: `Guard ${guardId} is not assigned to post '${postId}' (assigned: ${postState.guard_id})`
      };
    }

    return this.stateMachineService.canStartBreak(postState);
  }

  /**
   * Retrieve current state snapshot for the site (§12)
   */
  async getStateSnapshot(siteId?: string): Promise<StateSnapshotResponse> {
    const effectiveSiteId = siteId || (await this.getPrimarySiteId());
    const siteRes = await this.db.query(
      `SELECT site_id, mode, version, since FROM site_state WHERE site_id = $1;`,
      [effectiveSiteId]
    );

    const site: SiteStateRecord = siteRes.rows.length > 0
      ? siteRes.rows[0]
      : { site_id: effectiveSiteId, mode: "NORMAL", version: 0, since: this.clock.now() };

    const postsRes = await this.db.query(
      `SELECT post_id, status, guard_id, since, deadline_at, version 
       FROM post_state 
       ORDER BY post_id ASC;`
    );

    const posts: PostStateRecord[] = postsRes.rows.map((row) => ({
      post_id: row.post_id,
      status: row.status,
      guard_id: row.guard_id ? Number(row.guard_id) : null,
      since: row.since,
      deadline_at: row.deadline_at,
      version: Number(row.version)
    }));

    const lastSeq = await this.outboxService.getLastSeq();

    return {
      site,
      posts,
      lastSeq
    };
  }

  /**
   * Enqueue a dispatch task
   */
  async enqueueTask(task: {
    siteId?: string;
    shiftKey: string;
    kind: string;
    payload?: Record<string, any>;
    priority?: number;
    idemKey?: string | null;
  }) {
    if (!this.queueService) {
      throw new Error("DispatchQueueService is not configured");
    }
    return this.queueService.enqueue(task);
  }

  /**
   * Query dispatch orders
   */
  async getOrders(filter?: {
    shiftKey?: string;
    status?: string;
    guardId?: number;
    kind?: string;
    limit?: number;
    offset?: number;
  }): Promise<DispatchOrder[]> {
    let query = `
      SELECT id, shift_key, kind, to_guard_id, from_post, to_post, status, explain, sent_at, ack_at, idem_key
      FROM dispatch_orders
      WHERE 1=1
    `;
    const params: any[] = [];
    let pIdx = 1;

    if (filter?.shiftKey) {
      query += ` AND shift_key = $${pIdx++}`;
      params.push(filter.shiftKey);
    }
    if (filter?.status) {
      query += ` AND status = $${pIdx++}`;
      params.push(filter.status);
    }
    if (filter?.guardId) {
      query += ` AND to_guard_id = $${pIdx++}`;
      params.push(filter.guardId);
    }
    if (filter?.kind) {
      query += ` AND kind = $${pIdx++}`;
      params.push(filter.kind);
    }

    query += ` ORDER BY id DESC`;

    if (filter?.limit) {
      query += ` LIMIT $${pIdx++}`;
      params.push(filter.limit);
    }
    if (filter?.offset) {
      query += ` OFFSET $${pIdx++}`;
      params.push(filter.offset);
    }

    const res = await this.db.query(query, params);
    return res.rows.map((r: any) => ({
      id: Number(r.id),
      shiftKey: r.shift_key,
      kind: r.kind,
      toGuardId: r.to_guard_id ? Number(r.to_guard_id) : null,
      fromPost: r.from_post,
      toPost: r.to_post,
      status: r.status,
      explain: typeof r.explain === "string" ? JSON.parse(r.explain) : r.explain,
      sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
      ackAt: r.ack_at ? new Date(r.ack_at).toISOString() : null,
      idemKey: r.idem_key
    }));
  }

  /**
   * Get single dispatch order by ID
   */
  async getOrderById(id: number): Promise<DispatchOrder> {
    const res = await this.db.query(
      `SELECT id, shift_key, kind, to_guard_id, from_post, to_post, status, explain, sent_at, ack_at, idem_key
       FROM dispatch_orders
       WHERE id = $1;`,
      [id]
    );

    if (res.rows.length === 0) {
      throw new NotFoundException(`Dispatch order #${id} not found`);
    }

    const r = res.rows[0];
    return {
      id: Number(r.id),
      shiftKey: r.shift_key,
      kind: r.kind,
      toGuardId: r.to_guard_id ? Number(r.to_guard_id) : null,
      fromPost: r.from_post,
      toPost: r.to_post,
      status: r.status,
      explain: typeof r.explain === "string" ? JSON.parse(r.explain) : r.explain,
      sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
      ackAt: r.ack_at ? new Date(r.ack_at).toISOString() : null,
      idemKey: r.idem_key
    };
  }

  /**
   * Acknowledge a dispatch order (§11, §12)
   */
  async ackOrder(orderId: number, guardId?: number): Promise<DispatchOrder> {
    const now = this.clock.now();

    return await this.db.transaction(async (tx) => {
      const orderRes = await tx.query(
        `SELECT id, shift_key, kind, to_guard_id, from_post, to_post, status, explain, sent_at, ack_at, idem_key
         FROM dispatch_orders
         WHERE id = $1
         FOR UPDATE;`,
        [orderId]
      );

      if (orderRes.rows.length === 0) {
        throw new NotFoundException(`Dispatch order #${orderId} not found`);
      }

      const order = orderRes.rows[0];
      const effectiveGuardId = order.to_guard_id ? Number(order.to_guard_id) : guardId;

      if (guardId && order.to_guard_id && Number(order.to_guard_id) !== Number(guardId)) {
        throw new BadRequestException(`Order #${orderId} is assigned to guard ${order.to_guard_id}, not ${guardId}`);
      }

      if (order.status === "ACKED") {
        return this.getOrderById(orderId);
      }

      if (order.status === "DECLINED" || order.status === "EXPIRED" || order.status === "CANCELLED") {
        throw new BadRequestException(`Cannot acknowledge order in '${order.status}' status`);
      }

      // Update order status to ACKED
      await tx.query(
        `UPDATE dispatch_orders 
         SET status = 'ACKED', ack_at = $1 
         WHERE id = $2;`,
        [now, orderId]
      );

      // If order targets a post, update post state via single entry point apply()
      if (order.to_post && effectiveGuardId) {
        const siteId = await this.getPrimarySiteId(tx);
        const postStateRes = await tx.query(`SELECT status FROM post_state WHERE post_id = $1;`, [order.to_post]);
        if (postStateRes.rows.length > 0 && postStateRes.rows[0].status === "NOT_ACTIVE") {
          await this.apply(tx, {
            kind: "SHIFT_START",
            postId: order.to_post,
            payload: { postActiveThisShift: true },
            siteId,
            simTs: now
          });
        }

        await this.apply(tx, {
          kind: "CHECKIN_ACCEPTED",
          postId: order.to_post,
          actorId: effectiveGuardId,
          payload: { guardId: effectiveGuardId, orderId, kind: order.kind },
          siteId,
          simTs: now,
          idemKey: order.idem_key ? `${order.idem_key}_ack` : undefined
        });

        // Update or insert assignment
        const shiftParts = order.shift_key.split(":");
        const shiftCode = shiftParts[1] || "MORNING";

        const shiftTplRes = await tx.query(
          `SELECT start_time, end_time FROM shift_templates WHERE code = $1;`,
          [shiftCode]
        );
        let shiftDurationMinutes = 480;
        if (shiftTplRes.rows.length > 0) {
          const [sh, sm] = shiftTplRes.rows[0].start_time.split(":").map(Number);
          const [eh, em] = shiftTplRes.rows[0].end_time.split(":").map(Number);
          let diffMin = (eh * 60 + em) - (sh * 60 + sm);
          if (diffMin <= 0) diffMin += 24 * 60;
          shiftDurationMinutes = diffMin;
        }

        const existingAssign = await tx.query(
          `SELECT id FROM assignments 
           WHERE guard_id = $1 AND shift = $2 AND status = 'ACTIVE' AND period @> $3::timestamptz;`,
          [effectiveGuardId, shiftCode, now]
        );

        if (existingAssign.rows.length > 0) {
          await tx.query(
            `UPDATE assignments SET post_id = $1, source = 'DISPATCH' WHERE id = $2;`,
            [order.to_post, existingAssign.rows[0].id]
          );
        } else {
          await tx.query(
            `INSERT INTO assignments (guard_id, post_id, role, shift, period, source, status)
             VALUES ($1, $2, 'FIXED', $3, tstzrange($4, ($4::timestamptz + ($5 || ' minutes')::interval), '[)'), 'DISPATCH', 'ACTIVE');`,
            [effectiveGuardId, order.to_post, shiftCode, now, shiftDurationMinutes]
          );
        }
      }

      // Enqueue outbox notification
      await this.outboxService.enqueue(tx, "dispatch.acked", {
        orderId,
        guardId: effectiveGuardId,
        postId: order.to_post,
        shiftKey: order.shift_key
      });

      return {
        id: Number(order.id),
        shiftKey: order.shift_key,
        kind: order.kind,
        toGuardId: effectiveGuardId,
        fromPost: order.from_post,
        toPost: order.to_post,
        status: "ACKED",
        explain: typeof order.explain === "string" ? JSON.parse(order.explain) : order.explain,
        sentAt: order.sent_at ? new Date(order.sent_at).toISOString() : null,
        ackAt: now.toISOString(),
        idemKey: order.idem_key
      };
    });
  }

  /**
   * Decline a dispatch order (§11, §12)
   * Triggers cascade to proceed to next candidate
   */
  async declineOrder(orderId: number, reason?: string): Promise<DispatchOrder> {
    const now = this.clock.now();

    const order = await this.db.transaction(async (tx) => {
      const orderRes = await tx.query(
        `SELECT id, shift_key, kind, to_guard_id, from_post, to_post, status, explain, sent_at, ack_at, idem_key
         FROM dispatch_orders
         WHERE id = $1
         FOR UPDATE;`,
        [orderId]
      );

      if (orderRes.rows.length === 0) {
        throw new NotFoundException(`Dispatch order #${orderId} not found`);
      }

      const o = orderRes.rows[0];
      if (o.status !== "SENT" && o.status !== "PROPOSED") {
        throw new BadRequestException(`Cannot decline order in '${o.status}' status`);
      }

      const explain = typeof o.explain === "string" ? JSON.parse(o.explain) : o.explain;
      explain.declinedReason = reason || "Declined by guard";

      await tx.query(
        `UPDATE dispatch_orders 
         SET status = 'DECLINED', explain = $1 
         WHERE id = $2;`,
        [JSON.stringify(explain), orderId]
      );

      await this.outboxService.enqueue(tx, "dispatch.declined", {
        orderId,
        guardId: o.to_guard_id ? Number(o.to_guard_id) : null,
        postId: o.to_post,
        shiftKey: o.shift_key,
        reason
      });

      return o;
    });

    // If order had a target post, trigger queue to fill vacancy with next candidate!
    if (order.to_post && this.queueService) {
      await this.queueService.enqueue({
        shiftKey: order.shift_key,
        kind: "FILL_VACANCY",
        payload: { postId: order.to_post }
      });
    }

    return this.getOrderById(orderId);
  }

  /**
   * Expire an unacknowledged order past timeout (§11, §12)
   */
  async expireOrder(orderId: number): Promise<DispatchOrder> {
    const order = await this.db.transaction(async (tx) => {
      const orderRes = await tx.query(
        `SELECT id, shift_key, kind, to_guard_id, from_post, to_post, status, explain, sent_at, ack_at, idem_key
         FROM dispatch_orders
         WHERE id = $1
         FOR UPDATE;`,
        [orderId]
      );

      if (orderRes.rows.length === 0) {
        throw new NotFoundException(`Dispatch order #${orderId} not found`);
      }

      const o = orderRes.rows[0];
      if (o.status !== "SENT" && o.status !== "PROPOSED") {
        return o;
      }

      await tx.query(`UPDATE dispatch_orders SET status = 'EXPIRED' WHERE id = $1;`, [orderId]);

      await this.outboxService.enqueue(tx, "dispatch.expired", {
        orderId,
        guardId: o.to_guard_id ? Number(o.to_guard_id) : null,
        postId: o.to_post,
        shiftKey: o.shift_key
      });

      return o;
    });

    // Trigger next candidate cascade
    if (order.to_post && this.queueService) {
      await this.queueService.enqueue({
        shiftKey: order.shift_key,
        kind: "FILL_VACANCY",
        payload: { postId: order.to_post }
      });
    }

    return this.getOrderById(orderId);
  }

  /**
   * Check and expire orders that exceeded ack timeout
   */
  async checkExpiredOrders(shiftKey?: string): Promise<number> {
    let timeoutSec = 60;
    if (this.configService) {
      try {
        const val = await this.configService.get<number>("dispatch.ack_timeout_sec");
        if (typeof val === "number") timeoutSec = val;
      } catch {}
    }

    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - timeoutSec * 1000);

    let query = `
      SELECT id FROM dispatch_orders 
      WHERE status IN ('SENT', 'PROPOSED') AND sent_at IS NOT NULL AND sent_at <= $1
    `;
    const params: any[] = [cutoff];

    if (shiftKey) {
      query += ` AND shift_key = $2`;
      params.push(shiftKey);
    }

    const res = await this.db.query(query, params);
    for (const row of res.rows) {
      await this.expireOrder(Number(row.id));
    }

    return res.rows.length;
  }

  /**
   * Dispatcher manual override (§12: POST /dispatch/override)
   */
  async overrideDispatch(dto: DispatchOverrideDto, dispatcherId?: number): Promise<DispatchOrder> {
    const now = this.clock.now();

    // Check LegalGuard (warning only, override proceeds)
    let legalWarning: string | null = null;
    if (this.legalGuardService) {
      const shiftParts = dto.shiftKey.split(":");
      const shift = (shiftParts[1] || "MORNING") as any;
      const proposedStart = now;
      const proposedEnd = new Date(now.getTime() + 8 * 60 * 60 * 1000);

      const check = await this.legalGuardService.validate({
        guardId: dto.guardId,
        startTime: proposedStart,
        endTime: proposedEnd,
        isOvertime: true
      });

      if (!check.ok) {
        legalWarning = `LegalGuard warnings: ${check.violations.join("; ")}`;
      }
    }

    return await this.db.transaction(async (tx) => {
      const siteId = await this.getPrimarySiteId(tx);

      const postStateRes = await tx.query(`SELECT status FROM post_state WHERE post_id = $1;`, [dto.postId]);
      if (postStateRes.rows.length > 0 && postStateRes.rows[0].status === "NOT_ACTIVE") {
        await this.apply(tx, {
          kind: "SHIFT_START",
          postId: dto.postId,
          payload: { postActiveThisShift: true },
          siteId,
          simTs: now
        });
      }

      // Update post state via single entry point apply()
      await this.apply(tx, {
        kind: "CHECKIN_ACCEPTED",
        postId: dto.postId,
        actorId: dto.guardId,
        payload: {
          guardId: dto.guardId,
          override: true,
          reason: dto.reason,
          legalWarning,
          dispatcherId
        },
        siteId,
        simTs: now
      });

      // Update or insert assignment
      const shiftParts = dto.shiftKey.split(":");
      const shiftCode = shiftParts[1] || "MORNING";

      const shiftTplRes = await tx.query(
        `SELECT start_time, end_time FROM shift_templates WHERE code = $1;`,
        [shiftCode]
      );
      let shiftDurationMinutes = 480;
      if (shiftTplRes.rows.length > 0) {
        const [sh, sm] = shiftTplRes.rows[0].start_time.split(":").map(Number);
        const [eh, em] = shiftTplRes.rows[0].end_time.split(":").map(Number);
        let diffMin = (eh * 60 + em) - (sh * 60 + sm);
        if (diffMin <= 0) diffMin += 24 * 60;
        shiftDurationMinutes = diffMin;
      }

      const existingAssign = await tx.query(
        `SELECT id FROM assignments 
         WHERE guard_id = $1 AND shift = $2 AND status = 'ACTIVE' AND period @> $3::timestamptz;`,
        [dto.guardId, shiftCode, now]
      );

      if (existingAssign.rows.length > 0) {
        await tx.query(
          `UPDATE assignments SET post_id = $1, source = 'MANUAL' WHERE id = $2;`,
          [dto.postId, existingAssign.rows[0].id]
        );
      } else {
        await tx.query(
          `INSERT INTO assignments (guard_id, post_id, role, shift, period, source, status)
           VALUES ($1, $2, 'FIXED', $3, tstzrange($4, ($4::timestamptz + ($5 || ' minutes')::interval), '[)'), 'MANUAL', 'ACTIVE');`,
          [dto.guardId, dto.postId, shiftCode, now, shiftDurationMinutes]
        );
      }

      // Insert dispatch_orders kind 'OVERRIDE'
      const orderRes = await tx.query(
        `INSERT INTO dispatch_orders (shift_key, kind, to_guard_id, to_post, status, explain, sent_at, ack_at)
         VALUES ($1, 'OVERRIDE', $2, $3, 'ACKED', $4, $5, $5)
         RETURNING id;`,
        [
          dto.shiftKey,
          dto.guardId,
          dto.postId,
          JSON.stringify({
            override: true,
            reason: dto.reason,
            dispatcherId,
            legalWarning,
            actions: [{ action: "MANUAL_OVERRIDE", guardId: dto.guardId, toPost: dto.postId, reason: dto.reason }]
          }),
          now
        ]
      );

      await this.outboxService.enqueue(tx, "dispatch.override", {
        orderId: Number(orderRes.rows[0].id),
        guardId: dto.guardId,
        postId: dto.postId,
        shiftKey: dto.shiftKey,
        reason: dto.reason
      });

      return {
        id: Number(orderRes.rows[0].id),
        shiftKey: dto.shiftKey,
        kind: "OVERRIDE",
        toGuardId: dto.guardId,
        fromPost: null,
        toPost: dto.postId,
        status: "ACKED",
        explain: {
          winner: { guardId: dto.guardId, reason: dto.reason },
          rejected: [],
          actions: [{ action: "MANUAL_OVERRIDE", guardId: dto.guardId, toPost: dto.postId, reason: dto.reason }]
        },
        sentAt: now.toISOString(),
        ackAt: now.toISOString(),
        idemKey: null
      };
    });
  }
}

