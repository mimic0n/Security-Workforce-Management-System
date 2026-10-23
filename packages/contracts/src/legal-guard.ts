import { z } from "zod";

export const LegalViolationCodeEnum = z.enum([
  "MIN_REST_HOURS_VIOLATED",
  "MAX_WORK_DAYS_WEEK_EXCEEDED",
  "MONTHLY_OT_CAP_EXCEEDED",
  "YEARLY_OT_CAP_EXCEEDED",
  "CERTIFICATE_EXPIRED",
  "DOUBLE_BOOKING"
]);
export type LegalViolationCode = z.infer<typeof LegalViolationCodeEnum>;

export const LegalGuardResultSchema = z.object({
  ok: z.boolean(),
  violations: z.array(z.string()),
  details: z.record(z.any()).optional()
});
export type LegalGuardResult = z.infer<typeof LegalGuardResultSchema>;

export const CandidateAssignmentSchema = z.object({
  guardId: z.number().int().positive(),
  startTime: z.date(),
  endTime: z.date(),
  isOvertime: z.boolean().default(false).optional(),
  assignmentType: z.string().default("ACTIVE").optional()
});
export type CandidateAssignment = z.infer<typeof CandidateAssignmentSchema>;

export const CostEstimateResultSchema = z.object({
  totalCost: z.number(),
  regularDayHours: z.number(),
  regularNightHours: z.number(),
  otDayHours: z.number(),
  otNightHours: z.number(),
  effectiveMultiplier: z.number()
});
export type CostEstimateResult = z.infer<typeof CostEstimateResultSchema>;
