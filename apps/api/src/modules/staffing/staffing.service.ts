import { Injectable, Inject } from "@nestjs/common";
import { DatabaseService } from "../../core/database/database.service.js";
import { ConfigService } from "../policies/config.service.js";
import { CLOCK_TOKEN, type Clock } from "../../core/clock/clock.interface.js";
import {
  type StaffingResult,
  type StaffingSimulateDto,
  type ShiftCode,
  type StaffingRequest,
  type CreateStaffingRequestDto,
  type StaffingRequestFilterDto,
  type AnnualDaysParams,
  computeKFromAnnualDays
} from "@swms/contracts";

@Injectable()
export class StaffingService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock
  ) {}

  /**
   * Calculates staffing requirement based on time-versioned policies or simulation overrides.
   */
  async calculate(overrides?: StaffingSimulateDto, at?: Date): Promise<StaffingResult> {
    const timestamp = overrides?.at
      ? new Date(overrides.at)
      : at
        ? new Date(at.getTime())
        : this.clock.now();

    // Fetch base policies from ConfigService
    const baseFixed = await this.configService.get<Record<ShiftCode, number>>("headcount.fixed", timestamp);
    const baseFloatT1 = await this.configService.get<Record<ShiftCode, number>>("headcount.float_t1", timestamp);
    const baseFloatGen = await this.configService.get<Record<ShiftCode, number>>("headcount.float_gen", timestamp);
    const baseSup = await this.configService.get<Record<ShiftCode, number>>("headcount.sup", timestamp);

    // Merge overrides if provided (supporting shorthand and exact keys)
    const fixedOverrides = overrides?.["headcount.fixed"] ?? overrides?.fixed;
    const floatT1Overrides = overrides?.["headcount.float_t1"] ?? overrides?.floatT1 ?? overrides?.float_t1;
    const floatGenOverrides = overrides?.["headcount.float_gen"] ?? overrides?.floatGen ?? overrides?.float_gen;
    const supOverrides = overrides?.["headcount.sup"] ?? overrides?.sup;

    const fixed = { ...baseFixed, ...(fixedOverrides || {}) };
    const floatT1 = { ...baseFloatT1, ...(floatT1Overrides || {}) };
    const floatGen = { ...baseFloatGen, ...(floatGenOverrides || {}) };
    const sup = { ...baseSup, ...(supOverrides || {}) };

    const shifts: ShiftCode[] = ["MORNING", "AFTERNOON", "NIGHT"];
    const perShift: Record<ShiftCode, { fixed: number; floatT1: number; floatGen: number; sup: number; total: number }> = {
      MORNING: { fixed: 0, floatT1: 0, floatGen: 0, sup: 0, total: 0 },
      AFTERNOON: { fixed: 0, floatT1: 0, floatGen: 0, sup: 0, total: 0 },
      NIGHT: { fixed: 0, floatT1: 0, floatGen: 0, sup: 0, total: 0 }
    };

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

    // Relief factor K resolution
    let kOverride: number | null | undefined;
    if (overrides && "relief.k_override" in overrides) {
      kOverride = overrides["relief.k_override"];
    } else if (overrides && "k_override" in overrides) {
      kOverride = overrides.k_override;
    } else if (overrides && "kOverride" in overrides) {
      kOverride = overrides.kOverride;
    } else {
      kOverride = await this.configService.get("relief.k_override", timestamp);
    }

    const kWeeklyRest =
      overrides?.["relief.k_weekly_rest"] ??
      overrides?.k_weekly_rest ??
      overrides?.kWeeklyRest ??
      (await this.configService.get("relief.k_weekly_rest", timestamp));

    const leaveSickRatio =
      overrides?.["relief.leave_sick_ratio"] ??
      overrides?.leave_sick_ratio ??
      overrides?.leaveSickRatio ??
      (await this.configService.get("relief.leave_sick_ratio", timestamp));

    let k: number;
    if (kOverride !== null && kOverride !== undefined) {
      k = Number(kOverride);
    } else {
      k = Number((Number(kWeeklyRest) * (1 + Number(leaveSickRatio))).toFixed(4));
    }

    const required = Math.ceil(slotsPerDay * k);

    let present: number;
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

    // Sensitivity analysis over K range
    const kRange =
      overrides?.["relief.k_sensitivity_range"] ??
      overrides?.k_sensitivity_range ??
      overrides?.kSensitivityRange ??
      (await this.configService.get("relief.k_sensitivity_range", timestamp));

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

  /**
   * Helper to derive K factor from annual working days standard.
   */
  computeKFromAnnualDays(params: AnnualDaysParams): number {
    return computeKFromAnnualDays(params);
  }

  /**
   * Lists staffing requests with optional filtering by status and shift.
   */
  async getStaffingRequests(filter?: StaffingRequestFilterDto): Promise<StaffingRequest[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (filter?.status) {
      conditions.push(`status = $${idx++}`);
      values.push(filter.status);
    }

    if (filter?.shift) {
      conditions.push(`shift = $${idx++}`);
      values.push(filter.shift);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const res = await this.db.query<{
      id: string;
      created_at: Date;
      shift: ShiftCode | null;
      qty: number;
      reason: string;
      status: string;
    }>(
      `SELECT id, created_at, shift, qty, reason, status
       FROM staffing_requests
       ${whereClause}
       ORDER BY created_at DESC, id DESC;`,
      values
    );

    return res.rows.map((r) => ({
      id: Number(r.id),
      created_at: new Date(r.created_at).toISOString(),
      shift: r.shift,
      qty: Number(r.qty),
      reason: r.reason,
      status: r.status
    }));
  }

  /**
   * Creates a new staffing request.
   */
  async createStaffingRequest(dto: CreateStaffingRequestDto): Promise<StaffingRequest> {
    const now = this.clock.now();

    const res = await this.db.query<{
      id: string;
      created_at: Date;
      shift: ShiftCode | null;
      qty: number;
      reason: string;
      status: string;
    }>(
      `INSERT INTO staffing_requests (created_at, shift, qty, reason, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at, shift, qty, reason, status;`,
      [
        now.toISOString(),
        dto.shift ?? null,
        dto.qty,
        dto.reason,
        dto.status ?? "OPEN"
      ]
    );

    const row = res.rows[0];
    return {
      id: Number(row.id),
      created_at: new Date(row.created_at).toISOString(),
      shift: row.shift,
      qty: Number(row.qty),
      reason: row.reason,
      status: row.status
    };
  }
}
