import { Injectable, Inject, Optional } from "@nestjs/common";
import { PoolClient } from "pg";
import { Clock } from "@swms/contracts";
import { CLOCK_TOKEN } from "../../../../core/clock/clock.interface.js";
import { DatabaseService } from "../../../../core/database/database.service.js";
import { RankingService } from "../ranking.service.js";
import { OutboxService } from "../../outbox.service.js";

import { CandidateGuard } from "../types.js";

export interface MotionPayload {
  postId: string;
  shiftKey: string;
  confidence?: number;
  atTime?: string;
}

@Injectable()
export class MotionHandler {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RankingService) private readonly rankingService: RankingService,
    @Inject(OutboxService) private readonly outboxService: OutboxService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock
  ) {}

  async handle(
    client: PoolClient,
    payload: MotionPayload,
    options?: { siteId?: string; idemKey?: string; now?: Date }
  ): Promise<any> {
    const siteId = options?.siteId || "AEON_THANH_KHE_F1";
    const now = options?.now || this.clock.now();

    // 1. Find on-duty guards who can respond:
    // Prefer: supervisor or float, OR guards on Tier 2 posts.
    // If night shift and G1 guard is designated (scenario D1 specifies G1 guard for G5 if night):
    const shiftParts = payload.shiftKey.split(":");
    const forShift = shiftParts[1] || "NIGHT";

    // Query on-duty guards with their current post & tier
    const candidateRes = await client.query(
      `SELECT g.id, g.code, g.role, g.float_kind, g.ot_minutes_month, ps.post_id, pr.tier
       FROM post_state ps
       JOIN post_rules pr ON pr.post_id = ps.post_id
       JOIN guards g ON g.id = ps.guard_id
       WHERE ps.status = 'OCCUPIED'
         AND g.active = true;`
    );

    // Also look for floats/supervisors not tied to a post
    const freeRes = await client.query(
      `SELECT g.id, g.code, g.role, g.float_kind, g.ot_minutes_month, a.post_id
       FROM guards g
       JOIN assignments a ON a.guard_id = g.id AND a.shift = $1 AND a.status = 'ACTIVE'
       WHERE a.role IN ('FLOAT_T1', 'FLOAT_GEN', 'SUPERVISOR')
         AND g.active = true;`,
      [forShift]
    );

    const eligibleGuards: Array<CandidateGuard & { isTier1: boolean }> = [];

    // Add unassigned floats / supervisors (highest priority to review motion)
    for (const r of freeRes.rows) {
      const dispatches = await this.rankingService.getDispatchesToday(Number(r.id), shiftParts[0], client);
      eligibleGuards.push({
        id: Number(r.id),
        code: r.code,
        role: r.role,
        floatKind: r.float_kind || null,
        currentPostId: r.post_id || null,
        otMinutesMonth: Number(r.ot_minutes_month || 0),
        dispatchesToday: dispatches,
        isTier1: false
      });
    }

    // Add guards on Tier 2 posts (allowed to move/investigate)
    for (const r of candidateRes.rows) {
      const isT1 = r.tier === "TIER1";
      // In scenario D1, night shift at G5 explicitly targets G1 guard
      const isAllowedG1 = r.post_id === "G1" && forShift === "NIGHT";

      if (!isT1 || isAllowedG1) {
        const dispatches = await this.rankingService.getDispatchesToday(Number(r.id), shiftParts[0], client);
        eligibleGuards.push({
          id: Number(r.id),
          code: r.code,
          role: r.role,
          floatKind: r.float_kind || null,
          currentPostId: r.post_id,
          otMinutesMonth: Number(r.ot_minutes_month || 0),
          dispatchesToday: dispatches,
          isTier1: isT1
        });
      }
    }

    if (eligibleGuards.length === 0) {
      throw new Error(`No eligible guard found to review motion at post ${payload.postId}`);
    }

    // Rank candidates by distance to target post
    const ranked = await this.rankingService.rankCandidates(eligibleGuards, payload.postId, {
      client,
      atTime: now
    });

    const winner = ranked[0].candidate;
    const actions = [
      {
        action: "REVIEW_MOTION",
        guardId: winner.id,
        toPost: payload.postId,
        reason: `Dispatched to review motion at post ${payload.postId}`
      }
    ];

    // 2. Insert dispatch_orders kind 'REVIEW_MOTION'
    const orderRes = await client.query(
      `INSERT INTO dispatch_orders (shift_key, kind, to_guard_id, from_post, to_post, status, explain, sent_at, idem_key)
       VALUES ($1, 'REVIEW_MOTION', $2, $3, $4, 'SENT', $5, $6, $7)
       RETURNING id;`,
      [
        payload.shiftKey,
        winner.id,
        winner.currentPostId || null,
        payload.postId,
        JSON.stringify({
          winner: { guardId: winner.id, role: winner.role, score: ranked[0].scoreData.score },
          rejected: ranked.slice(1).map((r) => ({
            guardId: r.candidate.id,
            reason: "Ranked farther or higher load",
            score: r.scoreData.score
          })),
          actions
        }),
        now,
        options?.idemKey ? `${options.idemKey}_motion` : null
      ]
    );
    const orderId = Number(orderRes.rows[0].id);

    // 3. Open incident MOTION
    const incRes = await client.query(
      `INSERT INTO incidents (kind, post_id, guard_id, severity, opened_at, details)
       VALUES ('MOTION', $1, $2, 'MEDIUM', $3, $4)
       RETURNING id;`,
      [
        payload.postId,
        winner.id,
        now,
        JSON.stringify({
          confidence: payload.confidence || 0.9,
          orderId,
          guardCode: winner.code
        })
      ]
    );
    const incidentId = Number(incRes.rows[0].id);

    // 4. Enqueue Outbox message to guard room: guard:{id}
    await this.outboxService.enqueue(client, "dispatch.order", {
      orderId,
      kind: "REVIEW_MOTION",
      guardId: winner.id,
      postId: payload.postId,
      room: `guard:${winner.id}`
    });

    return {
      orderId,
      incidentId,
      guardId: winner.id,
      postId: payload.postId
    };
  }
}
