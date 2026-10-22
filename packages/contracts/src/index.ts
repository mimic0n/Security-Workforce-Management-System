import { z } from "zod";
export * from "./clock.js";

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

// Guard Schemas
export const GuardSchema = z.object({
  id: z.number().int().positive().optional(),
  code: z.string().min(1),
  full_name: z.string().min(1),
  role: GuardRoleEnum,
  float_kind: FloatKindEnum.nullable().optional(),
  phone: z.string().nullable().optional(),
  active: z.boolean().default(true),
  hired_on: z.string().nullable().optional(),
  ot_minutes_month: z.number().int().default(0),
  ot_minutes_year: z.number().int().default(0)
});
export type Guard = z.infer<typeof GuardSchema>;

export const CreateGuardSchema = GuardSchema.omit({ id: true }).extend({
  ot_minutes_month: z.number().int().default(0).optional(),
  ot_minutes_year: z.number().int().default(0).optional()
});
export type CreateGuardDto = z.infer<typeof CreateGuardSchema>;

export const UpdateGuardSchema = CreateGuardSchema.partial();
export type UpdateGuardDto = z.infer<typeof UpdateGuardSchema>;

// Certification Schemas
export const CertificationSchema = z.object({
  id: z.number().int().positive().optional(),
  guard_id: z.number().int().positive(),
  cert_no: z.string().min(1),
  issued_on: z.string(),
  expires_on: z.string()
});
export type Certification = z.infer<typeof CertificationSchema>;

export const CreateCertificationSchema = CertificationSchema.omit({ id: true });
export type CreateCertificationDto = z.infer<typeof CreateCertificationSchema>;

// Device Schemas
export const DeviceSchema = z.object({
  id: z.number().int().positive().optional(),
  guard_id: z.number().int().positive(),
  device_uid: z.string().min(1),
  registered_at: z.string().optional(),
  active: z.boolean().default(true)
});
export type Device = z.infer<typeof DeviceSchema>;

export const CreateDeviceSchema = DeviceSchema.omit({ id: true, registered_at: true });
export type CreateDeviceDto = z.infer<typeof CreateDeviceSchema>;

// Post Schemas
export const PostSchema = z.object({
  id: z.string().min(1),
  site_id: z.string().default("AEON_THANH_KHE_F1"),
  name: z.string().min(1),
  zone: z.string().min(1),
  x: z.number(),
  y: z.number(),
  lat: z.number().nullable().optional(),
  lon: z.number().nullable().optional(),
  geofence_m: z.number().int().default(25),
  qr_code_id: z.string().min(1)
});
export type Post = z.infer<typeof PostSchema>;

export const CreatePostSchema = PostSchema;
export type CreatePostDto = z.infer<typeof CreatePostSchema>;

export const UpdatePostSchema = PostSchema.partial().omit({ id: true });
export type UpdatePostDto = z.infer<typeof UpdatePostSchema>;

// PostRule Schemas
export const RawPostRuleSchema = z.object({
  post_id: z.string().min(1),
  tier: PostTierEnum,
  max_vacant_sec: z.number().int().min(0).default(0),
  pair_with: z.array(z.string()).default([]),
  active_shifts: z.array(ShiftCodeEnum),
  needs_meal_cover: z.boolean().default(true)
});

export const PostRuleSchema = RawPostRuleSchema.refine(
  (data) => data.tier !== "TIER1" || data.max_vacant_sec === 0,
  {
    message: "Tier 1 posts must have max_vacant_sec = 0 (Zero-Vacancy invariant)",
    path: ["max_vacant_sec"]
  }
);
export type PostRule = z.infer<typeof RawPostRuleSchema>;

export const UpdatePostRuleSchema = RawPostRuleSchema.partial().omit({ post_id: true });
export type UpdatePostRuleDto = z.infer<typeof UpdatePostRuleSchema>;

// ShiftTemplate Schema
export const ShiftTemplateSchema = z.object({
  code: ShiftCodeEnum,
  start_time: z.string(),
  end_time: z.string(),
  crosses_midnight: z.boolean(),
  break_minutes: z.number().int()
});
export type ShiftTemplate = z.infer<typeof ShiftTemplateSchema>;

// Auth Schemas
export const LoginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: z.object({
    id: z.number(),
    username: z.string(),
    role: UserRoleEnum,
    guard_id: z.number().nullable()
  })
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const AuthUserPayloadSchema = z.object({
  sub: z.number(),
  username: z.string(),
  role: UserRoleEnum,
  guard_id: z.number().nullable()
});
export type AuthUserPayload = z.infer<typeof AuthUserPayloadSchema>;

export * from "./policies.js";
export * from "./audit.js";

