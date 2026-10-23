import { describe, it, expect } from "vitest";
import {
  planMealRelief,
  validatePlan,
  type MealPlannerPost,
  type MealPlannerFloat,
  type MealReliefPlanInput,
  type MealReliefSlot
} from "../src/modules/dispatch/meal-planner/index.js";

describe("Milestone M5 — Meal Relief Planner Golden Tests (§7)", () => {
  // Default travel matrix helper per §2.5:
  // 5 min within group, 10 min across groups
  const zoneGroups: Record<string, string> = {
    G1: "gates-north",
    G5: "gates-north",
    P8: "gates-north",
    G4: "gates-south",
    G3: "gates-south",
    G2: "gates-south",
    G6: "gates-south",
    P1: "dept",
    P6: "dept",
    P7: "dept",
    P2: "hall",
    P3: "hall",
    P4: "hall",
    P5: "hall"
  };

  const defaultTravelMatrix = (a: string, b: string): number => {
    if (a === b) return 0;
    const gA = zoneGroups[a];
    const gB = zoneGroups[b];
    if (gA && gB && gA === gB) return 5;
    return 10;
  };

  // 7 Tier 1 posts in morning/afternoon
  const tier1Posts: MealPlannerPost[] = [
    { id: "G1", tier: "TIER1" },
    { id: "P1", tier: "TIER1" },
    { id: "G4", tier: "TIER1" },
    { id: "P6", tier: "TIER1" },
    { id: "G5", tier: "TIER1" },
    { id: "P7", tier: "TIER1" },
    { id: "P8", tier: "TIER1" }
  ];

  // Window: 10:00 to 12:45 on 2026-10-24
  const windowStart = new Date("2026-10-24T10:00:00+07:00");
  const windowEnd = new Date("2026-10-24T12:45:00+07:00");

  const shiftStart = new Date("2026-10-24T06:00:00+07:00");
  const shiftEnd = new Date("2026-10-24T14:00:00+07:00");

  const twoFloats: MealPlannerFloat[] = [
    { id: "FLOAT_A", available: { from: shiftStart, to: shiftEnd } },
    { id: "FLOAT_B", available: { from: shiftStart, to: shiftEnd } }
  ];

  it("Golden Test 1: validatePlan(sourceDocPlan) reports feasible for the exact doc schedule", () => {
    const sourceDocPlan: MealReliefSlot[] = [
      {
        postId: "G1",
        floatId: "FLOAT_A",
        start: new Date("2026-10-24T10:00:00+07:00"),
        end: new Date("2026-10-24T10:30:00+07:00")
      },
      {
        postId: "P1",
        floatId: "FLOAT_B",
        start: new Date("2026-10-24T10:20:00+07:00"),
        end: new Date("2026-10-24T10:50:00+07:00")
      },
      {
        postId: "G4",
        floatId: "FLOAT_A",
        start: new Date("2026-10-24T10:45:00+07:00"),
        end: new Date("2026-10-24T11:15:00+07:00")
      },
      {
        postId: "P6",
        floatId: "FLOAT_B",
        start: new Date("2026-10-24T11:05:00+07:00"),
        end: new Date("2026-10-24T11:35:00+07:00")
      },
      {
        postId: "G5",
        floatId: "FLOAT_A",
        start: new Date("2026-10-24T11:30:00+07:00"),
        end: new Date("2026-10-24T12:00:00+07:00")
      },
      {
        postId: "P7",
        floatId: "FLOAT_B",
        start: new Date("2026-10-24T11:50:00+07:00"),
        end: new Date("2026-10-24T12:20:00+07:00")
      },
      {
        postId: "P8",
        floatId: "FLOAT_A",
        start: new Date("2026-10-24T12:15:00+07:00"),
        end: new Date("2026-10-24T12:45:00+07:00")
      }
    ];

    const validationResult = validatePlan(sourceDocPlan, {
      posts: tier1Posts,
      floats: twoFloats,
      window: { start: windowStart, end: windowEnd },
      breakMinutes: 30,
      handoverBufferMin: 5,
      travel: defaultTravelMatrix
    });

    expect(validationResult.feasible).toBe(true);
    expect(validationResult.violations).toHaveLength(0);
  });

  it("Golden Test 2: planMealRelief with 2 floats covers all 7 posts within window without overlaps and alternates", () => {
    const input: MealReliefPlanInput = {
      posts: tier1Posts,
      floats: twoFloats,
      window: { start: windowStart, end: windowEnd },
      breakMinutes: 30,
      handoverBufferMin: 5,
      travel: defaultTravelMatrix,
      baseLocation: "BASE",
      order: ["G1", "P1", "G4", "P6", "G5", "P7", "P8"]
    };

    const result = planMealRelief(input);

    expect(result.feasible).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.plan).toHaveLength(7);

    // All 7 posts covered
    const plannedPostIds = result.plan.map((s) => s.postId);
    expect(plannedPostIds).toEqual(["G1", "P1", "G4", "P6", "G5", "P7", "P8"]);

    // Within window
    for (const slot of result.plan) {
      expect(slot.start.getTime()).toBeGreaterThanOrEqual(windowStart.getTime());
      expect(slot.end.getTime()).toBeLessThanOrEqual(windowEnd.getTime());
      expect(slot.end.getTime() - slot.start.getTime()).toBe(30 * 60 * 1000);
    }

    // Float usage alternates (Float A has 4, Float B has 3)
    const floatCounts: Record<string, number> = {};
    for (const slot of result.plan) {
      floatCounts[slot.floatId] = (floatCounts[slot.floatId] || 0) + 1;
    }
    expect(floatCounts["FLOAT_A"]).toBe(4);
    expect(floatCounts["FLOAT_B"]).toBe(3);

    // Verify float alternation: A, B, A, B, A, B, A
    const floatSequence = result.plan.map((s) => s.floatId);
    expect(floatSequence).toEqual([
      "FLOAT_A",
      "FLOAT_B",
      "FLOAT_A",
      "FLOAT_B",
      "FLOAT_A",
      "FLOAT_B",
      "FLOAT_A"
    ]);

    // Validate the generated plan using validatePlan
    const validation = validatePlan(result.plan, {
      posts: tier1Posts,
      floats: twoFloats,
      window: { start: windowStart, end: windowEnd },
      breakMinutes: 30,
      handoverBufferMin: 5,
      travel: defaultTravelMatrix
    });
    expect(validation.feasible).toBe(true);
  });

  it("Golden Test 3: with 1 float returns feasible:false with standard suggestions", () => {
    const singleFloat: MealPlannerFloat[] = [
      { id: "FLOAT_A", available: { from: shiftStart, to: shiftEnd } }
    ];

    const input: MealReliefPlanInput = {
      posts: tier1Posts,
      floats: singleFloat,
      window: { start: windowStart, end: windowEnd },
      breakMinutes: 30,
      handoverBufferMin: 5,
      travel: defaultTravelMatrix,
      baseLocation: "BASE"
    };

    const result = planMealRelief(input);

    expect(result.feasible).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.some((v) => v.reason === "WINDOW_EXCEEDED")).toBe(true);

    // Required suggestions per spec §7
    expect(result.suggestions).toContain("EXTEND_WINDOW");
    expect(result.suggestions).toContain("USE_TIER2_RELIEF");
    expect(result.suggestions).toContain("CALL_IN_EXTRA_GUARD");
  });

  it("Re-plan with 1 float (e.g. sick leave) returns suggestions", () => {
    const remainingFloats: MealPlannerFloat[] = [
      { id: "FLOAT_A", available: { from: shiftStart, to: shiftEnd } }
    ];

    const input: MealReliefPlanInput = {
      posts: tier1Posts,
      floats: remainingFloats,
      window: { start: windowStart, end: windowEnd },
      breakMinutes: 30,
      handoverBufferMin: 5,
      travel: defaultTravelMatrix,
      baseLocation: "BASE",
      order: ["G1", "P1", "G4", "P6", "G5", "P7", "P8"]
    };

    const replanResult = planMealRelief(input);
    expect(replanResult.feasible).toBe(false);
    expect(replanResult.suggestions).toEqual(
      expect.arrayContaining(["EXTEND_WINDOW", "USE_TIER2_RELIEF", "CALL_IN_EXTRA_GUARD"])
    );
  });

  it("validatePlan rejects plans with overlapping slots for the same float", () => {
    const overlappingPlan: MealReliefSlot[] = [
      {
        postId: "G1",
        floatId: "FLOAT_A",
        start: new Date("2026-10-24T10:00:00+07:00"),
        end: new Date("2026-10-24T10:30:00+07:00")
      },
      {
        postId: "G4",
        floatId: "FLOAT_A",
        start: new Date("2026-10-24T10:35:00+07:00"),
        end: new Date("2026-10-24T11:05:00+07:00")
      }
    ];

    const val = validatePlan(overlappingPlan, {
      posts: [
        { id: "G1", tier: "TIER1" },
        { id: "G4", tier: "TIER1" }
      ],
      floats: twoFloats,
      window: { start: windowStart, end: windowEnd },
      breakMinutes: 30,
      handoverBufferMin: 5,
      travel: defaultTravelMatrix
    });

    expect(val.feasible).toBe(false);
    expect(val.violations.some((v) => v.reason.includes("TRAVEL_OR_BUFFER_VIOLATION"))).toBe(true);
  });

  it("validatePlan rejects plans where break starts within edge exclusion window of shift", () => {
    const edgePlan: MealReliefSlot[] = [
      {
        postId: "G1",
        floatId: "FLOAT_A",
        start: new Date("2026-10-24T06:30:00+07:00"),
        end: new Date("2026-10-24T07:00:00+07:00")
      }
    ];

    const val = validatePlan(edgePlan, {
      posts: [{ id: "G1", tier: "TIER1" }],
      floats: twoFloats,
      window: {
        start: new Date("2026-10-24T06:00:00+07:00"),
        end: new Date("2026-10-24T14:00:00+07:00")
      },
      shift: {
        start: shiftStart,
        end: shiftEnd
      },
      edgeExclusionMin: 60,
      breakMinutes: 30,
      handoverBufferMin: 5,
      travel: defaultTravelMatrix
    });

    expect(val.feasible).toBe(false);
    expect(val.violations.some((v) => v.reason.includes("EDGE_EXCLUSION_VIOLATION"))).toBe(true);
  });

  it("planMealRelief handles empty floats array", () => {
    const res = planMealRelief({
      posts: tier1Posts,
      floats: [],
      window: { start: windowStart, end: windowEnd },
      breakMinutes: 30,
      handoverBufferMin: 5,
      travel: defaultTravelMatrix,
      baseLocation: "BASE"
    });

    expect(res.feasible).toBe(false);
    expect(res.violations[0].reason).toBe("NO_FLOATS_AVAILABLE");
    expect(res.suggestions).toContain("EXTEND_WINDOW");
  });

  it("validatePlan rejects slots with insufficient duration or unknown floats", () => {
    const invalidPlan: MealReliefSlot[] = [
      {
        postId: "G1",
        floatId: "UNKNOWN_FLOAT_XYZ",
        start: new Date("2026-10-24T10:00:00+07:00"),
        end: new Date("2026-10-24T10:15:00+07:00")
      }
    ];

    const val = validatePlan(invalidPlan, {
      posts: tier1Posts,
      floats: twoFloats,
      window: { start: windowStart, end: windowEnd },
      breakMinutes: 30,
      handoverBufferMin: 5,
      travel: defaultTravelMatrix
    });

    expect(val.feasible).toBe(false);
    expect(val.violations.some((v) => v.reason === "INSUFFICIENT_DURATION")).toBe(true);
    expect(val.violations.some((v) => v.reason === "UNKNOWN_FLOAT")).toBe(true);
  });
});
