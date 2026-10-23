import { z } from "zod";
import { OutboxEnvelopeSchema, OutboxEnvelope } from "./state-machine.js";

// Standard WebSocket Room Names (§11)
export const WebSocketRooms = {
  dashboard: (siteId = "AEON_THANH_KHE_F1") => `dashboard:${siteId}`,
  guard: (guardId: number) => `guard:${guardId}`,
  shift: (siteId: string, shiftKey: string) => `shift:${siteId}:${shiftKey}`,
  emergency: (siteId = "AEON_THANH_KHE_F1") => `emergency:${siteId}`
} as const;

// Topics sent over WebSocket
export const WebSocketTopics = {
  // Dashboard Room Topics
  POST_STATE_CHANGED: "post.state_changed",
  KPI_UPDATED: "kpi.updated",
  INCIDENT_OPENED: "incident.opened",
  INCIDENT_CLOSED: "incident.closed",
  DISPATCH_PROPOSED: "dispatch.proposed",
  DISPATCH_EXECUTED: "dispatch.executed",
  DISPATCH_ACKED: "dispatch.acked",
  DISPATCH_DECLINED: "dispatch.declined",
  DISPATCH_EXPIRED: "dispatch.expired",
  DISPATCH_OVERRIDE: "dispatch.override",
  SITE_MODE_CHANGED: "site.mode_changed",
  STAFFING_UPDATED: "staffing.updated",

  // Guard Room Topics
  DISPATCH_ORDER: "dispatch.order",
  SCHEDULE_UPDATED: "schedule.updated",
  BREAK_LOCKED: "break.locked",
  BREAK_UNLOCKED: "break.unlocked",
  QR_CHALLENGE: "qr.challenge",

  // Shift Room Topics
  ANNOUNCEMENT: "announcement",

  // Emergency Room Topics (highest priority, everyone)
  EMERGENCY_STARTED: "emergency.started",
  EMERGENCY_CLEARED: "emergency.cleared"
} as const;

export type WebSocketTopic = (typeof WebSocketTopics)[keyof typeof WebSocketTopics];

// Dispatch Ack payload sent from client over WS
export const ClientDispatchAckSchema = z.object({
  orderId: z.number().int().positive(),
  guardId: z.number().int().positive().optional()
});
export type ClientDispatchAck = z.infer<typeof ClientDispatchAckSchema>;

// Dispatch Decline payload sent from client over WS
export const ClientDispatchDeclineSchema = z.object({
  orderId: z.number().int().positive(),
  reason: z.string().min(1).default("Cannot fulfill dispatch")
});
export type ClientDispatchDecline = z.infer<typeof ClientDispatchDeclineSchema>;

// Floor Post Presentation Model for UI (§15)
export interface FloorPostMarker {
  id: string;
  name: string;
  tier: "TIER1" | "TIER2";
  zone: string;
  x: number;
  y: number;
  status: string;
  guardId: number | null;
  guardCode?: string | null;
  guardName?: string | null;
  since?: string | null;
  deadlineAt?: string | null;
  version: number;
}
