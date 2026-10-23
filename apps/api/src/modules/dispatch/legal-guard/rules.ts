import {
  CandidateAssignment,
  CostEstimateResult,
  LegalGuardResult,
  LegalViolationCode
} from "@swms/contracts";

export interface AssignmentInterval {
  startTime: Date;
  endTime: Date;
}

export interface CertificationRecord {
  id: number;
  cert_no: string;
  issued_on: string;
  expires_on: string;
}

export interface LegalGuardPolicies {
  minRestHours?: number;
  maxWorkDaysWeek?: number;
  otCapMonthMin?: number;
  otCapYearMin?: number;
  nightStart?: string; // "22:00"
  nightEnd?: string; // "06:00"
}

export interface LegalValidationContext {
  previousAssignment?: AssignmentInterval | null;
  nextAssignment?: AssignmentInterval | null;
  existingAssignments?: AssignmentInterval[];
  existingDatesInWeek?: string[];
  certifications?: CertificationRecord[];
  currentOtMonthMin?: number;
  currentOtYearMin?: number;
  policies?: LegalGuardPolicies;
}

/**
 * Get ISO 8601 week string "YYYY-Www" for a Date
 */
export function getIsoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * 1. Min Rest Check (§9 rule 1, Labor Code 2019 Art. 110: >= 12h)
 */
export function checkMinRest(
  candidate: AssignmentInterval,
  prevAssignment: AssignmentInterval | null | undefined,
  nextAssignment: AssignmentInterval | null | undefined,
  minRestHours = 12
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const minRestMs = minRestHours * 3600 * 1000;

  if (prevAssignment) {
    const restMs = candidate.startTime.getTime() - prevAssignment.endTime.getTime();
    if (restMs < minRestMs) {
      violations.push("MIN_REST_HOURS_VIOLATED");
    }
  }

  if (nextAssignment) {
    const restMs = nextAssignment.startTime.getTime() - candidate.endTime.getTime();
    if (restMs < minRestMs) {
      violations.push("MIN_REST_HOURS_VIOLATED");
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * 2. Weekly Working Days Check (§9 rule 2: <= 6 days/week)
 */
export function checkMaxWorkDays(
  candidateDate: Date,
  existingDates: string[],
  maxDaysWeek = 6
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const candidateIsoWeek = getIsoWeekKey(candidateDate);
  const candidateDateStr = candidateDate.toISOString().slice(0, 10);

  // Filter existing dates to those in the same ISO week
  const sameWeekDates = new Set<string>();
  for (const dateStr of existingDates) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    if (getIsoWeekKey(d) === candidateIsoWeek) {
      sameWeekDates.add(dateStr);
    }
  }

  sameWeekDates.add(candidateDateStr);

  if (sameWeekDates.size > maxDaysWeek) {
    violations.push("MAX_WORK_DAYS_WEEK_EXCEEDED");
  }

  return { ok: violations.length === 0, violations };
}

/**
 * 3. Overtime Caps Check (§9 rule 3: Month cap 2400 min / Year cap 12000 min)
 */
export function checkOtCaps(
  currentMonthOtMin: number,
  currentYearOtMin: number,
  additionalOtMin: number,
  monthCapMin = 2400,
  yearCapMin = 12000
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];

  const projectedMonth = currentMonthOtMin + additionalOtMin;
  const projectedYear = currentYearOtMin + additionalOtMin;

  if (projectedMonth > monthCapMin) {
    violations.push("MONTHLY_OT_CAP_EXCEEDED");
  }

  if (projectedYear > yearCapMin) {
    violations.push("YEARLY_OT_CAP_EXCEEDED");
  }

  return { ok: violations.length === 0, violations };
}

/**
 * 4. Certification Check (§9 rule 4: valid cert on assignment date)
 */
export function checkCertificates(
  certifications: CertificationRecord[],
  assignmentDate: Date
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const dateStr = assignmentDate.toISOString().slice(0, 10);

  const hasValidCert = certifications.some((c) => {
    const expiresOn = c.expires_on.slice(0, 10);
    return expiresOn >= dateStr;
  });

  if (!hasValidCert) {
    violations.push("CERTIFICATE_EXPIRED");
  }

  return { ok: violations.length === 0, violations };
}

/**
 * 5. Double Booking Check (§9 rule 5: no overlapping active assignment)
 */
export function checkDoubleBooking(
  candidate: AssignmentInterval,
  existingAssignments: AssignmentInterval[]
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const candStart = candidate.startTime.getTime();
  const candEnd = candidate.endTime.getTime();

  for (const existing of existingAssignments) {
    const exStart = existing.startTime.getTime();
    const exEnd = existing.endTime.getTime();

    // Overlap condition
    if (candStart < exEnd && candEnd > exStart) {
      violations.push("DOUBLE_BOOKING");
      break;
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * 6. Cost Estimation Helper (§9 rule 6: Night x1.3, Day OT x1.5, Night OT x2.0)
 */
export function estimateAssignmentCost(
  startTime: Date,
  endTime: Date,
  isOvertime = false,
  baseHourlyRate = 100,
  customMultipliers?: {
    regularDay?: number;
    regularNight?: number;
    otDay?: number;
    otNight?: number;
  }
): CostEstimateResult {
  const mult = {
    regularDay: customMultipliers?.regularDay ?? 1.0,
    regularNight: customMultipliers?.regularNight ?? 1.3,
    otDay: customMultipliers?.otDay ?? 1.5,
    otNight: customMultipliers?.otNight ?? 2.0
  };

  let regularDayHours = 0;
  let regularNightHours = 0;
  let otDayHours = 0;
  let otNightHours = 0;

  // Step hour by hour through the assignment
  let cursor = startTime.getTime();
  const end = endTime.getTime();
  const stepMs = 3600 * 1000; // 1 hour steps

  while (cursor < end) {
    const nextCursor = Math.min(cursor + stepMs, end);
    const durationHours = (nextCursor - cursor) / stepMs;
    const midPoint = new Date(cursor + (nextCursor - cursor) / 2);

    // Night hours: 22:00 to 06:00 local time
    const hour = midPoint.getHours();
    const isNight = hour >= 22 || hour < 6;

    if (isOvertime) {
      if (isNight) {
        otNightHours += durationHours;
      } else {
        otDayHours += durationHours;
      }
    } else {
      if (isNight) {
        regularNightHours += durationHours;
      } else {
        regularDayHours += durationHours;
      }
    }

    cursor = nextCursor;
  }

  const totalCost =
    (regularDayHours * mult.regularDay +
      regularNightHours * mult.regularNight +
      otDayHours * mult.otDay +
      otNightHours * mult.otNight) *
    baseHourlyRate;

  const totalHours = (end - startTime.getTime()) / stepMs;
  const effectiveMultiplier = totalHours > 0 ? totalCost / (totalHours * baseHourlyRate) : 1.0;

  return {
    totalCost,
    regularDayHours,
    regularNightHours,
    otDayHours,
    otNightHours,
    effectiveMultiplier
  };
}

/**
 * Master validation combining all LegalGuard rules
 */
export function validateLegalAssignment(
  candidate: CandidateAssignment,
  context: LegalValidationContext
): LegalGuardResult {
  const violations: string[] = [];
  const policies = context.policies || {};

  // 1. Min rest
  const minRestResult = checkMinRest(
    candidate,
    context.previousAssignment,
    context.nextAssignment,
    policies.minRestHours ?? 12
  );
  violations.push(...minRestResult.violations);

  // 2. Max work days in ISO week
  if (context.existingDatesInWeek) {
    const maxDaysResult = checkMaxWorkDays(
      candidate.startTime,
      context.existingDatesInWeek,
      policies.maxWorkDaysWeek ?? 6
    );
    violations.push(...maxDaysResult.violations);
  }

  // 3. OT caps
  const durationMin = Math.round(
    (candidate.endTime.getTime() - candidate.startTime.getTime()) / 60000
  );
  // Any minutes beyond standard 8h (480 min) or overtime segment count toward OT
  let additionalOtMin = 0;
  if (candidate.isOvertime) {
    additionalOtMin = durationMin;
  } else if (durationMin > 480) {
    additionalOtMin = durationMin - 480;
  }

  const otCapsResult = checkOtCaps(
    context.currentOtMonthMin ?? 0,
    context.currentOtYearMin ?? 0,
    additionalOtMin,
    policies.otCapMonthMin ?? 2400,
    policies.otCapYearMin ?? 12000
  );
  violations.push(...otCapsResult.violations);

  // 4. Certificates
  if (context.certifications) {
    const certResult = checkCertificates(context.certifications, candidate.startTime);
    violations.push(...certResult.violations);
  }

  // 5. Double booking
  if (context.existingAssignments) {
    const doubleResult = checkDoubleBooking(candidate, context.existingAssignments);
    violations.push(...doubleResult.violations);
  }

  return {
    ok: violations.length === 0,
    violations: Array.from(new Set(violations))
  };
}
