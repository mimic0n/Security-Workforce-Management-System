import { Clock } from "./clock.interface.js";

export class RealClock implements Clock {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  now(): Date {
    return new Date();
  }

  schedule(at: Date, fn: () => Promise<void> | void, key?: string): () => void {
    if (key && this.timers.has(key)) {
      clearTimeout(this.timers.get(key)!);
      this.timers.delete(key);
    }

    const delay = Math.max(0, at.getTime() - Date.now());
    const timeout = setTimeout(async () => {
      if (key) {
        this.timers.delete(key);
      }
      try {
        await fn();
      } catch (err) {
        console.error(`Error executing timer ${key || "anonymous"}:`, err);
      }
    }, delay);

    if (key) {
      this.timers.set(key, timeout);
    }

    return () => {
      clearTimeout(timeout);
      if (key) {
        this.timers.delete(key);
      }
    };
  }
}
