import { z } from "zod";
import { PostTierEnum, PostStatusEnum, ShiftCodeEnum, SiteModeEnum } from "./index.js";

// All state machine event types according to SWMS Build Spec §6 & Appendix A
export const EventTypeEnum = z.enum([
  "SHIFT_START",
  "SHIFT_END",
  "CHECKIN_ACCEPTED",
  "FLOAT_CHECKIN",
  "ORIGINAL_BACK",
  "MEAL_WINDOW_OPEN",
  "HANDOVER_TIMEOUT",
  "MEAL_OVERRUN",
  "PRESENCE_UNCERTAIN",
  "QR_CONFIRMED",
  "ESCALATE_TIMEOUT",
  "ABSENCE_REPORTED",
  "REPLACEMENT_ASSIGNED",
  "ACCEPT_PLANNED_GAP",
  "MERGE_WITH_PAIR",
  "CAMERA_MOTION",
  "FIRE_ALARM",
  "EMERGENCY_CLEARED",
  "POLICY_CHANGED",
  "DISPATCH_ACKED",
  "DISPATCH_DECLINED",
  "DISPATCH_EXPIRED"
]);
export type EventType = z.infer<typeof EventTypeEnum>;

// Schema for an incoming state transition event
export const StateTransitionEventSchema = z.object({
  siteId: z.string().default("AEON_THANH_KHE_F1"),
  postId: z.string().nullable().optional(),
  kind: EventTypeEnum,
  actorId: z.number().int().positive().nullable().optional(),
  payload: z.record(z.any()).default({}),
  idemKey: z.string().nullable().optional(),
  simTs: z.union([z.string(), z.date()]).optional()
});
export type StateTransitionEvent = z.infer<typeof StateTransitionEventSchema>;

// Post State record in DB
export const PostStateRecordSchema = z.object({
  post_id: z.string(),
  status: PostStatusEnum,
  guard_id: z.number().nullable().optional(),
  since: z.union([z.string(), z.date()]),
  deadline_at: z.union([z.string(), z.date()]).nullable().optional(),
  version: z.number().int()
});
export type PostStateRecord = z.infer<typeof PostStateRecordSchema>;

// Site State record in DB
export const SiteStateRecordSchema = z.object({
  site_id: z.string(),
  mode: SiteModeEnum,
  version: z.number().int(),
  since: z.union([z.string(), z.date()]).nullable().optional()
});
export type SiteStateRecord = z.infer<typeof SiteStateRecordSchema>;

// Outbox WS Envelope (§11)
export const OutboxEnvelopeSchema = z.object({
  v: z.literal(1).default(1),
  type: z.string(),
  seq: z.number().int(),
  ts: z.string(),
  payload: z.record(z.any())
});
export type OutboxEnvelope<T = any> = {
  v: 1;
  type: string;
  seq: number;
  ts: string;
  payload: T;
};

// State event record stored in DB
export const StateEventRecordSchema = z.object({
  id: z.number().int(),
  site_id: z.string(),
  post_id: z.string().nullable().optional(),
  from_status: PostStatusEnum.nullable().optional(),
  to_status: PostStatusEnum.nullable().optional(),
  cause: z.string(),
  actor_id: z.number().nullable().optional(),
  payload: z.record(z.any()),
  sim_ts: z.union([z.string(), z.date()]),
  real_ts: z.union([z.string(), z.date()]).optional(),
  idem_key: z.string().nullable().optional()
});
export type StateEventRecord = z.infer<typeof StateEventRecordSchema>;

// Result returned by transition execution
export interface TransitionResult {
  success: boolean;
  siteId: string;
  postId?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  siteMode?: string;
  guardId?: number | null;
  deadlineAt?: string | null;
  version: number;
  eventId?: number;
  idemKey?: string | null;
  isReplay?: boolean;
}

// DTO for guard break start (§12)
export const StartBreakDtoSchema = z.object({
  guardId: z.number().int().positive(),
  postId: z.string().min(1)
});
export type StartBreakDto = z.infer<typeof StartBreakDtoSchema>;

// State snapshot response (§12)
export interface StateSnapshotResponse {
  site: SiteStateRecord;
  posts: PostStateRecord[];
  lastSeq: number;
}
