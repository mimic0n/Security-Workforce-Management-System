import { Injectable, Inject, OnModuleDestroy } from "@nestjs/common";
import crypto from "node:crypto";
import { CLOCK_TOKEN, type Clock } from "../clock/clock.interface.js";
import { DatabaseService } from "../database/database.service.js";

export interface ScheduledJob<T = any> {
  id: string;
  name: string;
  data: T;
  runAt: Date;
}

export type JobHandler<T = any> = (job: ScheduledJob<T>) => Promise<void> | void;

@Injectable()
export class ScheduledJobsService implements OnModuleDestroy {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly cancellers = new Map<string, () => void>();
  private pgBossInstance: any = null;

  constructor(
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Inject(DatabaseService) private readonly db: DatabaseService
  ) {}

  registerHandler<T = any>(queue: string, handler: JobHandler<T>): void {
    this.handlers.set(queue, handler);
  }

  async schedule<T = any>(
    queue: string,
    data: T,
    runAt: Date,
    options?: { key?: string; singletonKey?: string }
  ): Promise<string> {
    const jobId = options?.key || `${queue}_${crypto.randomUUID()}`;

    // If a canceller already exists for this key, cancel previous
    if (this.cancellers.has(jobId)) {
      this.cancellers.get(jobId)!();
      this.cancellers.delete(jobId);
    }

    const job: ScheduledJob<T> = {
      id: jobId,
      name: queue,
      data,
      runAt
    };

    // In SIM_MODE or when VirtualClock is active, schedule directly on the Clock
    const cancel = this.clock.schedule(
      runAt,
      async () => {
        this.cancellers.delete(jobId);
        const handler = this.handlers.get(queue);
        if (handler) {
          await handler(job);
        } else {
          console.warn(`No handler registered for scheduled job queue: ${queue}`);
        }
      },
      jobId
    );

    this.cancellers.set(jobId, cancel);
    return jobId;
  }

  async cancel(jobIdOrKey: string): Promise<void> {
    const cancel = this.cancellers.get(jobIdOrKey);
    if (cancel) {
      cancel();
      this.cancellers.delete(jobIdOrKey);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pgBossInstance) {
      try {
        await this.pgBossInstance.stop();
      } catch {
        // ignore
      }
    }
  }
}
