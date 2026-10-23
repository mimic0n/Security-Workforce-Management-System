import { Injectable, Inject, Optional, forwardRef } from "@nestjs/common";
import { PoolClient } from "pg";
import { Clock } from "@swms/contracts";
import { CLOCK_TOKEN } from "../../../../core/clock/clock.interface.js";
import { DatabaseService } from "../../../../core/database/database.service.js";
import { FillVacancyService } from "../fill-vacancy.service.js";
import { MealPlannerService } from "../../meal-planner/meal-planner.service.js";
import { LegalGuardService } from "../../legal-guard/legal-guard.service.js";
import { RankingService } from "../ranking.service.js";
import { CandidateGuard } from "../types.js";
import { DispatchService } from "../../dispatch.service.js";

export interface AbsencePayload {
  guardId: number;
  shiftKey: string;
  date: string;
  shift: "MORNING" | "AFTERNOON" | "NIGHT";
  reason?: string;
  reportedAt?: string;
}

@Injectable()
export class AbsenceHandler {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(FillVacancyService) private readonly fillVacancyService: FillVacancyService,
    @Inject(MealPlannerService) private readonly mealPlannerService: MealPlannerService,
    @Inject(LegalGuardService) private readonly legalGuardService: LegalGuardService,
    @Inject(RankingService) private readonly rankingService: RankingService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Optional() @Inject(forwardRef(() => DispatchService)) private readonly dispatchService?: DispatchService
  ) {}

  async handle(
    client: PoolClient,
    payload: AbsencePayload,
    options?: { siteId?: string; idemKey?: string; now?: Date }
  ): Promise<any> {
    const siteId = options?.siteId || "AEON_THANH_KHE_F1";
    const now = options?.now || this.clock.now();
    const rawShift = (payload.shift || "").toUpperCase();
    const validShift: "MORNING" | "AFTERNOON" | "NIGHT" =
      rawShift === "AFTERNOON" || rawShift === "NIGHT" ? (rawShift as any) : "MORNING";

    // 1. Record or update absence row in absences table
    const existingAbs = await client.query(
      `SELECT id FROM absences WHERE guard_id = $1 AND for_shift = $2 AND for_date = $3;`,
      [payload.guardId, validShift, payload.date]
    );

    let absenceId: number;
    if (existingAbs.rows.length > 0) {
      absenceId = Number(existingAbs.rows[0].id);
      await client.query(
        `UPDATE absences SET status = 'HANDLED', reason = COALESCE($1, reason) WHERE id = $2;`,
        [payload.reason || "Reported sick", absenceId]
      );
    } else {
      const insRes = await client.query(
        `INSERT INTO absences (guard_id, reported_at, for_shift, for_date, reason, status, idem_key)
         VALUES ($1, $2, $3, $4, $5, 'HANDLED', $6)
         ON CONFLICT (idem_key) DO UPDATE SET status = 'HANDLED'
         RETURNING id;`,
        [
          payload.guardId,
          payload.reportedAt ? new Date(payload.reportedAt) : now,
          validShift,
          payload.date,
          payload.reason || "Reported absence",
          options?.idemKey ? `${options.idemKey}_abs_${payload.guardId}` : null
        ]
      );
      absenceId = Number(insRes.rows[0].id);
    }

    // 2. Find and cancel guard's ACTIVE assignment for this shift
    const assignRes = await client.query(
      `SELECT id, post_id, role, period 
       FROM assignments 
       WHERE guard_id = $1 AND shift = $2 AND status = 'ACTIVE'
       ORDER BY id DESC LIMIT 1;`,
      [payload.guardId, validShift]
    );

    let assignedPostId: string | null = null;
    let guardRole = "GUARD";

    if (assignRes.rows.length > 0) {
      const row = assignRes.rows[0];
      assignedPostId = row.post_id;
      guardRole = row.role;

      // Mark assignment CANCELLED
      await client.query(`UPDATE assignments SET status = 'CANCELLED' WHERE id = $1;`, [row.id]);
    } else {
      // Check guard profile role
      const guardRes = await client.query(`SELECT role, float_kind FROM guards WHERE id = $1;`, [payload.guardId]);
      if (guardRes.rows.length > 0) {
        guardRole = guardRes.rows[0].role;
        if (guardRes.rows[0].float_kind === "TIER1_RELIEF") guardRole = "FLOAT_T1";
      }
    }

    // Also check post_state to see if this guard is currently marked as assigned to any post
    const postStateRes = await client.query(
      `SELECT post_id, status FROM post_state WHERE guard_id = $1;`,
      [payload.guardId]
    );
    if (postStateRes.rows.length > 0) {
      assignedPostId = postStateRes.rows[0].post_id;
    }

    if (!assignedPostId && (payload as any).postId) {
      assignedPostId = (payload as any).postId;
    }

    // 3. Case A: Guard was assigned to a post -> Post is now vacant!
    if (assignedPostId) {
      // Transition post to VACANT_ALERT via single entry point apply()
      if (this.dispatchService) {
        await this.dispatchService.apply(client, {
          kind: "ABSENCE_REPORTED",
          postId: assignedPostId,
          actorId: payload.guardId,
          payload: { reason: payload.reason, absenceId },
          siteId,
          simTs: now,
          idemKey: options?.idemKey ? `${options.idemKey}_abs_${assignedPostId}` : undefined
        });
      } else {
        await client.query(
          `UPDATE post_state 
           SET status = 'VACANT_ALERT', guard_id = NULL, since = $1, deadline_at = NULL, version = version + 1 
           WHERE post_id = $2;`,
          [now, assignedPostId]
        );

        await client.query(
          `INSERT INTO state_events (site_id, post_id, from_status, to_status, cause, actor_id, payload, sim_ts, real_ts)
           VALUES ($1, $2, 'OCCUPIED', 'VACANT_ALERT', 'ABSENCE_REPORTED', $3, $4, $5, clock_timestamp());`,
          [
            siteId,
            assignedPostId,
            payload.guardId,
            JSON.stringify({ reason: payload.reason, absenceId }),
            now
          ]
        );
      }

      // Call fillVacancy cascade for this post
      const fillResult = await this.fillVacancyService.fillVacancy(client, {
        postId: assignedPostId,
        shiftKey: payload.shiftKey,
        siteId,
        now,
        idemKey: options?.idemKey
      });

      return {
        absenceId,
        guardId: payload.guardId,
        kind: "FIXED_VACANCY",
        postId: assignedPostId,
        fillResult
      };
    }

    // 4. Case B: Guard was a FLOAT (e.g. TIER1_RELIEF or GENERAL)
    if (guardRole === "FLOAT" || guardRole === "FLOAT_T1" || guardRole === "FLOAT_GEN") {
      // Trigger meal relief re-plan
      const replanResult = await this.mealPlannerService.replan({
        shiftKey: payload.shiftKey,
        shiftCode: payload.shift,
        date: payload.date
      });

      // If infeasible, find off-shift candidate passing LegalGuard and propose EARLY_CALL_IN
      let callInProposal: any = null;
      if (!replanResult.feasible) {
        const offShiftRes = await client.query(
          `SELECT g.id, g.code, g.role, g.float_kind, g.ot_minutes_month 
           FROM guards g 
           WHERE g.active = true 
             AND g.role IN ('GUARD', 'FLOAT')
             AND NOT EXISTS (
               SELECT 1 FROM assignments a 
               WHERE a.guard_id = g.id 
                 AND a.shift = $1 
                 AND a.status = 'ACTIVE' 
                 AND a.period @> $2::timestamptz
             );`,
          [payload.shift, now]
        );

        const rejected: Array<{ guardId: number; role?: string; reason: string }> = [];
        const eligibleCandidates: Array<{ candidate: CandidateGuard; estimatedCost: number }> = [];

        // Look up shift template for duration
        const shiftTplRes = await client.query(
          `SELECT start_time, end_time FROM shift_templates WHERE code = $1;`,
          [payload.shift]
        );
        let shiftDurationMinutes = 480;
        if (shiftTplRes.rows.length > 0) {
          const [sh, sm] = shiftTplRes.rows[0].start_time.split(":").map(Number);
          const [eh, em] = shiftTplRes.rows[0].end_time.split(":").map(Number);
          let diffMin = (eh * 60 + em) - (sh * 60 + sm);
          if (diffMin <= 0) diffMin += 24 * 60;
          shiftDurationMinutes = diffMin;
        }

        const proposedStart = now;
        const proposedEnd = new Date(now.getTime() + shiftDurationMinutes * 60 * 1000);

        for (const row of offShiftRes.rows) {
          const gId = Number(row.id);
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

          const costRes = await this.legalGuardService.estimateCost({
            startTime: proposedStart,
            endTime: proposedEnd,
            isOvertime: true
          });

          eligibleCandidates.push({
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

        if (eligibleCandidates.length > 0) {
          eligibleCandidates.sort((a, b) => a.candidate.otMinutesMonth - b.candidate.otMinutesMonth);
          const winner = eligibleCandidates[0].candidate;

          for (let i = 1; i < eligibleCandidates.length; i++) {
            rejected.push({
              guardId: eligibleCandidates[i].candidate.id,
              role: eligibleCandidates[i].candidate.role,
              reason: "Ranked lower than winning early call-in candidate"
            });
          }

          const orderRes = await client.query(
            `INSERT INTO dispatch_orders (shift_key, kind, to_guard_id, status, explain, sent_at, ack_at, idem_key)
             VALUES ($1, 'EARLY_CALL_IN', $2, 'SENT', $3, $4, NULL, $5)
             RETURNING id;`,
            [
              payload.shiftKey,
              winner.id,
              JSON.stringify({
                winner: { guardId: winner.id, reason: "Passed LegalGuard for meal relief coverage" },
                rejected,
                actions: [{ action: "PROPOSE_EARLY_CALL_IN", guardId: winner.id, reason: "Meal relief float replacement" }],
                suggestions: replanResult.suggestions
              }),
              now,
              options?.idemKey ? `${options.idemKey}_callin_float` : null
            ]
          );

          callInProposal = {
            orderId: Number(orderRes.rows[0].id),
            candidateId: winner.id,
            rejected
          };
        }
      }

      return {
        absenceId,
        guardId: payload.guardId,
        kind: "FLOAT_ABSENCE",
        replanResult,
        callInProposal
      };
    }

    return {
      absenceId,
      guardId: payload.guardId,
      kind: "UNASSIGNED_ABSENCE"
    };
  }
}
