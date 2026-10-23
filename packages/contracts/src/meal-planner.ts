import { z } from "zod";
import { PostTierEnum } from "./enums.js";

export const MealPlannerPostSchema = z.object({
  id: z.string().min(1),
  tier: PostTierEnum
});
export type MealPlannerPost = z.infer<typeof MealPlannerPostSchema>;

export const MealPlannerFloatSchema = z.object({
  id: z.string().min(1),
  available: z.object({
    from: z.date(),
    to: z.date()
  })
});
export type MealPlannerFloat = z.infer<typeof MealPlannerFloatSchema>;

export interface MealReliefPlanInput {
  posts: MealPlannerPost[];
  floats: MealPlannerFloat[];
  window: { start: Date; end: Date };
  breakMinutes: number;
  handoverBufferMin: number;
  travel: (a: string, b: string) => number;
  baseLocation: string;
  order?: string[];
}

export const MealReliefSlotSchema = z.object({
  postId: z.string().min(1),
  floatId: z.string().min(1),
  start: z.date(),
  end: z.date()
});
export type MealReliefSlot = z.infer<typeof MealReliefSlotSchema>;

export const MealReliefViolationSchema = z.object({
  postId: z.string().min(1),
  reason: z.string()
});
export type MealReliefViolation = z.infer<typeof MealReliefViolationSchema>;

export const MealReliefSuggestionEnum = z.enum([
  "EXTEND_WINDOW",
  "USE_TIER2_RELIEF",
  "CALL_IN_EXTRA_GUARD"
]);
export type MealReliefSuggestion = z.infer<typeof MealReliefSuggestionEnum>;

export const MealReliefPlanResultSchema = z.object({
  feasible: z.boolean(),
  plan: z.array(MealReliefSlotSchema),
  violations: z.array(MealReliefViolationSchema),
  suggestions: z.array(z.string())
});
export type MealReliefPlanResult = z.infer<typeof MealReliefPlanResultSchema>;

export const BreakPlanStatusEnum = z.enum([
  "PLANNED",
  "IN_PROGRESS",
  "DONE",
  "CANCELLED"
]);
export type BreakPlanStatus = z.infer<typeof BreakPlanStatusEnum>;

export const BreakPlanRecordSchema = z.object({
  id: z.number().int().positive().optional(),
  shift_key: z.string().min(1),
  post_id: z.string().min(1),
  original_guard_id: z.number().int().positive().nullable().optional(),
  float_guard_id: z.number().int().positive().nullable().optional(),
  slot: z.string().or(z.object({ start: z.date(), end: z.date() })),
  status: BreakPlanStatusEnum.default("PLANNED")
});
export type BreakPlanRecord = z.infer<typeof BreakPlanRecordSchema>;
