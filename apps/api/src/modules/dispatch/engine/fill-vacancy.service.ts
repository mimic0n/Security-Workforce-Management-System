import { Injectable, Inject, Optional, NotFoundException } from "@nestjs/common";
import { PoolClient } from "pg";
import { Clock } from "@swms/contracts";
import { CLOCK_TOKEN } from "../../../core/clock/clock.interface.js";
import { DatabaseService } from "../../../core/database/database.service.js";
import { ConfigService } from "../../policies/config.service.js";
import { RankingService } from "./ranking.service.js";
import { LegalGuardService } from "../legal-guard/legal-guard.service.js";
import { CandidateGuard, CascadeResult } from "./types.js";

@Injectable()
export class FillVacancyService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RankingService) private readonly rankingService: RankingService,
    @Inject(LegalGuardService) private readonly legalGuardService: LegalGuardService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Optional() @Inject(ConfigService) private readonly configService?: ConfigService
  ) {}

  /**
   * Main entry point for fillVacancy cascade (§8.2)
   */
  async fillVacancy(
    client: PoolClient,
    params: {
      postId: string;
      shiftKey: string;
      siteId?: string;
      now?: Date;
      idemKey?: string;
    }
  ): Promise<CascadeResult> {
    const siteId = params.siteId || "AEON_THANH_KHE_F1";
    const now = params.now || this.clock.now();

    // 1. Load target post & post_rules
    const postRuleRes = await client.query(
      `SELECT post_id, tier, max_vacant_sec, pair_with, active_shifts 
       FROM post_rules 
       WHERE post_id = $1;`,
      [params.postId]
    );

    if (postRuleRes.rows.length === 0) {
      throw new NotFoundException(`Post '${params.postId}' not found in post_rules`);
    }

    const postRule = postRuleRes.rows[0];
    const isTier1 = postRule.tier === "TIER1";

    // Parse shiftKey (format: YYYY-MM-DD:SHIFT or YYYY-MM-DD:SHIFT:SUFFIX)
    const shiftParts = params.shiftKey.split(":");
    const forDate = shiftParts[0] || now.toISOString().slice(0, 10);
    const rawShift = (shiftParts[1] || "").toUpperCase();
    const forShift: "MORNING" | "AFTERNOON" | "NIGHT" =
      rawShift === "AFTERNOON" || rawShift === "NIGHT" ? rawShift : "MORNING";

    // Track rejected candidates & actions for explain output
    const rejected: Array<{ guardId: number; role?: string; reason: string; score?: number }> = [];
    const actions: Array<{ action: string; guardId?: number; fromPost?: string; toPost?: string; reason: string }> = [];

    // --- TIER 2 POST LOGIC ---
    if (!isTier1) {
      // 1. Try pair_with merge
      if (postRule.pair_with && postRule.pair_with.length > 0) {
        const pairId = postRule.pair_with[0];
        const pairStateRes = await client.query(
          `SELECT post_id, status, guard_id FROM post_state WHERE post_id = $1 FOR UPDATE;`,
          [pairId]
        );

        if (pairStateRes.rows.length > 0 && pairStateRes.rows[0].status === "OCCUPIED" && pairStateRes.rows[0].guard_id) {
          const pairGuardId = Number(pairStateRes.rows[0].guard_id);

          // Update this post to COVERED_BY_PAIR
          await client.query(
            `UPDATE post_state 
             SET status = 'COVERED_BY_PAIR', guard_id = $1, since = $2, deadline_at = NULL, version = version + 1 
             WHERE post_id = $3;`,
            [pairGuardId, now, params.postId]
          );

          // Record state event
          await client.query(
            `INSERT INTO state_events (site_id, post_id, from_status, to_status, cause, actor_id, payload, sim_ts, real_ts)
             VALUES ($1, $2, 'VACANT_ALERT', 'COVERED_BY_PAIR', 'MERGE_WITH_PAIR', NULL, $3, $4, clock_timestamp());`,
            [siteId, params.postId, JSON.stringify({ pairId, guardId: pairGuardId }), now]
          );

          const action = {
            action: "MERGE_POST",
            guardId: pairGuardId,
            fromPost: pairId,
            toPost: params.postId,
            reason: `Covered by paired post ${pairId}`
          };
          actions.push(action);

          // Create dispatch order kind MERGE_POST
          const orderRes = await client.query(
            `INSERT INTO dispatch_orders (shift_key, kind, to_guard_id, from_post, to_post, status, explain, sent_at, ack_at, idem_key)
             VALUES ($1, 'MERGE_POST', $2, $3, $4, 'ACKED', $5, $6, $6, $7)
             ON CONFLICT (idem_key) DO UPDATE SET status = dispatch_orders.status
             RETURNING id;`,
            [
              params.shiftKey,
              pairGuardId,
              pairId,
              params.postId,
              JSON.stringify({ winner: { guardId: pairGuardId, reason: "Paired guard" }, rejected, actions }),
              now,
              params.idemKey ? `${params.idemKey}_merge` : null
            ]
          );

          return {
            success: true,
            step: 0,
            stepName: "TIER2_PAIR_MERGE",
            winner: {
              id: pairGuardId,
              code: `G_${pairGuardId}`,
              role: "GUARD",
              floatKind: null,
              otMinutesMonth: 0,
              dispatchesToday: 0
            },
            orderKind: "MERGE_POST",
            orderStatus: "ACKED",
            fromPost: pairId,
            toPost: params.postId,
            actions,
            rejected,
            orderId: Number(orderRes.rows[0].id)
          };
        }
      }

      // 2. Accept VACANT_PLANNED if under max_vacant_sec
      if (postRule.max_vacant_sec > 0) {
        await client.query(
          `UPDATE post_state 
           SET status = 'VACANT_PLANNED', guard_id = NULL, since = $1, deadline_at = $2, version = version + 1 
           WHERE post_id = $3;`,
          [now, new Date(now.getTime() + postRule.max_vacant_sec * 1000), params.postId]
        );

        await client.query(
          `INSERT INTO state_events (site_id, post_id, from_status, to_status, cause, actor_id, payload, sim_ts, real_ts)
           VALUES ($1, $2, 'VACANT_ALERT', 'VACANT_PLANNED', 'ACCEPT_PLANNED_GAP', NULL, $3, $4, clock_timestamp());`,
          [siteId, params.postId, JSON.stringify({ maxVacantSec: postRule.max_vacant_sec }), now]
        );

        const action = {
          action: "ACCEPT_GAP",
          toPost: params.postId,
          reason: `Post allowed vacant up to ${postRule.max_vacant_sec}s`
        };
        actions.push(action);

        return {
          success: true,
          step: 0,
          stepName: "TIER2_ACCEPT_GAP",
          orderKind: "ASSIGNMENT",
          orderStatus: "ACKED",
          toPost: params.postId,
          actions,
          rejected
        };
      }
      // If max_vacant_sec == 0 or exhausted, fall through to steps 1-2
    }

    // --- TIER 1 POST CASCADE (Steps 1 to 6) ---

    // Helper: query available on-shift guards by role
    const getOnShiftGuardsByRole = async (
      roleFilter: string,
      floatKindFilter?: string | null
    ): Promise<CandidateGuard[]> => {
      let query = `
        SELECT g.id, g.code, g.role, g.float_kind, g.ot_minutes_month, a.post_id as current_post_id
        FROM guards g
        JOIN assignments a ON a.guard_id = g.id AND a.shift = $1 AND a.status = 'ACTIVE'
        WHERE g.active = true
          AND a.period @> $2::timestamptz
          AND a.role = $3
          AND NOT EXISTS (
            SELECT 1 FROM absences abs 
            WHERE abs.guard_id = g.id 
              AND abs.for_date = $4 
              AND abs.for_shift = $1 
              AND abs.status IN ('REPORTED', 'HANDLED')
          )
      `;
      const qParams: any[] = [forShift, now, roleFilter, forDate];

      if (floatKindFilter) {
        query += ` AND g.float_kind = $5`;
        qParams.push(floatKindFilter);
      }

      const res = await client.query(query, qParams);
      const candidates: CandidateGuard[] = [];

      for (const row of res.rows) {
        const dispatches = await this.rankingService.getDispatchesToday(Number(row.id), forDate, client);
        candidates.push({
          id: Number(row.id),
          code: row.code,
          role: row.role,
          floatKind: row.float_kind,
          currentPostId: row.current_post_id,
          otMinutesMonth: Number(row.ot_minutes_month || 0),
          dispatchesToday: dispatches
        });
      }

      return candidates;
    };

    // Helper: assign winning guard to post and update DB state
    const executeDirectAssignment = async (
      step: number,
      stepName: string,
      winner: CandidateGuard,
      score: number,
      actionReason: string
    ): Promise<CascadeResult> => {
      // 1. Update post_state to OCCUPIED
      await client.query(
        `UPDATE post_state 
         SET status = 'OCCUPIED', guard_id = $1, since = $2, deadline_at = NULL, version = version + 1 
         WHERE post_id = $3;`,
        [winner.id, now, params.postId]
      );

      // 2. Append state_events
      await client.query(
        `INSERT INTO state_events (site_id, post_id, from_status, to_status, cause, actor_id, payload, sim_ts, real_ts)
         VALUES ($1, $2, 'VACANT_ALERT', 'OCCUPIED', 'REPLACEMENT_ASSIGNED', NULL, $3, $4, clock_timestamp());`,
        [siteId, params.postId, JSON.stringify({ guardId: winner.id, stepName }), now]
      );

      // 3. Update existing assignment or insert new DISPATCH assignment
      const existingAssign = await client.query(
        `SELECT id FROM assignments 
         WHERE guard_id = $1 AND shift = $2 AND status = 'ACTIVE' AND period @> $3::timestamptz;`,
        [winner.id, forShift, now]
      );

      if (existingAssign.rows.length > 0) {
        await client.query(
          `UPDATE assignments SET post_id = $1, source = 'DISPATCH' WHERE id = $2;`,
          [params.postId, existingAssign.rows[0].id]
        );
      } else {
        await client.query(
          `INSERT INTO assignments (guard_id, post_id, role, shift, period, source, status)
           VALUES ($1, $2, 'FIXED', $3, tstzrange($4, ($4::timestamptz + interval '8 hours'), '[)'), 'DISPATCH', 'ACTIVE');`,
          [winner.id, params.postId, forShift, now]
        );
      }

      const action = {
        action: `ASSIGN_${stepName}`,
        guardId: winner.id,
        toPost: params.postId,
        reason: actionReason
      };
      actions.push(action);

      // 4. Record dispatch_orders
      const orderRes = await client.query(
        `INSERT INTO dispatch_orders (shift_key, kind, to_guard_id, from_post, to_post, status, explain, sent_at, ack_at, idem_key)
         VALUES ($1, 'ASSIGNMENT', $2, $3, $4, 'ACKED', $5, $6, $6, $7)
         ON CONFLICT (idem_key) DO UPDATE SET status = dispatch_orders.status
         RETURNING id;`,
        [
          params.shiftKey,
          winner.id,
          winner.currentPostId || null,
          params.postId,
          JSON.stringify({
            winner: { guardId: winner.id, score, role: winner.role, reason: actionReason },
            rejected,
            actions
          }),
          now,
          params.idemKey ? `${params.idemKey}_fill_${step}` : null
        ]
      );

      return {
        success: true,
        step,
        stepName,
        winner,
        score,
        orderKind: "ASSIGNMENT",
        orderStatus: "ACKED",
        fromPost: winner.currentPostId,
        toPost: params.postId,
        actions,
        rejected,
        orderId: Number(orderRes.rows[0].id)
      };
    };

    // --- STEP 1: FLOAT_T1 free ---
    const t1Floats = await getOnShiftGuardsByRole("FLOAT_T1", "TIER1_RELIEF");
    // Filter only those not already covering a fixed post
    const freeT1Floats: CandidateGuard[] = [];
    for (const f of t1Floats) {
      if (f.currentPostId) {
        rejected.push({
          guardId: f.id,
          role: "FLOAT_T1",
          reason: `Already assigned to post ${f.currentPostId}`
        });
        continue;
      }
      freeT1Floats.push(f);
    }

    if (freeT1Floats.length > 0) {
      const ranked = await this.rankingService.rankCandidates(freeT1Floats, params.postId, {
        client,
        atTime: now
      });

      const winnerData = ranked[0];
      // Mark others as rejected with lower rank
      for (let i = 1; i < ranked.length; i++) {
        rejected.push({
          guardId: ranked[i].candidate.id,
          role: "FLOAT_T1",
          reason: "Ranked lower than winning FLOAT_T1",
          score: ranked[i].scoreData.score
        });
      }

      return executeDirectAssignment(
        1,
        "FLOAT_T1",
        winnerData.candidate,
        winnerData.scoreData.score,
        "First-choice Tier 1 relief float"
      );
    }

    // --- STEP 2: FLOAT_GEN free ---
    const genFloats = await getOnShiftGuardsByRole("FLOAT_GEN", "GENERAL");
    const freeGenFloats: CandidateGuard[] = [];
    for (const f of genFloats) {
      if (f.currentPostId) {
        rejected.push({
          guardId: f.id,
          role: "FLOAT_GEN",
          reason: `Already assigned to post ${f.currentPostId}`
        });
        continue;
      }
      freeGenFloats.push(f);
    }

    if (freeGenFloats.length > 0) {
      const ranked = await this.rankingService.rankCandidates(freeGenFloats, params.postId, {
        client,
        atTime: now
      });

      const winnerData = ranked[0];
      for (let i = 1; i < ranked.length; i++) {
        rejected.push({
          guardId: ranked[i].candidate.id,
          role: "FLOAT_GEN",
          reason: "Ranked lower than winning FLOAT_GEN",
          score: ranked[i].scoreData.score
        });
      }

      return executeDirectAssignment(
        2,
        "FLOAT_GEN",
        winnerData.candidate,
        winnerData.scoreData.score,
        "Second-choice general float"
      );
    }

    // --- STEP 3: Tier-2 pull (only when target vacancy is Tier 1) ---
    if (isTier1) {
      const tier2Res = await client.query(
        `SELECT g.id, g.code, g.role, g.float_kind, g.ot_minutes_month, ps.post_id, pr.max_vacant_sec, pr.pair_with
         FROM post_state ps
         JOIN post_rules pr ON pr.post_id = ps.post_id
         JOIN guards g ON g.id = ps.guard_id
         WHERE pr.tier = 'TIER2'
           AND ps.status = 'OCCUPIED'
           AND g.active = true;`
      );

      const pullableTier2Candidates: CandidateGuard[] = [];
      const postContextMap = new Map<string, { maxVacantSec: number; pairWith: string[] }>();

      for (const row of tier2Res.rows) {
        const pId = row.post_id;
        postContextMap.set(pId, {
          maxVacantSec: Number(row.max_vacant_sec || 0),
          pairWith: row.pair_with || []
        });

        // Can this Tier-2 post be vacated?
        // Allowed if max_vacant_sec > 0 OR its pair post is currently OCCUPIED
        let canVacate = Number(row.max_vacant_sec || 0) > 0;
        if (!canVacate && row.pair_with && row.pair_with.length > 0) {
          const pairCheck = await client.query(
            `SELECT status FROM post_state WHERE post_id = $1;`,
            [row.pair_with[0]]
          );
          if (pairCheck.rows.length > 0 && pairCheck.rows[0].status === "OCCUPIED") {
            canVacate = true;
          }
        }

        if (!canVacate) {
          rejected.push({
            guardId: Number(row.id),
            role: "GUARD",
            reason: `Post ${pId} cannot be vacated (no occupied pair and max_vacant_sec = 0)`
          });
          continue;
        }

        const dispatches = await this.rankingService.getDispatchesToday(Number(row.id), forDate, client);
        pullableTier2Candidates.push({
          id: Number(row.id),
          code: row.code,
          role: row.role,
          floatKind: row.float_kind,
          currentPostId: pId,
          otMinutesMonth: Number(row.ot_minutes_month || 0),
          dispatchesToday: dispatches
        });
      }

      if (pullableTier2Candidates.length > 0) {
        const ranked = await this.rankingService.rankCandidates(pullableTier2Candidates, params.postId, {
          client,
          atTime: now
        });

        const winnerData = ranked[0];
        const pulledGuard = winnerData.candidate;
        const sourcePostId = pulledGuard.currentPostId!;
        const sourcePostContext = postContextMap.get(sourcePostId)!;

        // Determine transition for the pulled-from post
        let sourceToStatus: "COVERED_BY_PAIR" | "VACANT_PLANNED" = "VACANT_PLANNED";
        let sourceCause = "ACCEPT_PLANNED_GAP";
        let pairGuardId: number | null = null;

        if (sourcePostContext.pairWith && sourcePostContext.pairWith.length > 0) {
          const pairRes = await client.query(
            `SELECT guard_id, status FROM post_state WHERE post_id = $1;`,
            [sourcePostContext.pairWith[0]]
          );
          if (pairRes.rows.length > 0 && pairRes.rows[0].status === "OCCUPIED") {
            sourceToStatus = "COVERED_BY_PAIR";
            sourceCause = "MERGE_WITH_PAIR";
            pairGuardId = pairRes.rows[0].guard_id ? Number(pairRes.rows[0].guard_id) : null;
          }
        }

        // Transition pulled-from post
        await client.query(
          `UPDATE post_state 
           SET status = $1, guard_id = $2, since = $3, deadline_at = $4, version = version + 1 
           WHERE post_id = $5;`,
          [
            sourceToStatus,
            pairGuardId,
            now,
            sourceToStatus === "VACANT_PLANNED"
              ? new Date(now.getTime() + sourcePostContext.maxVacantSec * 1000)
              : null,
            sourcePostId
          ]
        );

        await client.query(
          `INSERT INTO state_events (site_id, post_id, from_status, to_status, cause, actor_id, payload, sim_ts, real_ts)
           VALUES ($1, $2, 'OCCUPIED', $3, $4, NULL, $5, $6, clock_timestamp());`,
          [
            siteId,
            sourcePostId,
            sourceToStatus,
            sourceCause,
            JSON.stringify({ pulledTo: params.postId, pulledGuardId: pulledGuard.id }),
            now
          ]
        );

        actions.push({
          action: "PULL_TIER2_GUARD",
          guardId: pulledGuard.id,
          fromPost: sourcePostId,
          toPost: params.postId,
          reason: `Tier-2 guard pulled from ${sourcePostId} to cover critical Tier 1 post ${params.postId}`
        });

        actions.push({
          action: "TRANSITION_SOURCE_POST",
          fromPost: sourcePostId,
          reason: `Post ${sourcePostId} transitioned to ${sourceToStatus}`
        });

        for (let i = 1; i < ranked.length; i++) {
          rejected.push({
            guardId: ranked[i].candidate.id,
            role: "GUARD",
            reason: "Ranked lower than winning Tier-2 guard",
            score: ranked[i].scoreData.score
          });
        }

        return executeDirectAssignment(
          3,
          "TIER2_PULL",
          pulledGuard,
          winnerData.scoreData.score,
          `Tier-2 guard pulled from ${sourcePostId}`
        );
      }
    }

    // --- STEP 4: Supervisor (last resort) ---
    const supervisors = await getOnShiftGuardsByRole("SUPERVISOR");
    const freeSupervisors: CandidateGuard[] = [];
    for (const s of supervisors) {
      if (s.currentPostId) {
        rejected.push({
          guardId: s.id,
          role: "SUPERVISOR",
          reason: `Already assigned to post ${s.currentPostId}`
        });
        continue;
      }
      freeSupervisors.push(s);
    }

    if (freeSupervisors.length > 0) {
      const winner = freeSupervisors[0];
      return executeDirectAssignment(
        4,
        "SUPERVISOR",
        winner,
        999,
        "Supervisor assigned as last-resort on-duty fill"
      );
    }

    // --- STEP 5: Off-shift call-in (EARLY_CALL_IN / STAY_OVER) ---
    // Look for guards not currently on duty in this shift
    const offShiftGuardsRes = await client.query(
      `SELECT g.id, g.code, g.role, g.float_kind, g.ot_minutes_month, g.ot_minutes_year
       FROM guards g
       WHERE g.active = true
         AND g.role IN ('GUARD', 'FLOAT')
         AND NOT EXISTS (
           SELECT 1 FROM assignments a 
           WHERE a.guard_id = g.id 
             AND a.status = 'ACTIVE' 
             AND a.shift = $1
             AND a.period @> $2::timestamptz
         );`,
      [forShift, now]
    );

    const eligibleCallIns: Array<{
      candidate: CandidateGuard;
      estimatedCost: number;
    }> = [];

    // Define shift times for LegalGuard validation
    const proposedStart = now;
    const proposedEnd = new Date(now.getTime() + 8 * 60 * 60 * 1000); // 8-hour shift segment

    for (const row of offShiftGuardsRes.rows) {
      const gId = Number(row.id);

      // Validate with LegalGuardService
      const legalRes = await this.legalGuardService.validate({
        guardId: gId,
        startTime: proposedStart,
        endTime: proposedEnd,
        isOvertime: true
      });

      if (!legalRes.ok) {
        rejected.push({
          guardId: gId,
          role: row.role,
          reason: `FAILED_LEGAL_GUARD: ${legalRes.violations.join("; ")}`
        });
        continue;
      }

      // LegalGuard passed! Estimate cost
      const costRes = await this.legalGuardService.estimateCost({
        startTime: proposedStart,
        endTime: proposedEnd,
        isOvertime: true
      });

      eligibleCallIns.push({
        candidate: {
          id: gId,
          code: row.code,
          role: row.role,
          floatKind: row.float_kind,
          otMinutesMonth: Number(row.ot_minutes_month || 0),
          dispatchesToday: 0
        },
        estimatedCost: costRes.totalCost
      });
    }

    if (eligibleCallIns.length > 0) {
      // Pick candidate with lowest monthly OT
      eligibleCallIns.sort((a, b) => {
        if (a.candidate.otMinutesMonth !== b.candidate.otMinutesMonth) {
          return a.candidate.otMinutesMonth - b.candidate.otMinutesMonth;
        }
        return a.candidate.id - b.candidate.id;
      });

      const winnerData = eligibleCallIns[0];
      const winner = winnerData.candidate;

      for (let i = 1; i < eligibleCallIns.length; i++) {
        rejected.push({
          guardId: eligibleCallIns[i].candidate.id,
          role: eligibleCallIns[i].candidate.role,
          reason: "Ranked lower than winning off-shift call-in"
        });
      }

      const action = {
        action: "PROPOSE_EARLY_CALL_IN",
        guardId: winner.id,
        toPost: params.postId,
        reason: "Off-shift call-in proposal sent to guard (passed LegalGuard)"
      };
      actions.push(action);

      // Create proposal in dispatch_orders with status 'SENT'
      const orderRes = await client.query(
        `INSERT INTO dispatch_orders (shift_key, kind, to_guard_id, from_post, to_post, status, explain, sent_at, ack_at, idem_key)
         VALUES ($1, 'EARLY_CALL_IN', $2, NULL, $3, 'SENT', $4, $5, NULL, $6)
         ON CONFLICT (idem_key) DO UPDATE SET status = dispatch_orders.status
         RETURNING id;`,
        [
          params.shiftKey,
          winner.id,
          params.postId,
          JSON.stringify({
            winner: {
              guardId: winner.id,
              role: winner.role,
              reason: "Passed LegalGuard; lowest overtime"
            },
            rejected,
            actions,
            estimatedCost: winnerData.estimatedCost
          }),
          now,
          params.idemKey ? `${params.idemKey}_callin` : null
        ]
      );

      return {
        success: true,
        step: 5,
        stepName: "EARLY_CALL_IN",
        winner,
        orderKind: "EARLY_CALL_IN",
        orderStatus: "SENT",
        toPost: params.postId,
        actions,
        rejected,
        estimatedCost: winnerData.estimatedCost,
        orderId: Number(orderRes.rows[0].id)
      };
    }

    // --- STEP 6: Escalate to dispatcher ---
    // Open high-severity incident
    const incRes = await client.query(
      `INSERT INTO incidents (kind, post_id, severity, opened_at, details)
       VALUES ('VACANCY', $1, 'HIGH', $2, $3)
       RETURNING id;`,
      [
        params.postId,
        now,
        JSON.stringify({
          reason: "Unfilled Tier-1 vacancy: all cascade steps exhausted",
          rejected
        })
      ]
    );

    // Create staffing request
    const reqRes = await client.query(
      `INSERT INTO staffing_requests (shift, qty, reason, status, created_at)
       VALUES ($1, 1, $2, 'OPEN', $3)
       RETURNING id;`,
      [forShift, `Structural shortage / unfilled Tier-1 post ${params.postId}`, now]
    );

    actions.push({
      action: "ESCALATE_TO_DISPATCHER",
      toPost: params.postId,
      reason: "All 5 candidate cascade steps exhausted. Incident opened and staffing request created."
    });

    return {
      success: false,
      step: 6,
      stepName: "ESCALATE",
      toPost: params.postId,
      actions,
      rejected,
      incidentId: Number(incRes.rows[0].id),
      staffingRequestId: Number(reqRes.rows[0].id)
    };
  }
}
