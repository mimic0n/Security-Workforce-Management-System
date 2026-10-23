import { z } from "zod";
import { ShiftCodeEnum, type ShiftCode } from "./enums.js";

export const PolicySchema = z.object({
  key: z.string().min(1),
  value: z.any(),
  valid_from: z.string(),
  valid_to: z.string().nullable().optional(),
  created_by: z.number().int().positive().nullable().optional()
});
export type Policy = z.infer<typeof PolicySchema>;

export const UpdatePolicySchema = z.object({
  value: z.any(),
  valid_from: z.string().optional(),
  valid_to: z.string().nullable().optional()
});
export type UpdatePolicyDto = z.infer<typeof UpdatePolicySchema>;

export const PolicyPreviewSchema = z.object({
  key: z.string().min(1).optional(),
  value: z.any().optional(),
  overrides: z.record(z.any()).optional()
});
export type PolicyPreviewDto = z.infer<typeof PolicyPreviewSchema>;

export * from "./staffing.js";
