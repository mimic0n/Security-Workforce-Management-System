import { z } from "zod";
import crypto from "node:crypto";

export const AttendanceKindEnum = z.enum([
  "CHECK_IN",
  "CHECK_OUT",
  "PRESENCE_PING",
  "QR_CONFIRM"
]);
export type AttendanceKind = z.infer<typeof AttendanceKindEnum>;

export const AttendanceMethodEnum = z.enum([
  "GPS",
  "QR",
  "SUPERVISOR",
  "SIM"
]);
export type AttendanceMethod = z.infer<typeof AttendanceMethodEnum>;

export const AttendanceNonceRequestSchema = z.object({
  postId: z.string().min(1),
  deviceUid: z.string().min(1).optional(),
  guardId: z.number().int().positive().optional()
});
export type AttendanceNonceRequest = z.infer<typeof AttendanceNonceRequestSchema>;

export const AttendanceNonceResponseSchema = z.object({
  nonce: z.string().min(1),
  expiresAt: z.string(),
  ttlSec: z.number().int().positive()
});
export type AttendanceNonceResponse = z.infer<typeof AttendanceNonceResponseSchema>;

export const AttendanceCheckRequestSchema = z.object({
  kind: AttendanceKindEnum,
  postId: z.string().min(1),
  nonce: z.string().min(1),
  qrToken: z.string().min(1),
  deviceUid: z.string().min(1),
  guardId: z.number().int().positive().optional(),
  gps: z
    .object({
      lat: z.number(),
      lon: z.number(),
      accuracy: z.number()
    })
    .optional(),
  timestamp: z.string().optional() // ISO string for offline sync queue
});
export type AttendanceCheckRequest = z.infer<typeof AttendanceCheckRequestSchema>;

export const AttendanceCheckResponseSchema = z.object({
  accepted: z.boolean(),
  reason: z.string().optional(),
  logId: z.number().optional(),
  eventType: z.string().optional(),
  lateSync: z.boolean().optional()
});
export type AttendanceCheckResponse = z.infer<typeof AttendanceCheckResponseSchema>;

export const AttendancePingRequestSchema = z.object({
  guardId: z.number().int().positive(),
  postId: z.string().min(1),
  lat: z.number(),
  lon: z.number(),
  accuracy_m: z.number(),
  deviceUid: z.string().optional(),
  timestamp: z.string().optional()
});
export type AttendancePingRequest = z.infer<typeof AttendancePingRequestSchema>;

export const AttendancePingResponseSchema = z.object({
  accepted: z.boolean(),
  filtered: z.boolean(),
  reason: z.string().optional(),
  state: z.enum(["INSIDE", "OUTSIDE", "UNCERTAIN"]),
  consecutiveOutside: z.number().int().optional(),
  distance_m: z.number().optional()
});
export type AttendancePingResponse = z.infer<typeof AttendancePingResponseSchema>;

export const DEFAULT_QR_SECRET = "swms-qr-secret-key-aeon-thanh-khe";

/**
 * Generate HMAC token for a physical QR code.
 * qrToken = HMAC(secret, qr_code_id)
 */
export function generateQrToken(qrCodeId: string, secret: string = DEFAULT_QR_SECRET): string {
  return crypto.createHmac("sha256", secret).update(qrCodeId).digest("hex");
}
