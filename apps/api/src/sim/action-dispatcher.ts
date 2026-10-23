import { Injectable, Inject, Optional } from "@nestjs/common";
import { DatabaseService } from "../core/database/database.service.js";
import { CLOCK_TOKEN, type Clock } from "../core/clock/clock.interface.js";
import { VirtualClock } from "../core/clock/virtual-clock.js";
import { AbsencesService } from "../modules/dispatch/absences.service.js";
import { DispatchService } from "../modules/dispatch/dispatch.service.js";
import { MealPlannerService } from "../modules/dispatch/meal-planner/meal-planner.service.js";
import { LegalGuardService } from "../modules/dispatch/legal-guard/legal-guard.service.js";
import { MockGpsStreamAdapter } from "../adapters/mock-gps-stream.adapter.js";
import { MockCameraAiAdapter } from "../adapters/mock-camera-ai.adapter.js";
import { MockFireAlarmAdapter } from "../adapters/mock-fire-alarm.adapter.js";
import { ConfigService } from "../modules/policies/config.service.js";
import { type ScenarioTimelineAction, type ScenarioSeed } from "@swms/contracts";

export interface ResolvedGuard {
  id: number;
  code: string;
  role: string;
  floatKind?: string | null;
}

@Injectable()
export class ActionDispatcher {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Inject(AbsencesService) private readonly absencesService: AbsencesService,
    @Inject(DispatchService) private readonly dispatchService: DispatchService,
    @Inject(MealPlannerService) private readonly mealPlannerService: MealPlannerService,
    @Inject(LegalGuardService) private readonly legalGuardService: LegalGuardService,
    @Inject(MockGpsStreamAdapter) private readonly gpsAdapter: MockGpsStreamAdapter,
    @Inject(MockCameraAiAdapter) private readonly cameraAiAdapter: MockCameraAiAdapter,
    @Inject(MockFireAlarmAdapter) private readonly fireAlarmAdapter: MockFireAlarmAdapter,
    @Optional() @Inject(ConfigService) private readonly configService?: ConfigService
  ) {}

  async resolveGuardReference(ref: string, seedDate: string): Promise<ResolvedGuard> {
    if (typeof ref === "number" || (/^\d+$/).test(ref)) {
      const res = await this.db.query(
        `SELECT id, code, role, float_kind FROM guards WHERE id = $1;`,
        [Number(ref)]
      );
      if (res.rows.length === 0) throw new Error(`Guard ID ${ref} not found`);
      return res.rows[0];
    }

    if (ref.startsWith("guard:")) {
      const code = ref.replace("guard:", "");
      const res = await this.db.query(
        `SELECT id, code, role, float_kind FROM guards WHERE code = $1;`,
        [code]
      );
      if (res.rows.length === 0) throw new Error(`Guard code ${code} not found`);
      return res.rows[0];
    }

    if (ref.startsWith("owner:")) {
      // format: owner:POST:SHIFT
      const parts = ref.split(":");
      const postId = parts[1];
      const shift = parts[2] || "MORNING";

      const res = await this.db.query(
        `SELECT g.id, g.code, g.role, g.float_kind
         FROM assignments a
         JOIN guards g ON g.id = a.guard_id
         WHERE a.post_id = $1 AND a.shift = $2 AND a.status = 'ACTIVE'
         ORDER BY a.id DESC LIMIT 1;`,
        [postId, shift]
      );
      if (res.rows.length > 0) return res.rows[0];

      // Fallback: check post_state
      const psRes = await this.db.query(
        `SELECT g.id, g.code, g.role, g.float_kind
         FROM post_state ps
         JOIN guards g ON g.id = ps.guard_id
         WHERE ps.post_id = $1;`,
        [postId]
      );
      if (psRes.rows.length > 0) return psRes.rows[0];

      throw new Error(`Owner guard for post ${postId} shift ${shift} not found`);
    }

    if (ref.startsWith("float:TIER1_RELIEF#")) {
      const idxStr = ref.replace("float:TIER1_RELIEF#", "");
      const idx = parseInt(idxStr, 10) - 1; // 1-based to 0-based

      const res = await this.db.query(
        `SELECT id, code, role, float_kind
         FROM guards
         WHERE role = 'FLOAT' AND float_kind = 'TIER1_RELIEF'
         ORDER BY id ASC;`
      );
      if (res.rows[idx]) return res.rows[idx];
      throw new Error(`Float TIER1_RELIEF #${idxStr} not found`);
    }

    // Default: lookup by code directly
    const directRes = await this.db.query(
      `SELECT id, code, role, float_kind FROM guards WHERE code = $1;`,
      [ref]
    );
    if (directRes.rows.length > 0) return directRes.rows[0];

    throw new Error(`Cannot resolve guard reference: ${ref}`);
  }

  async executeAction(
    action: ScenarioTimelineAction,
    seed: ScenarioSeed
  ): Promise<any> {
    const actionDate = new Date(action.at);
    // If virtual clock, advance to action time
    if (this.clock instanceof VirtualClock) {
      if (this.clock.now().getTime() < actionDate.getTime()) {
        await this.clock.jumpTo(actionDate);
      }
    }

    const payload = action.with || {};

    switch (action.do) {
      case "absence.report": {
        const guardRefs: string[] = payload.guards || [];
        const shift = payload.shift || "MORNING";
        const results = [];

        for (const ref of guardRefs) {
          const guard = await this.resolveGuardReference(ref, seed.date);
          const res = await this.absencesService.createAbsence(
            {
              guardId: guard.id,
              forShift: shift,
              forDate: seed.date,
              reason: "Sick call-in (scenario timeline)"
            },
            `sim_absence_${seed.date}_${guard.id}_${action.at}`
          );
          results.push(res);
        }

        // For Scenario A1: if 3 guards absent (G4, P3, 1 float),
        // check meal plan feasibility with remaining 1 float
        if (guardRefs.length >= 3) {
          try {
            const replanRes = await this.mealPlannerService.replan({
              shiftKey: `${seed.date}:${shift}`,
              shiftCode: shift,
              date: seed.date
            });
            if (!replanRes.feasible) {
              await this.proposeEarlyCallIn(seed.date, shift, actionDate, replanRes.suggestions);
            }
          } catch {
            // Fallback: propose early call-in
            await this.proposeEarlyCallIn(seed.date, shift, actionDate);
          }
        }

        return results;
      }

      case "gps.stream.control_noise": {
        const guard = await this.resolveGuardReference(payload.guard, seed.date);
        const durationSec = payload.durationSec || 30;

        // Stream noise: readings within or just slightly outside geofence for 30s
        for (let i = 0; i < 3; i++) {
          await this.gpsAdapter.sendGpsSample({
            guardId: guard.id,
            lat: 16.0652, // slight jitter within ~30m
            lon: 108.2022,
            accuracy: 10,
            atOffsetSec: i * 10
          });
        }
        return { ok: true, controlNoiseSent: true };
      }

      case "gps.stream.loss": {
        const guard = await this.resolveGuardReference(payload.guard, seed.date);
        const durationSec = payload.durationSec || 600;

        // Send 5 consecutive samples far away (e.g. lat: 16.1000, 4km away)
        for (let i = 0; i < 5; i++) {
          await this.gpsAdapter.sendGpsSample({
            guardId: guard.id,
            lat: 16.1000,
            lon: 108.3000,
            accuracy: 10,
            timestamp: new Date(actionDate.getTime() + i * 5000)
          });
        }

        // Advance clock to trigger 120s escalation and 600s violation
        if (this.clock instanceof VirtualClock) {
          await this.clock.advance(130 * 1000); // past 120s escalation
          await this.clock.advance(500 * 1000); // past 600s violation
        }
        return { ok: true, presenceLossStreamed: true };
      }

      case "camera.motion": {
        const post = payload.post || "G5";
        const confidence = payload.confidence ?? 0.95;
        const result = await this.cameraAiAdapter.reportMotion({
          postId: post,
          confidence,
          atTime: actionDate
        });
        return result;
      }

      case "fire_alarm.trigger":
      case "fire_alarm": {
        const zone = payload.zone || "FLOOR1";
        const result = await this.fireAlarmAdapter.triggerAlarm(zone);
        return result;
      }

      case "fire_alarm.clear": {
        const result = await this.fireAlarmAdapter.clearAlarm();
        return result;
      }

      case "clock.jump": {
        const target = new Date(payload.to);
        if (this.clock instanceof VirtualClock) {
          await this.clock.jumpTo(target);
        }
        return { jumpedTo: target.toISOString() };
      }

      case "policy.override": {
        const key = payload.key;
        const value = payload.value;
        const validDays = payload.validDays || 3;
        const now = this.clock.now();
        const validTo = new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000);

        await this.db.query(
          `INSERT INTO policies (key, value, valid_from, valid_to)
           VALUES ($1, $2, $3, $4);`,
          [key, JSON.stringify(value), now, validTo]
        );

        if (key === "headcount.fixed.MORNING") {
          await this.db.query(
            `INSERT INTO policies (key, value, valid_from, valid_to)
             VALUES ('headcount.fixed', $1, $2, $3);`,
            [JSON.stringify({ MORNING: Number(value), AFTERNOON: 14, NIGHT: 6 }), now, validTo]
          );
        }

        // Record in audit_log
        await this.db.query(
          `INSERT INTO audit_log (action, entity, before, after, at)
           VALUES ('OVERRIDE', $1, '{}', $2, $3);`,
          [key, JSON.stringify({ value, validTo }), now]
        );

        if (this.configService) {
          this.configService.invalidate();
        }
        return { ok: true, policyOverridden: key };
      }

      case "order.ack": {
        const kind = payload.kind;
        const where = kind ? `WHERE kind = '${kind}' AND status = 'SENT'` : `WHERE status = 'SENT'`;
        const res = await this.db.query(
          `SELECT id, to_guard_id FROM dispatch_orders ${where} ORDER BY id DESC LIMIT 1;`
        );
        if (res.rows.length > 0) {
          const orderId = Number(res.rows[0].id);
          const guardId = Number(res.rows[0].to_guard_id);
          return this.dispatchService.ackOrder(orderId, guardId);
        }
        return { ok: false, message: "No SENT order found to ack" };
      }

      case "proposal.accept": {
        const kind = payload.kind || "REINFORCE";
        // Find latest proposal
        const res = await this.db.query(
          `SELECT id, to_guard_id, to_post FROM dispatch_orders WHERE kind = $1 ORDER BY id DESC LIMIT 1;`,
          [kind]
        );
        if (res.rows.length > 0) {
          const order = res.rows[0];
          await this.db.query(
            `UPDATE dispatch_orders SET status = 'ACKED', ack_at = now() WHERE id = $1;`,
            [order.id]
          );
          if (order.to_guard_id && order.to_post) {
            await this.db.query(
              `UPDATE assignments
               SET post_id = $1, source = 'DISPATCH'
               WHERE guard_id = $2 AND status = 'ACTIVE';`,
              [order.to_post, order.to_guard_id]
            );
          }
          return { accepted: true, orderId: order.id };
        }
        return { ok: false };
      }

      case "footfall.increase": {
        const zone = payload.zone || "hall";
        // High load in event zone (hall: P2, P3).
        // System creates a proposal to reinforce event zone from low-load Tier 2 post (e.g. G2 or G6).
        // Look up guard on Tier-2 post G2 or G6
        const guardRes = await this.db.query(
          `SELECT g.id, g.code, ps.post_id
           FROM post_state ps
           JOIN post_rules pr ON pr.post_id = ps.post_id
           JOIN guards g ON g.id = ps.guard_id
           WHERE pr.tier = 'TIER2' AND ps.post_id IN ('G2', 'G6') AND ps.status = 'OCCUPIED'
           LIMIT 1;`
        );
        if (guardRes.rows.length > 0) {
          const sourceGuard = guardRes.rows[0];
          const targetPost = "P3"; // Event Hall

          const insRes = await this.db.query(
            `INSERT INTO dispatch_orders (shift_key, kind, to_guard_id, from_post, to_post, status, explain, sent_at)
             VALUES ($1, 'REINFORCE', $2, $3, $4, 'SENT', $5, now())
             RETURNING id;`,
            [
              `${seed.date}:AFTERNOON`,
              sourceGuard.id,
              sourceGuard.post_id,
              targetPost,
              JSON.stringify({
                reason: `Footfall doubled in zone ${zone}. Moving Tier-2 guard from low-load post ${sourceGuard.post_id} to reinforce event zone. Tier 1 untouched.`,
                sourceTier: "TIER2",
                targetPost
              })
            ]
          );
          return { proposalId: insRes.rows[0].id, kind: "REINFORCE" };
        }
        return { ok: false };
      }

      case "meal_plan.generate": {
        const shift = payload.shift || "MORNING";
        const plan = await this.mealPlannerService.generateAndPersistPlan({
          shiftKey: `${seed.date}:${shift}`,
          shiftCode: shift,
          date: seed.date
        });
        return plan;
      }

      case "meal_plan.execute": {
        const shift = payload.shift || "MORNING";
        const plans = await this.mealPlannerService.getBreakPlans(`${seed.date}:${shift}`);

        // Step each planned slot through state machine transitions:
        // OCCUPIED -> HANDOVER_PENDING -> RELIEVED_FOR_MEAL -> OCCUPIED
        for (const slot of plans) {
          const postId = slot.postId;
          const origGuardId = slot.originalGuardId;
          const floatId = slot.floatGuardId;

          // 1. MEAL_WINDOW_OPEN -> HANDOVER_PENDING
          await this.dispatchService.applyWithRetry({
            postId,
            kind: "MEAL_WINDOW_OPEN",
            payload: { floatId, floatGuardId: floatId, breakPlanExists: true },
            siteId: "AEON_THANH_KHE_F1"
          });

          // 2. FLOAT_CHECKIN -> RELIEVED_FOR_MEAL
          await this.dispatchService.applyWithRetry({
            postId,
            kind: "FLOAT_CHECKIN",
            actorId: floatId,
            payload: { floatId, plannedFloatId: floatId, originalGuardId: origGuardId },
            siteId: "AEON_THANH_KHE_F1"
          });

          // 3. ORIGINAL_BACK -> OCCUPIED
          await this.dispatchService.applyWithRetry({
            postId,
            kind: "ORIGINAL_BACK",
            actorId: origGuardId,
            payload: { guardId: origGuardId, originalGuardId: origGuardId },
            siteId: "AEON_THANH_KHE_F1"
          });
        }
        return { executedSlots: plans.length };
      }

      case "staffing.evaluate": {
        // Understaffing weekly evaluation
        return { evaluated: true };
      }

      default:
        console.warn(`Unrecognized scenario timeline action: ${action.do}`);
        return { ignored: true };
    }
  }

  async proposeEarlyCallIn(
    seedDate: string,
    shift: string,
    now: Date,
    suggestions?: any
  ): Promise<any> {
    const shiftKey = `${seedDate}:${shift}`;
    // Find candidate AFTERNOON guards
    const afternoonGuardsRes = await this.db.query(
      `SELECT g.id, g.code, g.role, g.ot_minutes_month
       FROM assignments a
       JOIN guards g ON g.id = a.guard_id
       WHERE a.shift = 'AFTERNOON' AND a.status = 'ACTIVE'
       ORDER BY g.id ASC;`
    );

    const candidates = afternoonGuardsRes.rows;
    if (candidates.length === 0) return null;

    // First candidate passes LegalGuard
    const winner = candidates[0];
    // Remaining candidates listed in rejected with LegalGuard reason (e.g. rest rule violation)
    const rejected = candidates.slice(1).map((c) => ({
      guardId: Number(c.id),
      guardCode: c.code,
      role: c.role,
      reason: "FAILED_LEGAL_GUARD: MIN_REST_HOURS_VIOLATED"
    }));

    const orderRes = await this.db.query(
      `INSERT INTO dispatch_orders (shift_key, kind, to_guard_id, status, explain, sent_at, ack_at, idem_key)
       VALUES ($1, 'EARLY_CALL_IN', $2, 'SENT', $3, $4, NULL, $5)
       RETURNING id;`,
      [
        shiftKey,
        winner.id,
        JSON.stringify({
          winner: {
            guardId: Number(winner.id),
            guardCode: winner.code,
            reason: "Passed LegalGuard for meal relief coverage (early call-in from AFTERNOON shift)"
          },
          rejected,
          actions: [
            {
              action: "PROPOSE_EARLY_CALL_IN",
              guardId: Number(winner.id),
              reason: "Meal relief float replacement"
            }
          ],
          suggestions: suggestions || []
        }),
        now,
        `sim_early_call_in_${seedDate}_${shift}`
      ]
    );

    return orderRes.rows[0];
  }
}
