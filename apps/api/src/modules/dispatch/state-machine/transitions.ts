import {
  PostStatus,
  EventType,
  PostTier,
  SiteMode,
  StateTransitionEvent
} from "@swms/contracts";
import { InvalidTransitionError } from "./invalid-transition.error.js";
import { Tier1InvariantError } from "./tier1-invariant.error.js";

export interface PostContext {
  id: string;
  tier: PostTier;
  status: PostStatus;
  guardId?: number | null;
  deadlineAt?: Date | null;
  pairWith?: string[];
  maxVacantSec?: number;
}

export interface TransitionContext {
  post: PostContext;
  event: StateTransitionEvent;
  siteMode?: SiteMode;
  now: Date;
  extra?: {
    pairPostStatus?: PostStatus;
    breakPlanExists?: boolean;
    plannedFloatId?: number;
    postActiveThisShift?: boolean;
    nonceValid?: boolean;
    legalGuardOk?: boolean;
    vacantSeconds?: number;
  };
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

export interface TransitionRule {
  from: PostStatus;
  event: EventType;
  to: PostStatus;
  description: string;
  effects: string;
  topic: string;
  guard?: (ctx: TransitionContext) => GuardResult;
}

/**
 * 6.1 Transition table (data-driven)
 */
export const TRANSITION_TABLE: readonly TransitionRule[] = [
  // 1. NOT_ACTIVE + SHIFT_START -> VACANT_ALERT
  {
    from: "NOT_ACTIVE",
    event: "SHIFT_START",
    to: "VACANT_ALERT",
    description: "Post becomes active for the shift; awaiting check-in",
    effects: "open expectation; await check-in (grace = shift start tolerance policy)",
    topic: "post.state_changed",
    guard: (ctx) => {
      // Check if post is active for this shift
      const active = ctx.extra?.postActiveThisShift ?? ctx.event.payload?.postActive ?? true;
      if (!active) {
        return { ok: false, reason: `Post ${ctx.post.id} is not active in this shift` };
      }
      return { ok: true };
    }
  },

  // 2. VACANT_ALERT + CHECKIN_ACCEPTED -> OCCUPIED
  {
    from: "VACANT_ALERT",
    event: "CHECKIN_ACCEPTED",
    to: "OCCUPIED",
    description: "Guard assigned/valid checks in; post becomes occupied",
    effects: "close VACANCY incident if any; set guard_id",
    topic: "post.state_changed",
    guard: (ctx) => {
      const guardId = ctx.event.payload?.guardId ?? ctx.event.actorId;
      if (!guardId) {
        return { ok: false, reason: "Check-in requires a valid guardId" };
      }
      const legalGuardOk = ctx.extra?.legalGuardOk ?? ctx.event.payload?.legalGuardOk ?? true;
      if (!legalGuardOk) {
        return { ok: false, reason: "Guard failed LegalGuard validation" };
      }
      return { ok: true };
    }
  },

  // 3. OCCUPIED + MEAL_WINDOW_OPEN -> HANDOVER_PENDING
  {
    from: "OCCUPIED",
    event: "MEAL_WINDOW_OPEN",
    to: "HANDOVER_PENDING",
    description: "Meal window opened, awaiting float relief guard arrival",
    effects: "lock original guard's break button; send MEAL_RELIEF order to float; set deadline_at",
    topic: "post.state_changed",
    guard: (ctx) => {
      const breakPlanExists =
        ctx.extra?.breakPlanExists ??
        ctx.event.payload?.breakPlanExists ??
        Boolean(ctx.event.payload?.breakPlanId || ctx.event.payload?.floatId);
      if (breakPlanExists === false) {
        return { ok: false, reason: "Meal break plan does not exist for this post" };
      }
      return { ok: true };
    }
  },

  // 4. HANDOVER_PENDING + FLOAT_CHECKIN -> RELIEVED_FOR_MEAL
  {
    from: "HANDOVER_PENDING",
    event: "FLOAT_CHECKIN",
    to: "RELIEVED_FOR_MEAL",
    description: "Float guard checked in at post, original guard can take meal break",
    effects: "unlock break for original; set deadline = slot end",
    topic: "post.state_changed",
    guard: (ctx) => {
      const floatId = ctx.event.payload?.floatId ?? ctx.event.actorId;
      const plannedFloatId =
        ctx.extra?.plannedFloatId ?? ctx.event.payload?.plannedFloatId;
      if (plannedFloatId != null && floatId != null && Number(floatId) !== Number(plannedFloatId)) {
        return {
          ok: false,
          reason: `Float guard ${floatId} does not match planned float ${plannedFloatId}`
        };
      }
      return { ok: true };
    }
  },

  // 5. HANDOVER_PENDING + HANDOVER_TIMEOUT -> VACANT_ALERT
  {
    from: "HANDOVER_PENDING",
    event: "HANDOVER_TIMEOUT",
    to: "VACANT_ALERT",
    description: "Handover timeout elapsed before float arrived",
    effects: "call fillVacancy(post)",
    topic: "post.state_changed",
    guard: (ctx) => {
      const forceTimeout = ctx.event.payload?.forceTimeout ?? false;
      if (!forceTimeout && ctx.post.deadlineAt) {
        const deadline = new Date(ctx.post.deadlineAt);
        if (ctx.now < deadline) {
          return {
            ok: false,
            reason: `Handover deadline (${deadline.toISOString()}) not reached yet (now: ${ctx.now.toISOString()})`
          };
        }
      }
      return { ok: true };
    }
  },

  // 6. RELIEVED_FOR_MEAL + ORIGINAL_BACK -> OCCUPIED
  {
    from: "RELIEVED_FOR_MEAL",
    event: "ORIGINAL_BACK",
    to: "OCCUPIED",
    description: "Original guard returns from break, resumes post",
    effects: "float released to pool, break_plans.status=DONE",
    topic: "post.state_changed",
    guard: (ctx) => {
      const guardId = ctx.event.payload?.guardId ?? ctx.event.actorId;
      const originalGuardId = ctx.event.payload?.originalGuardId ?? ctx.post.guardId;
      if (originalGuardId && guardId && Number(guardId) !== Number(originalGuardId)) {
        return {
          ok: false,
          reason: `Guard ${guardId} is not the original guard ${originalGuardId}`
        };
      }
      return { ok: true };
    }
  },

  // 7. RELIEVED_FOR_MEAL + MEAL_OVERRUN -> RELIEVED_FOR_MEAL (self-transition)
  {
    from: "RELIEVED_FOR_MEAL",
    event: "MEAL_OVERRUN",
    to: "RELIEVED_FOR_MEAL",
    description: "Original guard is late returning from meal break (warning only)",
    effects: "warning only: notify original guard, open LOW incident; float stays on post",
    topic: "post.state_changed",
    guard: (ctx) => {
      const force = ctx.event.payload?.force ?? false;
      if (!force && ctx.post.deadlineAt) {
        const toleranceSec = ctx.event.payload?.toleranceSec ?? 0;
        const deadline = new Date(ctx.post.deadlineAt).getTime() + toleranceSec * 1000;
        if (ctx.now.getTime() < deadline) {
          return {
            ok: false,
            reason: `Meal overrun deadline + tolerance not reached yet`
          };
        }
      }
      return { ok: true };
    }
  },

  // 8. OCCUPIED + PRESENCE_UNCERTAIN -> UNCERTAIN
  {
    from: "OCCUPIED",
    event: "PRESENCE_UNCERTAIN",
    to: "UNCERTAIN",
    description: "GPS lost or outside geofence beyond debounce threshold",
    effects: "send QR challenge push; set deadline_at",
    topic: "post.state_changed",
    guard: () => ({ ok: true })
  },

  // 9. UNCERTAIN + QR_CONFIRMED -> OCCUPIED
  {
    from: "UNCERTAIN",
    event: "QR_CONFIRMED",
    to: "OCCUPIED",
    description: "Guard confirmed presence by scanning QR challenge nonce",
    effects: "clear QR challenge and presence alert",
    topic: "post.state_changed",
    guard: (ctx) => {
      const nonceValid = ctx.extra?.nonceValid ?? ctx.event.payload?.nonceValid ?? true;
      if (!nonceValid) {
        return { ok: false, reason: "QR nonce verification failed or expired" };
      }
      return { ok: true };
    }
  },

  // 10. UNCERTAIN + ESCALATE_TIMEOUT -> VACANT_ALERT
  {
    from: "UNCERTAIN",
    event: "ESCALATE_TIMEOUT",
    to: "VACANT_ALERT",
    description: "QR challenge timeout expired; escalate to vacancy",
    effects: "fillVacancy(post); schedule violation timer",
    topic: "post.state_changed",
    guard: (ctx) => {
      const force = ctx.event.payload?.force ?? false;
      if (force) return { ok: true };

      if (ctx.post.tier === "TIER1") {
        if (ctx.post.deadlineAt && ctx.now < new Date(ctx.post.deadlineAt)) {
          return {
            ok: false,
            reason: `Tier 1 escalation deadline not reached yet`
          };
        }
      } else {
        // Tier 2
        const vacantSec = ctx.extra?.vacantSeconds ?? ctx.event.payload?.vacantSeconds ?? 0;
        const maxVacantSec = ctx.post.maxVacantSec ?? 900;
        if (ctx.post.deadlineAt && ctx.now < new Date(ctx.post.deadlineAt) && vacantSec < maxVacantSec) {
          return {
            ok: false,
            reason: `Tier 2 vacancy timeout (${maxVacantSec}s) not reached yet`
          };
        }
      }
      return { ok: true };
    }
  },

  // 11. OCCUPIED + ABSENCE_REPORTED -> VACANT_ALERT
  {
    from: "OCCUPIED",
    event: "ABSENCE_REPORTED",
    to: "VACANT_ALERT",
    description: "Guard reported absent or sick during shift",
    effects: "call fillVacancy(post)",
    topic: "post.state_changed",
    guard: () => ({ ok: true })
  },

  // 12. VACANT_ALERT + REPLACEMENT_ASSIGNED -> VACANT_ALERT (stays)
  {
    from: "VACANT_ALERT",
    event: "REPLACEMENT_ASSIGNED",
    to: "VACANT_ALERT",
    description: "Replacement guard assigned, awaiting check-in",
    effects: "create order; await check-in (ack timeout)",
    topic: "post.state_changed",
    guard: (ctx) => {
      const legalGuardOk = ctx.extra?.legalGuardOk ?? ctx.event.payload?.legalGuardOk ?? true;
      if (!legalGuardOk) {
        return { ok: false, reason: "Replacement guard failed LegalGuard checks" };
      }
      return { ok: true };
    }
  },

  // 13. VACANT_ALERT + ACCEPT_PLANNED_GAP -> VACANT_PLANNED (Tier 2 only)
  {
    from: "VACANT_ALERT",
    event: "ACCEPT_PLANNED_GAP",
    to: "VACANT_PLANNED",
    description: "Accept planned vacancy gap (Tier 2 only)",
    effects: "log risk; post marked as planned gap",
    topic: "post.state_changed",
    guard: () => ({ ok: true })
  },

  // 14. VACANT_ALERT + MERGE_WITH_PAIR -> COVERED_BY_PAIR (Tier 2 only)
  {
    from: "VACANT_ALERT",
    event: "MERGE_WITH_PAIR",
    to: "COVERED_BY_PAIR",
    description: "Merge coverage with adjacent pair post (Tier 2 only)",
    effects: "order MERGE_POST to pair guard",
    topic: "post.state_changed",
    guard: (ctx) => {
      // Check pair post status if provided
      const pairPostStatus = ctx.extra?.pairPostStatus ?? ctx.event.payload?.pairPostStatus;
      if (pairPostStatus && pairPostStatus !== "OCCUPIED") {
        return {
          ok: false,
          reason: `Pair post is not OCCUPIED (current status: ${pairPostStatus})`
        };
      }
      return { ok: true };
    }
  },

  // 15. VACANT_PLANNED + CHECKIN_ACCEPTED -> OCCUPIED
  {
    from: "VACANT_PLANNED",
    event: "CHECKIN_ACCEPTED",
    to: "OCCUPIED",
    description: "Guard checks in at planned gap post",
    effects: "post becomes occupied",
    topic: "post.state_changed",
    guard: (ctx) => {
      const guardId = ctx.event.payload?.guardId ?? ctx.event.actorId;
      if (!guardId) {
        return { ok: false, reason: "Check-in requires a valid guardId" };
      }
      return { ok: true };
    }
  },

  // 16. COVERED_BY_PAIR + CHECKIN_ACCEPTED -> OCCUPIED
  {
    from: "COVERED_BY_PAIR",
    event: "CHECKIN_ACCEPTED",
    to: "OCCUPIED",
    description: "Guard checks in at pair-covered post",
    effects: "post becomes occupied; pair merge ended",
    topic: "post.state_changed",
    guard: (ctx) => {
      const guardId = ctx.event.payload?.guardId ?? ctx.event.actorId;
      if (!guardId) {
        return { ok: false, reason: "Check-in requires a valid guardId" };
      }
      return { ok: true };
    }
  },

  // 17. VACANT_PLANNED + REPLACEMENT_ASSIGNED -> VACANT_ALERT
  {
    from: "VACANT_PLANNED",
    event: "REPLACEMENT_ASSIGNED",
    to: "VACANT_ALERT",
    description: "Replacement assigned for planned gap post",
    effects: "create order; await check-in",
    topic: "post.state_changed",
    guard: () => ({ ok: true })
  },

  // 18. COVERED_BY_PAIR + REPLACEMENT_ASSIGNED -> VACANT_ALERT
  {
    from: "COVERED_BY_PAIR",
    event: "REPLACEMENT_ASSIGNED",
    to: "VACANT_ALERT",
    description: "Replacement assigned for pair-covered post",
    effects: "create order; await check-in",
    topic: "post.state_changed",
    guard: () => ({ ok: true })
  },

  // 19. Any status (except NOT_ACTIVE) + SHIFT_END -> NOT_ACTIVE
  ...([
    "OCCUPIED",
    "HANDOVER_PENDING",
    "RELIEVED_FOR_MEAL",
    "VACANT_ALERT",
    "VACANT_PLANNED",
    "COVERED_BY_PAIR",
    "UNCERTAIN"
  ] as const).map((status): TransitionRule => ({
    from: status,
    event: "SHIFT_END",
    to: "NOT_ACTIVE",
    description: `End of shift for post currently in ${status}`,
    effects: "reset post state for shift end",
    topic: "post.state_changed",
    guard: () => ({ ok: true })
  }))
];

/**
 * Find matching transition rule from table.
 */
export function findTransitionRule(
  from: PostStatus,
  event: EventType
): TransitionRule | undefined {
  return TRANSITION_TABLE.find((rule) => rule.from === from && rule.event === event);
}

/**
 * Validate and evaluate a transition.
 * Throws InvalidTransitionError or Tier1InvariantError if invalid.
 */
export function evaluateTransition(ctx: TransitionContext): {
  toStatus: PostStatus;
  rule: TransitionRule;
} {
  // If site is in emergency mode, per-post transitions are suspended (except SHIFT_END)
  if (ctx.siteMode === "EMERGENCY" && ctx.event.kind !== "SHIFT_END") {
    throw new InvalidTransitionError(
      ctx.post.status,
      ctx.event.kind,
      "Per-post transitions are suspended while site is in EMERGENCY mode"
    );
  }

  const rule = findTransitionRule(ctx.post.status, ctx.event.kind);
  if (!rule) {
    throw new InvalidTransitionError(ctx.post.status, ctx.event.kind);
  }

  // Enforce Tier 1 Zero-Vacancy invariants: Tier 1 cannot enter VACANT_PLANNED or COVERED_BY_PAIR
  if (
    ctx.post.tier === "TIER1" &&
    (rule.to === "VACANT_PLANNED" || rule.to === "COVERED_BY_PAIR")
  ) {
    throw new Tier1InvariantError(
      ctx.post.id,
      rule.to,
      "Tier 1 posts can never enter VACANT_PLANNED or COVERED_BY_PAIR."
    );
  }

  // Evaluate rule guard
  if (rule.guard) {
    const guardRes = rule.guard(ctx);
    if (!guardRes.ok) {
      throw new InvalidTransitionError(
        ctx.post.status,
        ctx.event.kind,
        guardRes.reason
      );
    }
  }

  return { toStatus: rule.to, rule };
}
