import { Injectable, Inject, Optional, forwardRef } from "@nestjs/common";
import { PoolClient } from "pg";
import { Clock, DispatchPriority, DispatchTask } from "@swms/contracts";
import { CLOCK_TOKEN } from "../../../core/clock/clock.interface.js";
import { DatabaseService } from "../../../core/database/database.service.js";
import { OutboxService } from "../outbox.service.js";
import { AbsenceHandler } from "./handlers/absence.handler.js";
import { MotionHandler } from "./handlers/motion.handler.js";
import { FillVacancyService } from "./fill-vacancy.service.js";
import { MealPlannerService } from "../meal-planner/meal-planner.service.js";
import { DispatchService } from "../dispatch.service.js";

@Injectable()
export class DispatchQueueService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AbsenceHandler) private readonly absenceHandler: AbsenceHandler,
    @Inject(MotionHandler) private readonly motionHandler: MotionHandler,
    @Inject(FillVacancyService) private readonly fillVacancyService: FillVacancyService,
    @Inject(MealPlannerService) private readonly mealPlannerService: MealPlannerService,
    @Inject(OutboxService) private readonly outboxService: OutboxService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Optional() @Inject(forwardRef(() => DispatchService)) private readonly dispatchService?: DispatchService
  ) {}

  /**
   * Helper to derive task priority based on kind, payload, and DB post_rules
   * Rule #2: Tier is read dynamically from post_rules, never hardcoded!
   */
  async derivePriority(
    kind: string,
    payload: Record<string, any>,
    client?: PoolClient
  ): Promise<number> {
    if (kind === "FIRE_ALARM") return DispatchPriority.EMERGENCY; // 0
    if (kind === "CAMERA_MOTION") return DispatchPriority.TIER1_VACANCY; // 1

    if (kind === "ABSENCE_REPORTED" || kind === "FILL_VACANCY") {
      // Check if post or guard tier is Tier 1
      if (payload.tier === "TIER1" || payload.isTier1) {
        return DispatchPriority.TIER1_VACANCY; // 1
      }
      if (payload.isFloat || payload.role === "FLOAT_T1" || payload.role === "FLOAT_GEN" || payload.floatKind) {
        return DispatchPriority.MEAL; // 2
      }
      if (payload.tier === "TIER2" || payload.isTier2) {
        return DispatchPriority.TIER2_VACANCY; // 3
      }
      // If postId given, resolve tier dynamically from DB post_rules
      if (payload.postId) {
        const query = `SELECT tier FROM post_rules WHERE post_id = $1;`;
        const res = client
          ? await client.query(query, [payload.postId])
          : await this.db.query(query, [payload.postId]);

        if (res.rows.length > 0 && res.rows[0].tier === "TIER1") {
          return DispatchPriority.TIER1_VACANCY;
        }
        return DispatchPriority.TIER2_VACANCY;
      }
    }

    if (kind === "REPLAN_MEAL") return DispatchPriority.MEAL; // 2
    return DispatchPriority.OTHER; // 4
  }

  /**
   * Enqueue a batch of dispatch tasks arriving at the same moment (§8.1)
   * All tasks are inserted, then pending tasks are drained and sorted by priority
   */
  async enqueueBatch(
    tasks: Array<{
      siteId?: string;
      shiftKey: string;
      kind: string;
      payload?: Record<string, any>;
      priority?: number;
      idemKey?: string | null;
    }>
  ): Promise<{ taskIds: number[] }> {
    const taskIds: number[] = [];
    const shiftPairs = new Set<string>();

    for (const task of tasks) {
      const siteId = task.siteId || "AEON_THANH_KHE_F1";
      const payload = task.payload || {};
      const priority =
        task.priority !== undefined
          ? task.priority
          : await this.derivePriority(task.kind, payload);
      const now = this.clock.now();

      const insRes = await this.db.query(
        `INSERT INTO dispatch_tasks (site_id, shift_key, priority, kind, payload, status, created_at, idem_key)
         VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7)
         ON CONFLICT (idem_key) DO UPDATE SET status = dispatch_tasks.status
         RETURNING id;`,
        [siteId, task.shiftKey, priority, task.kind, JSON.stringify(payload), now, task.idemKey || null]
      );
      taskIds.push(Number(insRes.rows[0].id));
      shiftPairs.add(`${siteId}###${task.shiftKey}`);
    }

    // Drain and process each shift queue in strict priority order
    for (const pair of shiftPairs) {
      const [siteId, shiftKey] = pair.split("###");
      await this.processShiftQueue(siteId, shiftKey);
    }

    return { taskIds };
  }

  /**
   * Enqueue a new dispatch task into dispatch_tasks table
   */
  async enqueue(task: {
    siteId?: string;
    shiftKey: string;
    kind: string;
    payload?: Record<string, any>;
    priority?: number;
    idemKey?: string | null;
  }): Promise<{ taskId: number; isReplay: boolean }> {
    const siteId = task.siteId || "AEON_THANH_KHE_F1";
    const payload = task.payload || {};
    const priority =
      task.priority !== undefined
        ? task.priority
        : await this.derivePriority(task.kind, payload);
    const now = this.clock.now();

    // Check idempotency first if idemKey provided
    if (task.idemKey) {
      const existing = await this.db.query(
        `SELECT id, status FROM dispatch_tasks WHERE idem_key = $1;`,
        [task.idemKey]
      );
      if (existing.rows.length > 0) {
        return { taskId: Number(existing.rows[0].id), isReplay: true };
      }
    }

    const insRes = await this.db.query(
      `INSERT INTO dispatch_tasks (site_id, shift_key, priority, kind, payload, status, created_at, idem_key)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7)
       ON CONFLICT (idem_key) DO UPDATE SET status = dispatch_tasks.status
       RETURNING id;`,
      [siteId, task.shiftKey, priority, task.kind, JSON.stringify(payload), now, task.idemKey || null]
    );

    const taskId = Number(insRes.rows[0].id);

    // Trigger queue processing for this shift
    await this.processShiftQueue(siteId, task.shiftKey);

    return { taskId, isReplay: false };
  }

  /**
   * Process all pending tasks for a given (siteId, shiftKey) with strict serialization
   * using pg_advisory_xact_lock(hashtextextended('<site>:<shiftKey>', 0)).
   * Drains and sorts pending tasks first so Tier 1 is solved before Tier 2!
   */
  async processShiftQueue(
    siteId: string,
    shiftKey: string,
    maxRetries = 5
  ): Promise<{ processedCount: number; results: any[] }> {
    let attempt = 0;
    const lockKey = `${siteId}:${shiftKey}`;

    while (attempt < maxRetries) {
      attempt++;
      const client: PoolClient = await this.db.getPool().connect();
      try {
        await client.query("BEGIN;");

        // 1. Acquire transaction-level advisory lock for this shift key
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0));`,
          [lockKey]
        );

        // 2. Drain all PENDING tasks for this shift, sorted by priority ASC, id ASC
        const tasksRes = await client.query(
          `SELECT id, site_id, shift_key, priority, kind, payload, idem_key, created_at
           FROM dispatch_tasks
           WHERE site_id = $1 AND shift_key = $2 AND status = 'PENDING'
           ORDER BY priority ASC, id ASC
           FOR UPDATE;`,
          [siteId, shiftKey]
        );

        if (tasksRes.rows.length === 0) {
          await client.query("COMMIT;");
          return { processedCount: 0, results: [] };
        }

        const tasks = tasksRes.rows;
        const results: any[] = [];
        const now = this.clock.now();

        // 3. Process each task in strict priority order
        for (const task of tasks) {
          const taskId = Number(task.id);
          const payload = typeof task.payload === "string" ? JSON.parse(task.payload) : task.payload;

          // Mark task PROCESSING
          await client.query(
            `UPDATE dispatch_tasks SET status = 'PROCESSING' WHERE id = $1;`,
            [taskId]
          );

          let taskResult: any = null;

          if (task.kind === "ABSENCE_REPORTED") {
            taskResult = await this.absenceHandler.handle(client, payload, {
              siteId,
              idemKey: task.idem_key,
              now
            });
          } else if (task.kind === "FILL_VACANCY") {
            taskResult = await this.fillVacancyService.fillVacancy(client, {
              postId: payload.postId,
              shiftKey: task.shift_key,
              siteId,
              now,
              idemKey: task.idem_key
            });
          } else if (task.kind === "CAMERA_MOTION") {
            taskResult = await this.motionHandler.handle(client, payload, {
              siteId,
              idemKey: task.idem_key,
              now
            });
          } else if (task.kind === "REPLAN_MEAL") {
            taskResult = await this.mealPlannerService.replan({
              shiftKey: task.shift_key,
              shiftCode: payload.shiftCode,
              date: payload.date
            });
          } else if (task.kind === "FIRE_ALARM") {
            if (this.dispatchService) {
              taskResult = await this.dispatchService.apply(client, {
                kind: "FIRE_ALARM",
                payload: payload || {},
                siteId,
                simTs: now,
                idemKey: task.idem_key || undefined
              });
            } else {
              await client.query(
                `UPDATE site_state SET mode = 'EMERGENCY', since = $1, version = version + 1 WHERE site_id = $2;`,
                [now, siteId]
              );
              taskResult = { mode: "EMERGENCY" };
            }
          } else {
            taskResult = { status: "IGNORED", kind: task.kind };
          }

          // Mark task COMPLETED
          await client.query(
            `UPDATE dispatch_tasks SET status = 'COMPLETED', processed_at = $1 WHERE id = $2;`,
            [now, taskId]
          );

          results.push({ taskId, kind: task.kind, result: taskResult });
        }

        await client.query("COMMIT;");

        // 4. Publish Outbox strictly post-commit
        await this.outboxService.publishPending();

        return { processedCount: tasks.length, results };
      } catch (err: any) {
        await client.query("ROLLBACK;");

        const isRetryable =
          err?.code === "40001" || // serialization_failure
          err?.code === "40P01" || // deadlock_detected
          err?.code === "23505"; // unique_violation (concurrent insert)

        if (isRetryable && attempt < maxRetries) {
          continue;
        }

        throw err;
      } finally {
        client.release();
      }
    }

    throw new Error(`Failed to process dispatch queue for ${lockKey} after ${maxRetries} attempts`);
  }
}
