import { z } from "zod";
import { ShiftCodeEnum, type ShiftCode } from "./index.js";

// Staffing counts per shift
export const ShiftStaffingCountSchema = z.object({
  fixed: z.number().int().min(0),
  floatT1: z.number().int().min(0),
  floatGen: z.number().int().min(0),
  sup: z.number().int().min(0),
  total: z.number().int().min(0)
});
export type ShiftStaffingCount = z.infer<typeof ShiftStaffingCountSchema>;

// Sensitivity item
export const SensitivityItemSchema = z.object({
  k: z.number(),
  required: z.number().int().min(0),
  gap: z.number().int().min(0)
});
export type SensitivityItem = z.infer<typeof SensitivityItemSchema>;

// Full staffing calculation result
export const StaffingResultSchema = z.object({
  perShift: z.object({
    MORNING: ShiftStaffingCountSchema,
    AFTERNOON: ShiftStaffingCountSchema,
    NIGHT: ShiftStaffingCountSchema
  }),
  slotsPerDay: z.number().int().min(0),
  k: z.number(),
  required: z.number().int().min(0),
  present: z.number().int().min(0),
  gap: z.number().int().min(0),
  gapPct: z.number().min(0),
  sensitivity: z.array(SensitivityItemSchema)
});
export type StaffingResult = z.infer<typeof StaffingResultSchema>;

// Derived K calculation from annual working days
export const AnnualDaysParamsSchema = z.object({
  totalDays: z.number().positive().optional().default(365),
  workDaysMax: z.number().positive().optional().default(313),
  leave: z.number().min(0),
  sick: z.number().min(0),
  training: z.number().min(0),
  other: z.number().min(0).optional().default(0)
});

export interface AnnualDaysParams {
  totalDays?: number;
  workDaysMax?: number;
  leave: number;
  sick: number;
  training: number;
  other?: number;
}

/**
 * Computes derived relief factor K from annual working and off days.
 * Formula: totalDays / (workDaysMax - leave - sick - training - other)
 * Default: 365 / (313 - 12 - 6 - 2) = 365 / 293 ≈ 1.2457
 */
export function computeKFromAnnualDays(params: AnnualDaysParams): number {
  const totalDays = params.totalDays ?? 365;
  const workDaysMax = params.workDaysMax ?? 313;
  const other = params.other ?? 0;
  const netWorkDays = workDaysMax - params.leave - params.sick - params.training - other;
  if (netWorkDays <= 0) {
    throw new Error("Net working days must be greater than zero");
  }
  return Number((totalDays / netWorkDays).toFixed(4));
}

// Parameter overrides for simulation
export const StaffingSimulateSchema = z
  .object({
    // Standard policy-style keys
    "headcount.fixed": z.record(ShiftCodeEnum, z.number()).optional(),
    "headcount.float_t1": z.record(ShiftCodeEnum, z.number()).optional(),
    "headcount.float_gen": z.record(ShiftCodeEnum, z.number()).optional(),
    "headcount.sup": z.record(ShiftCodeEnum, z.number()).optional(),
    "relief.k_override": z.number().nullable().optional(),
    "relief.k_weekly_rest": z.number().optional(),
    "relief.leave_sick_ratio": z.number().optional(),
    "relief.k_sensitivity_range": z.tuple([z.number(), z.number()]).optional(),

    // Shorthand keys for convenience
    fixed: z.record(ShiftCodeEnum, z.number()).optional(),
    floatT1: z.record(ShiftCodeEnum, z.number()).optional(),
    float_t1: z.record(ShiftCodeEnum, z.number()).optional(),
    floatGen: z.record(ShiftCodeEnum, z.number()).optional(),
    float_gen: z.record(ShiftCodeEnum, z.number()).optional(),
    sup: z.record(ShiftCodeEnum, z.number()).optional(),
    k_override: z.number().nullable().optional(),
    kOverride: z.number().nullable().optional(),
    k_weekly_rest: z.number().optional(),
    kWeeklyRest: z.number().optional(),
    leave_sick_ratio: z.number().optional(),
    leaveSickRatio: z.number().optional(),
    k_sensitivity_range: z.tuple([z.number(), z.number()]).optional(),
    kSensitivityRange: z.tuple([z.number(), z.number()]).optional(),

    // Present headcount override
    present: z.number().int().min(0).optional(),

    // Time-travel / evaluation at specific ISO string
    at: z.string().optional()
  })
  .passthrough();
export type StaffingSimulateDto = z.infer<typeof StaffingSimulateSchema>;

// Staffing Requests
export const StaffingRequestSchema = z.object({
  id: z.number().int().positive(),
  created_at: z.string(),
  shift: ShiftCodeEnum.nullable().optional(),
  qty: z.number().int().positive(),
  reason: z.string().min(1),
  status: z.string().default("OPEN")
});
export type StaffingRequest = z.infer<typeof StaffingRequestSchema>;

export const CreateStaffingRequestSchema = z.object({
  shift: ShiftCodeEnum.nullable().optional(),
  qty: z.number().int().positive(),
  reason: z.string().min(1),
  status: z.string().default("OPEN").optional()
});
export type CreateStaffingRequestDto = z.infer<typeof CreateStaffingRequestSchema>;

export const StaffingRequestFilterSchema = z.object({
  shift: ShiftCodeEnum.optional(),
  status: z.string().optional()
});
export type StaffingRequestFilterDto = z.infer<typeof StaffingRequestFilterSchema>;
