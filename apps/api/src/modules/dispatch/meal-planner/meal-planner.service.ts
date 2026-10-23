import { Injectable, Inject, Optional, OnModuleInit, forwardRef } from "@nestjs/common";
import {
  Clock,
  MealPlannerPost,
  MealPlannerFloat,
  MealReliefPlanResult,
  MealReliefSlot
} from "@swms/contracts";
import { CLOCK_TOKEN } from "../../../core/clock/clock.interface.js";
import { DatabaseService } from "../../../core/database/database.service.js";
import { ScheduledJobsService } from "../../../core/jobs/scheduled-jobs.service.js";
import { ConfigService } from "../../policies/config.service.js";
import { DispatchService } from "../dispatch.service.js";
import { planMealRelief, GOLDEN_TIER1_ORDER, DEFAULT_SUGGESTIONS } from "./plan.js";

export const MEAL_WINDOW_OPEN_QUEUE = "meal-window-open";

@Injectable()
export class MealPlannerService implements OnModuleInit {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Inject(ScheduledJobsService) private readonly scheduledJobs: ScheduledJobsService,
    @Optional() @Inject(ConfigService) private readonly configService?: ConfigService,
    @Optional() @Inject(forwardRef(() => DispatchService)) private readonly dispatchService?: DispatchService
  ) {}

  onModuleInit(): void {
    // Register the job handler for scheduled meal window open events
    this.scheduledJobs.registerHandler(MEAL_WINDOW_OPEN_QUEUE, async (job) => {
      await this.handleMealWindowOpenJob(job.data);
    });
  }

  /**
   * Handler executed when a slot's MEAL_WINDOW_OPEN job fires
   */
  async handleMealWindowOpenJob(data: {
    shiftKey: string;
    breakPlanId: number;
    postId: string;
    floatGuardId?: number | null;
    originalGuardId?: number | null;
  }): Promise<void> {
    if (!this.dispatchService) return;

    try {
      await this.dispatchService.applyWithRetry({
        siteId: "AEON_THANH_KHE_F1",
        kind: "MEAL_WINDOW_OPEN",
        postId: data.postId,
        payload: {
          shiftKey: data.shiftKey,
          breakPlanId: data.breakPlanId,
          floatId: data.floatGuardId,
          breakPlanExists: true
        }
      });
    } catch (err) {
      console.error(`Failed to apply MEAL_WINDOW_OPEN transition for ${data.postId}:`, err);
    }
  }

  /**
   * Query break plans for a shift key
   */
  async getBreakPlans(shiftKey: string): Promise<any[]> {
    const res = await this.db.query(
      `SELECT id, shift_key, post_id, original_guard_id, float_guard_id, 
              lower(slot) as start, upper(slot) as end, status 
       FROM break_plans 
       WHERE shift_key = $1 
       ORDER BY lower(slot) ASC;`,
      [shiftKey]
    );

    return res.rows.map((r: any) => ({
      id: Number(r.id),
      shiftKey: r.shift_key,
      postId: r.post_id,
      originalGuardId: r.original_guard_id ? Number(r.original_guard_id) : null,
      floatGuardId: r.float_guard_id ? Number(r.float_guard_id) : null,
      start: new Date(r.start),
      end: new Date(r.end),
      status: r.status
    }));
  }

  /**
   * Build a travel matrix function based on post_travel DB table
   */
  async buildTravelMatrix(): Promise<(a: string, b: string) => number> {
    const res = await this.db.query(`SELECT from_post, to_post, minutes FROM post_travel;`);
    const matrix = new Map<string, number>();
    for (const row of res.rows) {
      matrix.set(`${row.from_post}->${row.to_post}`, Number(row.minutes));
    }

    return (a: string, b: string) => {
      if (a === b) return 0;
      return matrix.get(`${a}->${b}`) ?? 10;
    };
  }

  /**
   * Generate and persist a meal relief plan for a shift
   */
  async generateAndPersistPlan(params: {
    shiftKey: string;
    shiftCode?: "MORNING" | "AFTERNOON" | "NIGHT";
    date?: string;
    availableFloatIds?: number[];
    order?: string[];
  }): Promise<MealReliefPlanResult> {
    const shiftCode = params.shiftCode || "MORNING";
    const dateStr = params.date || params.shiftKey.split(":")[0];

    // Read policies from ConfigService
    let windowConfig = {
      MORNING: ["10:00", "12:45"],
      AFTERNOON: ["16:00", "18:45"]
    };
    let handoverBufferMin = 5;

    if (this.configService) {
      try {
        const windowPolicy = await this.configService.get<any>("meal.window");
        if (windowPolicy) windowConfig = windowPolicy;
      } catch {}

      try {
        const bufferPolicy = await this.configService.get<number>("meal.handover_buffer_min");
        if (typeof bufferPolicy === "number") handoverBufferMin = bufferPolicy;
      } catch {}
    }

    const shiftTimes = (windowConfig as any)[shiftCode] || ["10:00", "12:45"];
    const windowStart = new Date(`${dateStr}T${shiftTimes[0]}:00+07:00`);
    const windowEnd = new Date(`${dateStr}T${shiftTimes[1]}:00+07:00`);

    // Fetch Tier 1 posts that require relief
    const postsRes = await this.db.query(
      `SELECT p.id, pr.tier 
       FROM posts p 
       JOIN post_rules pr ON pr.post_id = p.id 
       WHERE pr.tier = 'TIER1' AND $1 = ANY(pr.active_shifts) 
       ORDER BY p.id ASC;`,
      [shiftCode]
    );

    const posts: MealPlannerPost[] = postsRes.rows.map((r: any) => ({
      id: r.id,
      tier: r.tier
    }));

    // Fetch available floats
    let floatsRes;
    if (params.availableFloatIds && params.availableFloatIds.length > 0) {
      floatsRes = await this.db.query(
        `SELECT id, code, role, float_kind FROM guards WHERE id = ANY($1) ORDER BY id ASC;`,
        [params.availableFloatIds]
      );
    } else {
      // Check if assignments exist for this shift
      const checkAssign = await this.db.query(
        `SELECT count(*) as cnt FROM assignments WHERE shift = $1;`,
        [shiftCode]
      );
      const hasAssignments = Number(checkAssign.rows[0]?.cnt || 0) > 0;

      if (hasAssignments) {
        // Query active FLOAT_T1 guards on duty who are not absent and not currently occupying a fixed post
        floatsRes = await this.db.query(
          `SELECT g.id, g.code, g.role, g.float_kind 
           FROM guards g
           JOIN assignments a ON a.guard_id = g.id
           WHERE g.active = true 
             AND a.status = 'ACTIVE'
             AND a.role = 'FLOAT_T1'
             AND a.shift = $1
             AND NOT EXISTS (
               SELECT 1 FROM absences ab
               WHERE ab.guard_id = g.id
                 AND ab.for_shift = $1
                 AND ab.for_date = $2::date
             )
             AND NOT EXISTS (
               SELECT 1 FROM post_state ps
               WHERE ps.guard_id = g.id
             )
           ORDER BY g.id ASC;`,
          [shiftCode, dateStr]
        );
      } else {
        // Fallback for isolated unit tests without assignments
        let floatCount = 2;
        if (this.configService) {
          try {
            const hcPolicy = await this.configService.get<any>("headcount.float_t1");
            if (hcPolicy && typeof hcPolicy[shiftCode] === "number") {
              floatCount = hcPolicy[shiftCode];
            }
          } catch {}
        }
        floatsRes = await this.db.query(
          `SELECT id, code, role, float_kind 
           FROM guards 
           WHERE active = true AND role = 'FLOAT' AND float_kind = 'TIER1_RELIEF'
           ORDER BY id ASC LIMIT $1;`,
          [floatCount]
        );
      }
    }

    // Read shift start, end, and break minutes from shift_templates
    const shiftRes = await this.db.query(
      `SELECT start_time, end_time, break_minutes FROM shift_templates WHERE code = $1;`,
      [shiftCode]
    );
    let shiftStartStr = "06:00:00";
    let shiftEndStr = "14:00:00";
    let breakMinutes = 30;
    if (shiftRes.rows.length > 0) {
      shiftStartStr = shiftRes.rows[0].start_time;
      shiftEndStr = shiftRes.rows[0].end_time;
      breakMinutes = Number(shiftRes.rows[0].break_minutes) || 30;
    }

    const shiftDayStart = new Date(`${dateStr}T${shiftStartStr}+07:00`);
    const shiftDayEnd = new Date(`${dateStr}T${shiftEndStr}+07:00`);

    const floats: MealPlannerFloat[] = floatsRes.rows.map((r: any) => ({
      id: String(r.id),
      available: {
        from: shiftDayStart,
        to: shiftDayEnd
      }
    }));

    const travel = await this.buildTravelMatrix();

    // Call pure planner
    const result = planMealRelief({
      posts,
      floats,
      window: { start: windowStart, end: windowEnd },
      breakMinutes,
      handoverBufferMin,
      travel,
      baseLocation: "BASE",
      order: params.order || GOLDEN_TIER1_ORDER
    });

    if (result.feasible) {
      // Persist in break_plans table
      const client = await this.db.getClient();
      try {
        await client.query("BEGIN;");
        // Clear previous planned slots for this shiftKey
        await client.query(
          `DELETE FROM break_plans WHERE shift_key = $1 AND status = 'PLANNED';`,
          [params.shiftKey]
        );

        for (const slot of result.plan) {
          const floatGuardId = Number(slot.floatId);
          const startIso = slot.start.toISOString();
          const endIso = slot.end.toISOString();

          // Check if there is an original guard on that post
          const guardPostRes = await client.query(
            `SELECT guard_id FROM post_state WHERE post_id = $1;`,
            [slot.postId]
          );
          const originalGuardId =
            guardPostRes.rows.length > 0 && guardPostRes.rows[0].guard_id
              ? Number(guardPostRes.rows[0].guard_id)
              : null;

          await client.query(
            `INSERT INTO break_plans (shift_key, post_id, original_guard_id, float_guard_id, slot, status)
             VALUES ($1, $2, $3, $4, tstzrange($5, $6, '[)'), 'PLANNED');`,
            [params.shiftKey, slot.postId, originalGuardId, floatGuardId, startIso, endIso]
          );
        }

        await client.query("COMMIT;");
      } catch (err) {
        await client.query("ROLLBACK;");
        throw err;
      } finally {
        client.release();
      }
    }

    return result;
  }

  /**
   * Schedule slot jobs using ScheduledJobsService
   */
  async scheduleSlotJobs(shiftKey: string): Promise<void> {
    const plans = await this.getBreakPlans(shiftKey);
    let handoverBufferMin = 5;
    if (this.configService) {
      try {
        const buffer = await this.configService.get<number>("meal.handover_buffer_min");
        if (typeof buffer === "number") handoverBufferMin = buffer;
      } catch {}
    }

    for (const plan of plans) {
      if (plan.status !== "PLANNED") continue;

      const runAt = new Date(plan.start.getTime() - handoverBufferMin * 60 * 1000);
      const jobKey = `meal_window_open_${shiftKey}_${plan.id}`;

      await this.scheduledJobs.schedule(
        MEAL_WINDOW_OPEN_QUEUE,
        {
          shiftKey,
          breakPlanId: plan.id,
          postId: plan.postId,
          floatGuardId: plan.floatGuardId,
          originalGuardId: plan.originalGuardId
        },
        runAt,
        { key: jobKey }
      );
    }
  }

  /**
   * Re-plan when floats change (e.g. sick leave)
   */
  async replan(params: {
    shiftKey: string;
    shiftCode?: "MORNING" | "AFTERNOON" | "NIGHT";
    date?: string;
    availableFloatIds?: number[];
  }): Promise<MealReliefPlanResult> {
    const result = await this.generateAndPersistPlan(params);
    if (!result.feasible) {
      // If infeasible, record staffing request
      await this.db.query(
        `INSERT INTO staffing_requests (created_at, shift, qty, reason, status)
         VALUES ($1, $2, $3, $4, 'OPEN');`,
        [
          this.clock.now(),
          params.shiftCode || "MORNING",
          1,
          `Infeasible meal relief plan: ${result.violations.map((v) => `${v.postId}:${v.reason}`).join(", ")}`
        ]
      );
    }
    return result;
  }
}
