import { Injectable, Inject, OnModuleInit } from "@nestjs/common";
import { DatabaseService } from "../../core/database/database.service.js";
import { CLOCK_TOKEN, type Clock } from "../../core/clock/clock.interface.js";
import { EventBusService } from "../../core/events/event-bus.service.js";
import type { StaffingResult, ShiftCode } from "@swms/contracts";

interface CachedPolicyRow {
  value: any;
  valid_from: Date;
  valid_to: Date | null;
}

@Injectable()
export class ConfigService implements OnModuleInit {
  private readonly cache = new Map<string, CachedPolicyRow[]>();

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Inject(EventBusService) private readonly eventBus: EventBusService
  ) {}

  onModuleInit(): void {
    // Invalidate cache on policy.changed
    this.eventBus.on("policy.changed", (payload: { key: string }) => {
      if (payload?.key) {
        this.invalidate(payload.key);
      } else {
        this.invalidate();
      }
    });
  }

  invalidate(key?: string): void {
    if (key) {
      this.cache.delete(key);
    } else {
      this.cache.clear();
    }
  }

  async get<T = any>(key: string, at?: Date): Promise<T> {
    const timestamp = at ? new Date(at.getTime()) : this.clock.now();
    const rows = await this.getPolicyVersions(key);

    const match = rows.find((row) => {
      const fromOk = row.valid_from.getTime() <= timestamp.getTime();
      const toOk = row.valid_to === null || row.valid_to.getTime() > timestamp.getTime();
      return fromOk && toOk;
    });

    if (!match) {
      throw new Error(`Policy not found or not active at ${timestamp.toISOString()} for key: ${key}`);
    }

    return match.value as T;
  }

  async getAll(at?: Date): Promise<Record<string, any>> {
    const timestamp = at ? new Date(at.getTime()) : this.clock.now();

    const res = await this.db.query<{ key: string; value: any; valid_from: Date; valid_to: Date | null }>(
      `SELECT DISTINCT ON (key) key, value, valid_from, valid_to
       FROM policies
       WHERE valid_from <= $1
         AND (valid_to IS NULL OR valid_to > $1)
       ORDER BY key, valid_from DESC;`,
      [timestamp.toISOString()]
    );

    const result: Record<string, any> = {};
    for (const r of res.rows) {
      result[r.key] = r.value;
    }
    return result;
  }

  private async getPolicyVersions(key: string): Promise<CachedPolicyRow[]> {
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    const res = await this.db.query<{ value: any; valid_from: string; valid_to: string | null }>(
      `SELECT value, valid_from, valid_to
       FROM policies
       WHERE key = $1
       ORDER BY valid_from DESC;`,
      [key]
    );

    const rows: CachedPolicyRow[] = res.rows.map((r) => ({
      value: r.value,
      valid_from: new Date(r.valid_from),
      valid_to: r.valid_to ? new Date(r.valid_to) : null
    }));

    this.cache.set(key, rows);
    return rows;
  }

  async calculateStaffing(overrides?: Record<string, any>, at?: Date): Promise<StaffingResult> {
    const timestamp = at ? new Date(at.getTime()) : this.clock.now();

    const fixed = overrides?.["headcount.fixed"] ?? (await this.get("headcount.fixed", timestamp));
    const floatT1 = overrides?.["headcount.float_t1"] ?? (await this.get("headcount.float_t1", timestamp));
    const floatGen = overrides?.["headcount.float_gen"] ?? (await this.get("headcount.float_gen", timestamp));
    const sup = overrides?.["headcount.sup"] ?? (await this.get("headcount.sup", timestamp));

    const shifts: ShiftCode[] = ["MORNING", "AFTERNOON", "NIGHT"];
    const perShift: any = {};
    let slotsPerDay = 0;

    for (const s of shifts) {
      const fixedCount = Number(fixed[s] || 0);
      const floatT1Count = Number(floatT1[s] || 0);
      const floatGenCount = Number(floatGen[s] || 0);
      const supCount = Number(sup[s] || 0);
      const total = fixedCount + floatT1Count + floatGenCount + supCount;

      perShift[s] = {
        fixed: fixedCount,
        floatT1: floatT1Count,
        floatGen: floatGenCount,
        sup: supCount,
        total
      };

      slotsPerDay += total;
    }

    const kOverride =
      overrides?.["relief.k_override"] !== undefined
        ? overrides["relief.k_override"]
        : await this.get("relief.k_override", timestamp);

    const kWeeklyRest =
      overrides?.["relief.k_weekly_rest"] ??
      (await this.get("relief.k_weekly_rest", timestamp));

    const leaveSickRatio =
      overrides?.["relief.leave_sick_ratio"] ??
      (await this.get("relief.leave_sick_ratio", timestamp));

    let k: number;
    if (kOverride !== null && kOverride !== undefined) {
      k = Number(kOverride);
    } else {
      k = Number((Number(kWeeklyRest) * (1 + Number(leaveSickRatio))).toFixed(4));
    }

    const required = Math.ceil(slotsPerDay * k);

    let present = 45;
    if (overrides?.present !== undefined) {
      present = Number(overrides.present);
    } else {
      const guardRes = await this.db.query<{ count: string }>(
        `SELECT COUNT(*)::int as count FROM guards WHERE active = true;`
      );
      present = parseInt(guardRes.rows[0]?.count ?? "0", 10);
    }

    const gap = Math.max(0, required - present);
    const gapPct = required > 0 ? Math.round(((gap / required) * 100) * 100) / 100 : 0;

    const kRange =
      overrides?.["relief.k_sensitivity_range"] ??
      (await this.get("relief.k_sensitivity_range", timestamp));

    const sensitivity: { k: number; required: number; gap: number }[] = [];
    if (Array.isArray(kRange) && kRange.length === 2) {
      const minK = Math.round(Number(kRange[0]) * 100);
      const maxK = Math.round(Number(kRange[1]) * 100);
      for (let cur = minK; cur <= maxK; cur += 5) {
        const sensK = cur / 100;
        const sensReq = Math.ceil(slotsPerDay * sensK);
        sensitivity.push({
          k: sensK,
          required: sensReq,
          gap: Math.max(0, sensReq - present)
        });
      }
    }

    return {
      perShift,
      slotsPerDay,
      k,
      required,
      present,
      gap,
      gapPct,
      sensitivity
    };
  }
}
