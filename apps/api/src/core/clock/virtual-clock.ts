import { Clock } from "./clock.interface.js";

interface VirtualTask {
  id: number;
  at: Date;
  fn: () => Promise<void> | void;
  key?: string;
  cancelled: boolean;
}

export class VirtualClock implements Clock {
  private currentTime: Date;
  private tasks: VirtualTask[] = [];
  private nextTaskId = 0;
  private ticker: NodeJS.Timeout | null = null;

  constructor(initialDate: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.currentTime = new Date(initialDate.getTime());
  }

  now(): Date {
    return new Date(this.currentTime.getTime());
  }

  reset(date: Date, clearTasks = true): void {
    this.currentTime = new Date(date.getTime());
    if (clearTasks) {
      this.tasks = [];
    }
  }

  schedule(at: Date, fn: () => Promise<void> | void, key?: string): () => void {
    if (key) {
      for (const t of this.tasks) {
        if (t.key === key && !t.cancelled) {
          t.cancelled = true;
        }
      }
    }

    const task: VirtualTask = {
      id: ++this.nextTaskId,
      at: new Date(at.getTime()),
      fn,
      key,
      cancelled: false
    };

    this.tasks.push(task);

    return () => {
      task.cancelled = true;
    };
  }

  async jumpTo(to: Date): Promise<void> {
    const targetMs = to.getTime();

    while (true) {
      // Clean up cancelled tasks
      this.tasks = this.tasks.filter((t) => !t.cancelled);

      // Find due tasks
      const dueTasks = this.tasks.filter((t) => t.at.getTime() <= targetMs);
      if (dueTasks.length === 0) {
        break;
      }

      // Sort by execution time asc, then FIFO by id
      dueTasks.sort((a, b) => {
        const diff = a.at.getTime() - b.at.getTime();
        return diff !== 0 ? diff : a.id - b.id;
      });

      const nextTask = dueTasks[0];
      // Remove from pending tasks
      const idx = this.tasks.indexOf(nextTask);
      if (idx !== -1) {
        this.tasks.splice(idx, 1);
      }

      if (!nextTask.cancelled) {
        // Advance clock to this timer's scheduled time
        this.currentTime = new Date(nextTask.at.getTime());
        try {
          await nextTask.fn();
        } catch (err) {
          console.error(`Error in VirtualClock timer ${nextTask.key || nextTask.id}:`, err);
        }
      }
    }

    // Set clock to final target time
    this.currentTime = new Date(targetMs);
  }

  async advance(ms: number): Promise<void> {
    await this.jumpTo(new Date(this.currentTime.getTime() + ms));
  }

  setSpeed(x: number): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }

    if (x > 0) {
      const stepWallMs = 100;
      const stepSimMs = Math.round(stepWallMs * x);
      this.ticker = setInterval(async () => {
        await this.advance(stepSimMs);
      }, stepWallMs);
    }
  }

  destroy(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }
}
