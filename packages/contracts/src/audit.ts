import { z } from "zod";

export const AuditLogSchema = z.object({
  id: z.number().int().positive().optional(),
  actor_id: z.number().int().nullable().optional(),
  action: z.string().min(1),
  entity: z.string().nullable().optional(),
  before: z.any().nullable().optional(),
  after: z.any().nullable().optional(),
  at: z.string().optional()
});
export type AuditLog = z.infer<typeof AuditLogSchema>;
