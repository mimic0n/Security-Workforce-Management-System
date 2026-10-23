import { Injectable, Inject, Optional } from "@nestjs/common";
import {
  Clock,
  CandidateAssignment,
  CostEstimateResult,
  LegalGuardResult
} from "@swms/contracts";
import { CLOCK_TOKEN } from "../../../core/clock/clock.interface.js";
import { DatabaseService } from "../../../core/database/database.service.js";
import { ConfigService } from "../../policies/config.service.js";
import {
  validateLegalAssignment,
  estimateAssignmentCost,
  AssignmentInterval,
  CertificationRecord,
  LegalGuardPolicies
} from "./rules.js";

@Injectable()
export class LegalGuardService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Optional() @Inject(ConfigService) private readonly configService?: ConfigService
  ) {}

  /**
   * Database-backed validation of a candidate guard assignment
   */
  async validate(candidate: CandidateAssignment): Promise<LegalGuardResult> {
    const guardRes = await this.db.query(
      `SELECT id, code, active, ot_minutes_month, ot_minutes_year 
       FROM guards 
       WHERE id = $1;`,
      [candidate.guardId]
    );

    if (guardRes.rows.length === 0) {
      return {
        ok: false,
        violations: ["GUARD_NOT_FOUND"],
        details: { guardId: candidate.guardId }
      };
    }

    const guard = guardRes.rows[0];
    if (!guard.active) {
      return {
        ok: false,
        violations: ["GUARD_INACTIVE"],
        details: { guardId: candidate.guardId }
      };
    }

    // 1. Fetch certifications
    const certsRes = await this.db.query(
      `SELECT id, cert_no, issued_on::text, expires_on::text 
       FROM certifications 
       WHERE guard_id = $1;`,
      [candidate.guardId]
    );
    const certifications: CertificationRecord[] = certsRes.rows.map((r: any) => ({
      id: Number(r.id),
      cert_no: r.cert_no,
      issued_on: r.issued_on,
      expires_on: r.expires_on
    }));

    // 2. Fetch all active assignments for this guard
    const assignRes = await this.db.query(
      `SELECT lower(period) as start, upper(period) as end 
       FROM assignments 
       WHERE guard_id = $1 AND status = 'ACTIVE' 
       ORDER BY lower(period) ASC;`,
      [candidate.guardId]
    );

    const existingAssignments: AssignmentInterval[] = assignRes.rows.map((r: any) => ({
      startTime: new Date(r.start),
      endTime: new Date(r.end)
    }));

    // Find previous and next assignments relative to candidate window
    let previousAssignment: AssignmentInterval | null = null;
    let nextAssignment: AssignmentInterval | null = null;

    const candStartMs = candidate.startTime.getTime();
    const candEndMs = candidate.endTime.getTime();

    for (const a of existingAssignments) {
      if (a.endTime.getTime() <= candStartMs) {
        if (!previousAssignment || a.endTime.getTime() > previousAssignment.endTime.getTime()) {
          previousAssignment = a;
        }
      }
      if (a.startTime.getTime() >= candEndMs) {
        if (!nextAssignment || a.startTime.getTime() < nextAssignment.startTime.getTime()) {
          nextAssignment = a;
        }
      }
    }

    // Extract all distinct working dates from existing assignments
    const existingDatesInWeek = existingAssignments.map((a) =>
      a.startTime.toISOString().slice(0, 10)
    );

    // 3. Resolve active policies from ConfigService
    const policies: LegalGuardPolicies = {
      minRestHours: 12,
      maxWorkDaysWeek: 6,
      otCapMonthMin: 2400,
      otCapYearMin: 12000
    };

    if (this.configService) {
      const rest = await this.configService.get<number>("legal.min_rest_hours");
      if (typeof rest === "number") policies.minRestHours = rest;

      const days = await this.configService.get<number>("legal.max_work_days_week");
      if (typeof days === "number") policies.maxWorkDaysWeek = days;

      const otMonth = await this.configService.get<number>("legal.ot_cap_month_min");
      if (typeof otMonth === "number") policies.otCapMonthMin = otMonth;

      const otYear = await this.configService.get<number>("legal.ot_cap_year_min");
      if (typeof otYear === "number") policies.otCapYearMin = otYear;
    }

    // 4. Validate through pure rules engine
    const result = validateLegalAssignment(candidate, {
      previousAssignment,
      nextAssignment,
      existingAssignments,
      existingDatesInWeek,
      certifications,
      currentOtMonthMin: Number(guard.ot_minutes_month || 0),
      currentOtYearMin: Number(guard.ot_minutes_year || 0),
      policies
    });

    return {
      ok: result.ok,
      violations: result.violations,
      details: {
        guardId: candidate.guardId,
        guardCode: guard.code,
        currentOtMonthMin: Number(guard.ot_minutes_month || 0),
        currentOtYearMin: Number(guard.ot_minutes_year || 0)
      }
    };
  }

  /**
   * Cost estimation helper
   */
  async estimateCost(params: {
    startTime: Date;
    endTime: Date;
    isOvertime?: boolean;
    baseHourlyRate?: number;
  }): Promise<CostEstimateResult> {
    return estimateAssignmentCost(
      params.startTime,
      params.endTime,
      params.isOvertime ?? false,
      params.baseHourlyRate ?? 100
    );
  }
}
