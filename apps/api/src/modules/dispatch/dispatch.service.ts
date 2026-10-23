import { Injectable, Inject, NotFoundException, BadRequestException, Optional } from "@nestjs/common";
import { PoolClient } from "pg";
import {
  Clock,
  PostStateRecord,
  SiteStateRecord,
  StateTransitionEvent,
  TransitionResult,
  StateSnapshotResponse
} from "@swms/contracts";
import { CLOCK_TOKEN } from "../../core/clock/clock.interface.js";
import { DatabaseService } from "../../core/database/database.service.js";
import { ConfigService } from "../policies/config.service.js";
import { OutboxService } from "./outbox.service.js";
import { StateMachineService } from "./state-machine/state-machine.service.js";
import { OptimisticLockError } from "./state-machine/optimistic-lock.error.js";
import { InvalidTransitionError } from "./state-machine/invalid-transition.error.js";
import { PostContext } from "./state-machine/transitions.js";

@Injectable()
export class DispatchService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(StateMachineService) private readonly stateMachineService: StateMachineService,
    @Inject(OutboxService) private readonly outboxService: OutboxService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Optional() @Inject(ConfigService) private readonly configService?: ConfigService
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
    const shiftRes = await tx.query(`SELECT break_minutes FROM shift_templates LIMIT 1;`);
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
}
