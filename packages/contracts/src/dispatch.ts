import { z } from "zod";
import { ShiftCodeEnum, PostTierEnum } from "./enums.js";

// Priority enum/values per §8.1:
// EMERGENCY=0, TIER1_VACANCY=1, MEAL=2, TIER2_VACANCY=3, OTHER=4
export const DispatchPriority = {
  EMERGENCY: 0,
  TIER1_VACANCY: 1,
  MEAL: 2,
  TIER2_VACANCY: 3,
  OTHER: 4
} as const;

export type DispatchPriorityKey = keyof typeof DispatchPriority;
export type DispatchPriorityValue = typeof DispatchPriority[DispatchPriorityKey];

export const DispatchTaskKindEnum = z.enum([
  "ABSENCE_REPORTED",
  "PRESENCE_LOSS",
  "CAMERA_MOTION",
  "FIRE_ALARM",
  "POLICY_CHANGED",
  "FILL_VACANCY",
  "REPLAN_MEAL",
  "OTHER"
]);
export type DispatchTaskKind = z.infer<typeof DispatchTaskKindEnum>;

export const DispatchTaskStatusEnum = z.enum([
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED"
]);
export type DispatchTaskStatus = z.infer<typeof DispatchTaskStatusEnum>;

export const DispatchTaskSchema = z.object({
  id: z.number().int().positive().optional(),
  siteId: z.string().default("AEON_THANH_KHE_F1"),
  shiftKey: z.string(),
  priority: z.number().int().min(0).max(4).default(DispatchPriority.OTHER),
  kind: DispatchTaskKindEnum,
  payload: z.record(z.any()).default({}),
  status: DispatchTaskStatusEnum.default("PENDING"),
  createdAt: z.union([z.string(), z.date()]).optional(),
  processedAt: z.union([z.string(), z.date()]).nullable().optional(),
  error: z.string().nullable().optional(),
  idemKey: z.string().nullable().optional()
});
export type DispatchTask = z.infer<typeof DispatchTaskSchema>;

export const DispatchOrderStatusEnum = z.enum([
  "PROPOSED",
  "SENT",
  "ACKED",
  "DECLINED",
  "EXPIRED",
  "CANCELLED"
]);
export type DispatchOrderStatus = z.infer<typeof DispatchOrderStatusEnum>;

export const DispatchOrderKindEnum = z.enum([
  "ASSIGNMENT",
  "MERGE_POST",
  "EARLY_CALL_IN",
  "STAY_OVER",
  "REVIEW_MOTION",
  "OVERRIDE"
]);
export type DispatchOrderKind = z.infer<typeof DispatchOrderKindEnum>;

export const DispatchActionSchema = z.object({
  action: z.string(),
  guardId: z.number().optional(),
  fromPost: z.string().optional(),
  toPost: z.string().optional(),
  reason: z.string()
});
export type DispatchAction = z.infer<typeof DispatchActionSchema>;

export const DispatchRejectedCandidateSchema = z.object({
  guardId: z.number(),
  role: z.string().optional(),
  reason: z.string(),
  score: z.number().optional()
});
export type DispatchRejectedCandidate = z.infer<typeof DispatchRejectedCandidateSchema>;

export const DispatchExplainSchema = z.object({
  winner: z
    .object({
      guardId: z.number(),
      score: z.number().optional(),
      role: z.string().optional(),
      reason: z.string().optional()
    })
    .optional(),
  rejected: z.array(DispatchRejectedCandidateSchema).default([]),
  actions: z.array(DispatchActionSchema).default([]),
  estimatedCost: z.number().optional(),
  details: z.record(z.any()).optional()
});
export type DispatchExplain = z.infer<typeof DispatchExplainSchema>;

export const DispatchOrderSchema = z.object({
  id: z.number().int().positive().optional(),
  shiftKey: z.string(),
  kind: DispatchOrderKindEnum,
  toGuardId: z.number().nullable().optional(),
  fromPost: z.string().nullable().optional(),
  toPost: z.string().nullable().optional(),
  status: DispatchOrderStatusEnum.default("SENT"),
  explain: DispatchExplainSchema.default({ rejected: [], actions: [] }),
  sentAt: z.union([z.string(), z.date()]).nullable().optional(),
  ackAt: z.union([z.string(), z.date()]).nullable().optional(),
  idemKey: z.string().nullable().optional()
});
export type DispatchOrder = z.infer<typeof DispatchOrderSchema>;

export const AbsenceStatusEnum = z.enum(["REPORTED", "HANDLED", "REJECTED"]);
export type AbsenceStatus = z.infer<typeof AbsenceStatusEnum>;

export const CreateAbsenceSchema = z.object({
  guardId: z.number().int().positive(),
  forShift: ShiftCodeEnum,
  forDate: z.string(), // YYYY-MM-DD
  reason: z.string().optional(),
  reportedAt: z.string().optional(),
  idemKey: z.string().optional()
});
export type CreateAbsenceDto = z.infer<typeof CreateAbsenceSchema>;

export const AbsenceDecisionSchema = z.object({
  status: z.enum(["HANDLED", "REJECTED"]),
  decisionNote: z.string().optional()
});
export type AbsenceDecisionDto = z.infer<typeof AbsenceDecisionSchema>;

export const DispatchOverrideSchema = z.object({
  postId: z.string(),
  guardId: z.number().int().positive(),
  shiftKey: z.string(),
  reason: z.string().min(1)
});
export type DispatchOverrideDto = z.infer<typeof DispatchOverrideSchema>;

export const RankWeightsSchema = z.object({
  distance: z.number().default(1),
  ot: z.number().default(2),
  load: z.number().default(1.5)
});
export type RankWeights = z.infer<typeof RankWeightsSchema>;

export interface CandidateScore {
  guardId: number;
  score: number;
  travelMin: number;
  otMinutesMonth: number;
  dispatchesToday: number;
}
