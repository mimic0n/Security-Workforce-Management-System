import {
  MealPlannerFloat,
  MealPlannerPost,
  MealReliefSlot,
  MealReliefViolation
} from "@swms/contracts";

export interface PlanValidationContext {
  posts: MealPlannerPost[];
  floats: MealPlannerFloat[];
  window: { start: Date; end: Date };
  breakMinutes: number;
  handoverBufferMin: number;
  travel: (a: string, b: string) => number;
  shift?: { start: Date; end: Date };
  edgeExclusionMin?: number;
}

export interface PlanValidationResult {
  feasible: boolean;
  violations: MealReliefViolation[];
}

/**
 * Validates a meal relief plan against window, travel, handover buffer,
 * coverage, float availability, and edge exclusion rules.
 */
export function validatePlan(
  plan: MealReliefSlot[],
  context: PlanValidationContext
): PlanValidationResult {
  const violations: MealReliefViolation[] = [];
  const {
    posts,
    floats,
    window,
    breakMinutes,
    handoverBufferMin,
    travel,
    shift,
    edgeExclusionMin
  } = context;

  const windowStartTime = window.start.getTime();
  const windowEndTime = window.end.getTime();
  const minDurationMs = breakMinutes * 60 * 1000;
  const handoverMs = handoverBufferMin * 60 * 1000;

  const floatMap = new Map(floats.map((f) => [f.id, f]));
  const plannedPostIds = new Set(plan.map((s) => s.postId));

  // 1. Check all required Tier 1 posts are covered
  for (const post of posts) {
    if (post.tier === "TIER1" && !plannedPostIds.has(post.id)) {
      violations.push({
        postId: post.id,
        reason: "POST_NOT_COVERED"
      });
    }
  }

  // 2. Check each slot boundaries and duration
  for (const slot of plan) {
    const startMs = slot.start.getTime();
    const endMs = slot.end.getTime();

    // Duration
    if (endMs - startMs < minDurationMs) {
      violations.push({
        postId: slot.postId,
        reason: "INSUFFICIENT_DURATION"
      });
    }

    // Window boundaries
    if (startMs < windowStartTime || endMs > windowEndTime) {
      violations.push({
        postId: slot.postId,
        reason: "WINDOW_EXCEEDED"
      });
    }

    // Float availability
    const float = floatMap.get(slot.floatId);
    if (!float) {
      violations.push({
        postId: slot.postId,
        reason: "UNKNOWN_FLOAT"
      });
    } else {
      if (
        startMs < float.available.from.getTime() ||
        endMs > float.available.to.getTime()
      ) {
        violations.push({
          postId: slot.postId,
          reason: "FLOAT_NOT_AVAILABLE"
        });
      }
    }

    // Edge exclusion (Decree 145/2020: break not in first/last 60 min of shift)
    if (shift && edgeExclusionMin && edgeExclusionMin > 0) {
      const exclusionMs = edgeExclusionMin * 60 * 1000;
      const shiftStartMs = shift.start.getTime();
      const shiftEndMs = shift.end.getTime();

      if (startMs < shiftStartMs + exclusionMs || endMs > shiftEndMs - exclusionMs) {
        violations.push({
          postId: slot.postId,
          reason: "EDGE_EXCLUSION_VIOLATION"
        });
      }
    }
  }

  // 3. Check per-float consecutive slot travel + buffer
  const slotsByFloat = new Map<string, MealReliefSlot[]>();
  for (const slot of plan) {
    const list = slotsByFloat.get(slot.floatId) || [];
    list.push(slot);
    slotsByFloat.set(slot.floatId, list);
  }

  for (const [, slots] of slotsByFloat.entries()) {
    // Sort slots by start time
    const sorted = [...slots].sort((a, b) => a.start.getTime() - b.start.getTime());

    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];

      const travelMin = travel(current.postId, next.postId);
      const travelMs = travelMin * 60 * 1000;
      const earliestNextStart = current.end.getTime() + travelMs + handoverMs;

      if (next.start.getTime() < earliestNextStart) {
        violations.push({
          postId: next.postId,
          reason: `TRAVEL_OR_BUFFER_VIOLATION: float ${next.floatId} cannot arrive at ${next.postId} from ${current.postId} in time`
        });
      }
    }
  }

  return {
    feasible: violations.length === 0,
    violations
  };
}
