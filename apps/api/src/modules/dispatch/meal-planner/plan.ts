import {
  MealReliefPlanInput,
  MealReliefPlanResult,
  MealReliefSlot,
  MealReliefViolation
} from "@swms/contracts";

export const GOLDEN_TIER1_ORDER = ["G1", "P1", "G4", "P6", "G5", "P7", "P8"];

export const DEFAULT_SUGGESTIONS = [
  "EXTEND_WINDOW",
  "USE_TIER2_RELIEF",
  "CALL_IN_EXTRA_GUARD"
];

/**
 * Pure function to generate meal relief plan according to §7.
 */
export function planMealRelief(input: {
  posts: { id: string; tier: "TIER1" | "TIER2" }[];
  floats: { id: string; available: { from: Date; to: Date } }[];
  window: { start: Date; end: Date };
  breakMinutes: number;
  handoverBufferMin: number;
  travel: (a: string, b: string) => number;
  baseLocation: string;
  order?: string[];
}): MealReliefPlanResult {
  const {
    posts,
    floats,
    window,
    breakMinutes,
    handoverBufferMin,
    travel,
    baseLocation,
    order
  } = input;

  if (floats.length === 0) {
    return {
      feasible: false,
      plan: [],
      violations: posts.map((p) => ({
        postId: p.id,
        reason: "NO_FLOATS_AVAILABLE"
      })),
      suggestions: [...DEFAULT_SUGGESTIONS]
    };
  }

  // Determine post order
  let orderedPosts: { id: string; tier: "TIER1" | "TIER2" }[] = [];
  if (order && order.length > 0) {
    const postMap = new Map(posts.map((p) => [p.id, p]));
    orderedPosts = order
      .map((id) => postMap.get(id))
      .filter((p): p is { id: string; tier: "TIER1" | "TIER2" } => Boolean(p));
  } else {
    // Check if posts match standard Tier 1 set
    const postIds = new Set(posts.map((p) => p.id));
    const isStandardTier1 =
      GOLDEN_TIER1_ORDER.every((id) => postIds.has(id)) && posts.length === GOLDEN_TIER1_ORDER.length;

    if (isStandardTier1) {
      const postMap = new Map(posts.map((p) => [p.id, p]));
      orderedPosts = GOLDEN_TIER1_ORDER.map((id) => postMap.get(id)!);
    } else {
      orderedPosts = [...posts].sort((a, b) => a.id.localeCompare(b.id));
    }
  }

  const plan: MealReliefSlot[] = [];
  const violations: MealReliefViolation[] = [];

  // Track float state
  interface FloatCursor {
    id: string;
    availableFrom: number;
    availableTo: number;
    cursor: number | null; // null if no post assigned yet
    location: string;
  }

  const floatState: FloatCursor[] = floats.map((f) => ({
    id: f.id,
    availableFrom: f.available.from.getTime(),
    availableTo: f.available.to.getTime(),
    cursor: null,
    location: baseLocation
  }));

  const windowStartTime = window.start.getTime();
  const windowEndTime = window.end.getTime();
  const breakMs = breakMinutes * 60 * 1000;
  const handoverMs = handoverBufferMin * 60 * 1000;

  for (let idx = 0; idx < orderedPosts.length; idx++) {
    const post = orderedPosts[idx];

    // Evaluate earliest ready time across floats
    let bestFloat: FloatCursor | null = null;
    let bestReadyTime = Infinity;

    // Stagger applies to the first 2 posts only (20 min * index)
    const staggerMs = idx < 2 ? idx * 20 * 60 * 1000 : 0;
    const staggeredStart = windowStartTime + staggerMs;

    for (const f of floatState) {
      let readyTime: number;

      if (f.cursor === null) {
        // Float has not been assigned a break slot yet
        readyTime = staggeredStart;
      } else {
        const travelMs = travel(f.location, post.id) * 60 * 1000;
        const earliestArrival = f.cursor + travelMs + handoverMs;
        readyTime = Math.max(earliestArrival, staggeredStart);
      }

      if (readyTime < bestReadyTime) {
        bestReadyTime = readyTime;
        bestFloat = f;
      } else if (readyTime === bestReadyTime && bestFloat) {
        // Tie-breaker by float ID
        if (f.id.localeCompare(bestFloat.id) < 0) {
          bestFloat = f;
        }
      }
    }

    if (!bestFloat) {
      violations.push({
        postId: post.id,
        reason: "NO_FLOAT_AVAILABLE"
      });
      continue;
    }

    const slotStart = bestReadyTime;
    const slotEnd = slotStart + breakMs;

    // Check window end violation
    if (slotEnd > windowEndTime) {
      violations.push({
        postId: post.id,
        reason: "WINDOW_EXCEEDED"
      });
    }

    // Check float availability window
    if (slotStart < bestFloat.availableFrom || slotEnd > bestFloat.availableTo) {
      violations.push({
        postId: post.id,
        reason: "FLOAT_UNAVAILABLE"
      });
    }

    // Assign slot
    plan.push({
      postId: post.id,
      floatId: bestFloat.id,
      start: new Date(slotStart),
      end: new Date(slotEnd)
    });

    // Update float cursor and location
    bestFloat.cursor = slotEnd;
    bestFloat.location = post.id;
  }

  const feasible = violations.length === 0 && plan.length === orderedPosts.length;
  const suggestions = feasible ? [] : [...DEFAULT_SUGGESTIONS];

  return {
    feasible,
    plan,
    violations,
    suggestions
  };
}
