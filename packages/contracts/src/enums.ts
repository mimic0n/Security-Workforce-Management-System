import { z } from "zod";

// Enums
export const PostTierEnum = z.enum(["TIER1", "TIER2"]);
export type PostTier = z.infer<typeof PostTierEnum>;

export const PostStatusEnum = z.enum([
  "NOT_ACTIVE",
  "OCCUPIED",
  "HANDOVER_PENDING",
  "RELIEVED_FOR_MEAL",
  "VACANT_ALERT",
  "VACANT_PLANNED",
  "COVERED_BY_PAIR",
  "UNCERTAIN"
]);
export type PostStatus = z.infer<typeof PostStatusEnum>;

export const GuardRoleEnum = z.enum(["GUARD", "FLOAT", "SUPERVISOR"]);
export type GuardRole = z.infer<typeof GuardRoleEnum>;

export const FloatKindEnum = z.enum(["TIER1_RELIEF", "GENERAL"]);
export type FloatKind = z.infer<typeof FloatKindEnum>;

export const ShiftCodeEnum = z.enum(["MORNING", "AFTERNOON", "NIGHT"]);
export type ShiftCode = z.infer<typeof ShiftCodeEnum>;

export const SiteModeEnum = z.enum(["NORMAL", "EMERGENCY"]);
export type SiteMode = z.infer<typeof SiteModeEnum>;

export const UserRoleEnum = z.enum([
  "ADMIN",
  "HR",
  "MANAGER",
  "DISPATCHER",
  "SUPERVISOR",
  "FLOAT",
  "GUARD"
]);
export type UserRole = z.infer<typeof UserRoleEnum>;
