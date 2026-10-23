import { describe, it, expect, beforeEach } from "vitest";
import {
  PostStatus,
  EventType,
  SiteMode,
  PostTier,
  StateTransitionEvent
} from "@swms/contracts";
import {
  TRANSITION_TABLE,
  findTransitionRule,
  evaluateTransition,
  TransitionContext,
  InvalidTransitionError,
  Tier1InvariantError,
  OptimisticLockError,
  StateMachineService
} from "../src/modules/dispatch/state-machine/index.js";
import { VirtualClock } from "../src/core/clock/virtual-clock.js";

describe("Milestone M4: State Machine Unit & Table-Driven Tests", () => {
  let clock: VirtualClock;
  let service: StateMachineService;
  const baseTime = new Date("2026-10-23T06:00:00.000Z");

  beforeEach(() => {
    clock = new VirtualClock(baseTime);
    service = new StateMachineService(clock);
  });

  describe("1. Transition Table Completeness & Rules", () => {
    it("has rules defined for all expected valid transitions in §6.1", () => {
      expect(TRANSITION_TABLE.length).toBeGreaterThanOrEqual(25);
    });

    const validCases: Array<{
      from: PostStatus;
      event: EventType;
      tier: PostTier;
      expectedTo: PostStatus;
      extra?: any;
      payload?: any;
    }> = [
      { from: "NOT_ACTIVE", event: "SHIFT_START", tier: "TIER1", expectedTo: "VACANT_ALERT" },
      { from: "VACANT_ALERT", event: "CHECKIN_ACCEPTED", tier: "TIER1", expectedTo: "OCCUPIED", payload: { guardId: 10 } },
      { from: "OCCUPIED", event: "MEAL_WINDOW_OPEN", tier: "TIER1", expectedTo: "HANDOVER_PENDING", payload: { breakPlanExists: true } },
      { from: "HANDOVER_PENDING", event: "FLOAT_CHECKIN", tier: "TIER1", expectedTo: "RELIEVED_FOR_MEAL", payload: { floatId: 20 } },
      { from: "HANDOVER_PENDING", event: "HANDOVER_TIMEOUT", tier: "TIER1", expectedTo: "VACANT_ALERT", payload: { forceTimeout: true } },
      { from: "RELIEVED_FOR_MEAL", event: "ORIGINAL_BACK", tier: "TIER1", expectedTo: "OCCUPIED", payload: { guardId: 10, originalGuardId: 10 } },
      { from: "RELIEVED_FOR_MEAL", event: "MEAL_OVERRUN", tier: "TIER1", expectedTo: "RELIEVED_FOR_MEAL", payload: { force: true } },
      { from: "OCCUPIED", event: "PRESENCE_UNCERTAIN", tier: "TIER1", expectedTo: "UNCERTAIN" },
      { from: "UNCERTAIN", event: "QR_CONFIRMED", tier: "TIER1", expectedTo: "OCCUPIED", payload: { nonceValid: true } },
      { from: "UNCERTAIN", event: "ESCALATE_TIMEOUT", tier: "TIER1", expectedTo: "VACANT_ALERT", payload: { force: true } },
      { from: "UNCERTAIN", event: "ESCALATE_TIMEOUT", tier: "TIER2", expectedTo: "VACANT_ALERT", payload: { force: true } },
      { from: "OCCUPIED", event: "ABSENCE_REPORTED", tier: "TIER1", expectedTo: "VACANT_ALERT" },
      { from: "VACANT_ALERT", event: "REPLACEMENT_ASSIGNED", tier: "TIER1", expectedTo: "VACANT_ALERT" },
      { from: "VACANT_ALERT", event: "ACCEPT_PLANNED_GAP", tier: "TIER2", expectedTo: "VACANT_PLANNED" },
      { from: "VACANT_ALERT", event: "MERGE_WITH_PAIR", tier: "TIER2", expectedTo: "COVERED_BY_PAIR", payload: { pairPostStatus: "OCCUPIED" } },
      { from: "VACANT_PLANNED", event: "CHECKIN_ACCEPTED", tier: "TIER2", expectedTo: "OCCUPIED", payload: { guardId: 12 } },
      { from: "COVERED_BY_PAIR", event: "CHECKIN_ACCEPTED", tier: "TIER2", expectedTo: "OCCUPIED", payload: { guardId: 14 } },
      { from: "VACANT_PLANNED", event: "REPLACEMENT_ASSIGNED", tier: "TIER2", expectedTo: "VACANT_ALERT" },
      { from: "COVERED_BY_PAIR", event: "REPLACEMENT_ASSIGNED", tier: "TIER2", expectedTo: "VACANT_ALERT" },
      // SHIFT_END from all active states
      { from: "OCCUPIED", event: "SHIFT_END", tier: "TIER1", expectedTo: "NOT_ACTIVE" },
      { from: "HANDOVER_PENDING", event: "SHIFT_END", tier: "TIER1", expectedTo: "NOT_ACTIVE" },
      { from: "RELIEVED_FOR_MEAL", event: "SHIFT_END", tier: "TIER1", expectedTo: "NOT_ACTIVE" },
      { from: "VACANT_ALERT", event: "SHIFT_END", tier: "TIER1", expectedTo: "NOT_ACTIVE" },
      { from: "VACANT_PLANNED", event: "SHIFT_END", tier: "TIER2", expectedTo: "NOT_ACTIVE" },
      { from: "COVERED_BY_PAIR", event: "SHIFT_END", tier: "TIER2", expectedTo: "NOT_ACTIVE" },
      { from: "UNCERTAIN", event: "SHIFT_END", tier: "TIER1", expectedTo: "NOT_ACTIVE" }
    ];

    it.each(validCases)(
      "valid transition: $from + $event ($tier) -> $expectedTo",
      ({ from, event, tier, expectedTo, extra, payload }) => {
        const post = {
          id: tier === "TIER1" ? "G1" : "G2",
          tier,
          status: from,
          guardId: 10,
          deadlineAt: new Date(baseTime.getTime() - 1000)
        };
        const evt: StateTransitionEvent = {
          siteId: "AEON_THANH_KHE_F1",
          postId: post.id,
          kind: event,
          actorId: 10,
          payload: payload || {}
        };

        const resDirect = evaluateTransition({
          post,
          event: evt,
          siteMode: "NORMAL",
          now: baseTime,
          extra
        });
        expect(resDirect.toStatus).toBe(expectedTo);

        // Also test through StateMachineService.evaluatePostTransition
        const out = service.evaluatePostTransition(post, evt, "NORMAL", extra);
        expect(out.toStatus).toBe(expectedTo);
        expect(out.topic).toBe("post.state_changed");
      }
    );

    it("evaluates explicit deadlineAt and custom payload fields in evaluatePostTransition", () => {
      const explicitDeadline = new Date(baseTime.getTime() + 60000);
      const shiftStartOut = service.evaluatePostTransition(
        { id: "G1", tier: "TIER1", status: "NOT_ACTIVE" },
        { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "SHIFT_START", payload: { deadlineAt: explicitDeadline.toISOString() } }
      );
      expect(shiftStartOut.deadlineAt?.toISOString()).toBe(explicitDeadline.toISOString());

      const mealOpenOut = service.evaluatePostTransition(
        { id: "G1", tier: "TIER1", status: "OCCUPIED" },
        { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "MEAL_WINDOW_OPEN", payload: { breakPlanId: 1, deadlineAt: explicitDeadline.toISOString() } }
      );
      expect(mealOpenOut.deadlineAt?.toISOString()).toBe(explicitDeadline.toISOString());

      const floatCheckinOut = service.evaluatePostTransition(
        { id: "G1", tier: "TIER1", status: "HANDOVER_PENDING" },
        { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "FLOAT_CHECKIN", payload: { floatId: 2, deadlineAt: explicitDeadline.toISOString() } }
      );
      expect(floatCheckinOut.deadlineAt?.toISOString()).toBe(explicitDeadline.toISOString());

      const replaceOut = service.evaluatePostTransition(
        { id: "G1", tier: "TIER1", status: "VACANT_ALERT" },
        { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "REPLACEMENT_ASSIGNED", payload: { deadlineAt: explicitDeadline.toISOString() } }
      );
      expect(replaceOut.deadlineAt?.toISOString()).toBe(explicitDeadline.toISOString());

      const mergeOut = service.evaluatePostTransition(
        { id: "P2", tier: "TIER2", status: "VACANT_ALERT" },
        { siteId: "AEON_THANH_KHE_F1", postId: "P2", kind: "MERGE_WITH_PAIR", payload: { pairGuardId: 15, pairPostStatus: "OCCUPIED" } }
      );
      expect(mergeOut.guardId).toBe(15);

      const uncertainOut = service.evaluatePostTransition(
        { id: "G1", tier: "TIER1", status: "OCCUPIED" },
        { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "PRESENCE_UNCERTAIN", payload: { deadlineAt: explicitDeadline.toISOString() } }
      );
      expect(uncertainOut.deadlineAt?.toISOString()).toBe(explicitDeadline.toISOString());
    });

    it("evaluates default deadlines and guard fallbacks across all post transitions", () => {
      // 1. MEAL_WINDOW_OPEN default 5 min
      const mealDefault = service.evaluatePostTransition(
        { id: "G1", tier: "TIER1", status: "OCCUPIED", guardId: 10 },
        { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "MEAL_WINDOW_OPEN", payload: { breakPlanId: 1 } }
      );
      expect(mealDefault.deadlineAt?.getTime()).toBe(baseTime.getTime() + 5 * 60 * 1000);

      // 2. FLOAT_CHECKIN default 30 min
      const floatDefault = service.evaluatePostTransition(
        { id: "G1", tier: "TIER1", status: "HANDOVER_PENDING", guardId: 10 },
        { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "FLOAT_CHECKIN", payload: { floatId: 20 } }
      );
      expect(floatDefault.deadlineAt?.getTime()).toBe(baseTime.getTime() + 30 * 60 * 1000);

      // 3. PRESENCE_UNCERTAIN default Tier 1 (120s)
      const uncertainT1Default = service.evaluatePostTransition(
        { id: "G1", tier: "TIER1", status: "OCCUPIED", guardId: 10 },
        { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "PRESENCE_UNCERTAIN", payload: {} }
      );
      expect(uncertainT1Default.deadlineAt?.getTime()).toBe(baseTime.getTime() + 120 * 1000);

      // 4. PRESENCE_UNCERTAIN default Tier 2 (900s)
      const uncertainT2Default = service.evaluatePostTransition(
        { id: "P2", tier: "TIER2", status: "OCCUPIED", guardId: 10 },
        { siteId: "AEON_THANH_KHE_F1", postId: "P2", kind: "PRESENCE_UNCERTAIN", payload: {} }
      );
      expect(uncertainT2Default.deadlineAt?.getTime()).toBe(baseTime.getTime() + 900 * 1000);

      // 5. ORIGINAL_BACK fallback to post.guardId
      const origDefault = service.evaluatePostTransition(
        { id: "G1", tier: "TIER1", status: "RELIEVED_FOR_MEAL", guardId: 88 },
        { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "ORIGINAL_BACK", payload: {} }
      );
      expect(origDefault.guardId).toBe(88);

      // 6. ORIGINAL_BACK fallback to payload.guardId
      const origPayload = service.evaluatePostTransition(
        { id: "G1", tier: "TIER1", status: "RELIEVED_FOR_MEAL", guardId: 88 },
        { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "ORIGINAL_BACK", payload: { guardId: 88 } }
      );
      expect(origPayload.guardId).toBe(88);

      // 7. REPLACEMENT_ASSIGNED without deadlineAt
      const replaceDefault = service.evaluatePostTransition(
        { id: "G1", tier: "TIER1", status: "VACANT_ALERT" },
        { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "REPLACEMENT_ASSIGNED", payload: {} }
      );
      expect(replaceDefault.deadlineAt).toBeNull();

      // 8. SHIFT_START without deadlineAt
      const shiftStartDefault = service.evaluatePostTransition(
        { id: "G1", tier: "TIER1", status: "NOT_ACTIVE" },
        { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "SHIFT_START", payload: {} }
      );
      expect(shiftStartDefault.deadlineAt).toBeNull();
    });
  });

  describe("2. Rejection of Invalid (From, Event) Pairs", () => {
    const allStatuses: PostStatus[] = [
      "NOT_ACTIVE",
      "OCCUPIED",
      "HANDOVER_PENDING",
      "RELIEVED_FOR_MEAL",
      "VACANT_ALERT",
      "VACANT_PLANNED",
      "COVERED_BY_PAIR",
      "UNCERTAIN"
    ];

    const allEvents: EventType[] = [
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
    ];

    it("rejects SHIFT_END from NOT_ACTIVE state", () => {
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "NOT_ACTIVE" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "SHIFT_END", payload: {} },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx)).toThrow(InvalidTransitionError);
    });

    it("rejects all undefined (status, event) pairs in the state machine matrix", () => {
      let rejectedCount = 0;
      for (const st of allStatuses) {
        for (const ev of allEvents) {
          const rule = findTransitionRule(st, ev);
          if (!rule) {
            const ctx: TransitionContext = {
              post: { id: "G2", tier: "TIER2", status: st },
              event: { siteId: "AEON_THANH_KHE_F1", postId: "G2", kind: ev, payload: {} },
              siteMode: "NORMAL",
              now: baseTime
            };
            expect(() => evaluateTransition(ctx)).toThrow(InvalidTransitionError);
            rejectedCount++;
          }
        }
      }
      expect(rejectedCount).toBeGreaterThan(100);
    });
  });

  describe("3. Guard Conditions & Invariant Enforcement", () => {
    it("handles postActiveThisShift from extra vs payload", () => {
      const ctx1: TransitionContext = {
        post: { id: "P1", tier: "TIER1", status: "NOT_ACTIVE" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "P1", kind: "SHIFT_START", payload: {} },
        siteMode: "NORMAL",
        now: baseTime,
        extra: { postActiveThisShift: false }
      };
      expect(() => evaluateTransition(ctx1)).toThrow(InvalidTransitionError);

      const ctx2: TransitionContext = {
        post: { id: "P1", tier: "TIER1", status: "NOT_ACTIVE" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "P1", kind: "SHIFT_START", payload: { postActive: false } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx2)).toThrow(InvalidTransitionError);
    });

    it("handles CHECKIN_ACCEPTED guardId from actorId when missing in payload", () => {
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "VACANT_ALERT" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "CHECKIN_ACCEPTED", actorId: 77, payload: {} },
        siteMode: "NORMAL",
        now: baseTime
      };
      const res = evaluateTransition(ctx);
      expect(res.toStatus).toBe("OCCUPIED");
    });

    it("rejects CHECKIN_ACCEPTED without guardId or actorId", () => {
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "VACANT_ALERT" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "CHECKIN_ACCEPTED", payload: {} },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx)).toThrow(InvalidTransitionError);
    });

    it("rejects CHECKIN_ACCEPTED on VACANT_PLANNED / COVERED_BY_PAIR without guardId", () => {
      const ctx1: TransitionContext = {
        post: { id: "P2", tier: "TIER2", status: "VACANT_PLANNED" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "P2", kind: "CHECKIN_ACCEPTED", payload: {} },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx1)).toThrow(InvalidTransitionError);

      const ctx2: TransitionContext = {
        post: { id: "P2", tier: "TIER2", status: "COVERED_BY_PAIR" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "P2", kind: "CHECKIN_ACCEPTED", payload: {} },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx2)).toThrow(InvalidTransitionError);
    });

    it("rejects CHECKIN_ACCEPTED when LegalGuard check fails (from extra or payload)", () => {
      const ctx1: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "VACANT_ALERT" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "CHECKIN_ACCEPTED", payload: { guardId: 5, legalGuardOk: false } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx1)).toThrow(InvalidTransitionError);

      const ctx2: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "VACANT_ALERT" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "CHECKIN_ACCEPTED", payload: { guardId: 5 } },
        siteMode: "NORMAL",
        now: baseTime,
        extra: { legalGuardOk: false }
      };
      expect(() => evaluateTransition(ctx2)).toThrow(InvalidTransitionError);
    });

    it("evaluates MEAL_WINDOW_OPEN breakPlanExists logic", () => {
      // Missing plan
      const ctx1: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "OCCUPIED" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "MEAL_WINDOW_OPEN", payload: { breakPlanExists: false } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx1)).toThrow(InvalidTransitionError);

      // Present via floatId
      const ctx2: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "OCCUPIED" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "MEAL_WINDOW_OPEN", payload: { floatId: 88 } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(evaluateTransition(ctx2).toStatus).toBe("HANDOVER_PENDING");
    });

    it("evaluates FLOAT_CHECKIN floatId from actorId or payload", () => {
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "HANDOVER_PENDING" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "FLOAT_CHECKIN", actorId: 44, payload: { plannedFloatId: 44 } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(evaluateTransition(ctx).toStatus).toBe("RELIEVED_FOR_MEAL");
    });

    it("rejects FLOAT_CHECKIN if float guard does not match planned float", () => {
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "HANDOVER_PENDING" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "FLOAT_CHECKIN", payload: { floatId: 99, plannedFloatId: 44 } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx)).toThrow(InvalidTransitionError);
    });

    it("evaluates HANDOVER_TIMEOUT with now >= deadline", () => {
      const pastDeadline = new Date(baseTime.getTime() - 10000);
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "HANDOVER_PENDING", deadlineAt: pastDeadline },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "HANDOVER_TIMEOUT", payload: {} },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(evaluateTransition(ctx).toStatus).toBe("VACANT_ALERT");
    });

    it("rejects HANDOVER_TIMEOUT if now < deadline and force is false", () => {
      const futureDeadline = new Date(baseTime.getTime() + 10 * 60 * 1000);
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "HANDOVER_PENDING", deadlineAt: futureDeadline },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "HANDOVER_TIMEOUT", payload: { forceTimeout: false } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx)).toThrow(InvalidTransitionError);
    });

    it("evaluates ORIGINAL_BACK with matching guard", () => {
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "RELIEVED_FOR_MEAL", guardId: 10 },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "ORIGINAL_BACK", actorId: 10, payload: {} },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(evaluateTransition(ctx).toStatus).toBe("OCCUPIED");
    });

    it("rejects ORIGINAL_BACK if returning guard does not match original guard", () => {
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "RELIEVED_FOR_MEAL", guardId: 10 },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "ORIGINAL_BACK", payload: { guardId: 99, originalGuardId: 10 } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx)).toThrow(InvalidTransitionError);
    });

    it("evaluates MEAL_OVERRUN with now >= deadline + tolerance", () => {
      const pastDeadline = new Date(baseTime.getTime() - 20000);
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "RELIEVED_FOR_MEAL", deadlineAt: pastDeadline },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "MEAL_OVERRUN", payload: { toleranceSec: 10 } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(evaluateTransition(ctx).toStatus).toBe("RELIEVED_FOR_MEAL");
    });

    it("rejects MEAL_OVERRUN if deadline + tolerance not reached yet", () => {
      const futureDeadline = new Date(baseTime.getTime() + 5000);
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "RELIEVED_FOR_MEAL", deadlineAt: futureDeadline },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "MEAL_OVERRUN", payload: { toleranceSec: 60 } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx)).toThrow(InvalidTransitionError);
    });

    it("evaluates QR_CONFIRMED with valid nonce from extra or payload", () => {
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "UNCERTAIN" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "QR_CONFIRMED", payload: {} },
        siteMode: "NORMAL",
        now: baseTime,
        extra: { nonceValid: true }
      };
      expect(evaluateTransition(ctx).toStatus).toBe("OCCUPIED");
    });

    it("rejects QR_CONFIRMED if nonce is invalid (from extra or payload)", () => {
      const ctx1: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "UNCERTAIN" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "QR_CONFIRMED", payload: { nonceValid: false } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx1)).toThrow(InvalidTransitionError);

      const ctx2: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "UNCERTAIN" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "QR_CONFIRMED", payload: {} },
        siteMode: "NORMAL",
        now: baseTime,
        extra: { nonceValid: false }
      };
      expect(() => evaluateTransition(ctx2)).toThrow(InvalidTransitionError);
    });

    it("evaluates ESCALATE_TIMEOUT with vacantSeconds in extra", () => {
      const pastDeadline = new Date(baseTime.getTime() - 1000);
      const ctx: TransitionContext = {
        post: { id: "G2", tier: "TIER2", status: "UNCERTAIN", deadlineAt: pastDeadline, maxVacantSec: 900 },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G2", kind: "ESCALATE_TIMEOUT", payload: {} },
        siteMode: "NORMAL",
        now: baseTime,
        extra: { vacantSeconds: 1000 }
      };
      expect(evaluateTransition(ctx).toStatus).toBe("VACANT_ALERT");
    });

    it("evaluates post transition with explicit simTs on event", () => {
      const customTime = new Date("2026-10-23T14:00:00.000Z");
      const out = service.evaluatePostTransition(
        { id: "G1", tier: "TIER1", status: "NOT_ACTIVE" },
        { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "SHIFT_START", simTs: customTime.toISOString(), payload: {} }
      );
      expect(out.toStatus).toBe("VACANT_ALERT");
    });

    it("evaluates ESCALATE_TIMEOUT when now >= deadline", () => {
      const pastDeadline = new Date(baseTime.getTime() - 1000);
      const ctx1: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "UNCERTAIN", deadlineAt: pastDeadline },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "ESCALATE_TIMEOUT", payload: {} },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(evaluateTransition(ctx1).toStatus).toBe("VACANT_ALERT");

      const ctx2: TransitionContext = {
        post: { id: "G2", tier: "TIER2", status: "UNCERTAIN", deadlineAt: pastDeadline, maxVacantSec: 900 },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G2", kind: "ESCALATE_TIMEOUT", payload: { vacantSeconds: 1000 } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(evaluateTransition(ctx2).toStatus).toBe("VACANT_ALERT");
    });

    it("rejects ESCALATE_TIMEOUT for Tier 1 if deadline not reached", () => {
      const futureDeadline = new Date(baseTime.getTime() + 60000);
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "UNCERTAIN", deadlineAt: futureDeadline },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "ESCALATE_TIMEOUT", payload: { force: false } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx)).toThrow(InvalidTransitionError);
    });

    it("rejects ESCALATE_TIMEOUT for Tier 2 if max_vacant_sec not reached", () => {
      const futureDeadline = new Date(baseTime.getTime() + 60000);
      const ctx: TransitionContext = {
        post: { id: "G2", tier: "TIER2", status: "UNCERTAIN", deadlineAt: futureDeadline, maxVacantSec: 900 },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G2", kind: "ESCALATE_TIMEOUT", payload: { force: false, vacantSeconds: 100 } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx)).toThrow(InvalidTransitionError);
    });

    it("rejects REPLACEMENT_ASSIGNED when LegalGuard check fails", () => {
      const ctx1: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "VACANT_ALERT" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "REPLACEMENT_ASSIGNED", payload: { legalGuardOk: false } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx1)).toThrow(InvalidTransitionError);

      const ctx2: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "VACANT_ALERT" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "REPLACEMENT_ASSIGNED", payload: {} },
        siteMode: "NORMAL",
        now: baseTime,
        extra: { legalGuardOk: false }
      };
      expect(() => evaluateTransition(ctx2)).toThrow(InvalidTransitionError);
    });

    it("evaluates MERGE_WITH_PAIR with extra pairPostStatus or undefined", () => {
      // 1. Success with extra.pairPostStatus = OCCUPIED
      const ctx1: TransitionContext = {
        post: { id: "P2", tier: "TIER2", status: "VACANT_ALERT", pairWith: ["P3"] },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "P2", kind: "MERGE_WITH_PAIR", payload: {} },
        siteMode: "NORMAL",
        now: baseTime,
        extra: { pairPostStatus: "OCCUPIED" }
      };
      expect(evaluateTransition(ctx1).toStatus).toBe("COVERED_BY_PAIR");

      // 2. Failure with extra.pairPostStatus = UNCERTAIN
      const ctx2: TransitionContext = {
        post: { id: "P2", tier: "TIER2", status: "VACANT_ALERT", pairWith: ["P3"] },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "P2", kind: "MERGE_WITH_PAIR", payload: {} },
        siteMode: "NORMAL",
        now: baseTime,
        extra: { pairPostStatus: "UNCERTAIN" }
      };
      expect(() => evaluateTransition(ctx2)).toThrow(InvalidTransitionError);

      // 3. Success when pairPostStatus is undefined
      const ctx3: TransitionContext = {
        post: { id: "P2", tier: "TIER2", status: "VACANT_ALERT", pairWith: ["P3"] },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "P2", kind: "MERGE_WITH_PAIR", payload: {} },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(evaluateTransition(ctx3).toStatus).toBe("COVERED_BY_PAIR");
    });

    it("evaluates ESCALATE_TIMEOUT when deadlineAt is null", () => {
      // Tier 1 without deadlineAt
      const ctxT1: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "UNCERTAIN", deadlineAt: null },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "ESCALATE_TIMEOUT", payload: {} },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(evaluateTransition(ctxT1).toStatus).toBe("VACANT_ALERT");

      // Tier 2 without deadlineAt
      const ctxT2: TransitionContext = {
        post: { id: "P2", tier: "TIER2", status: "UNCERTAIN", deadlineAt: null, maxVacantSec: 900 },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "P2", kind: "ESCALATE_TIMEOUT", payload: { vacantSeconds: 50 } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(evaluateTransition(ctxT2).toStatus).toBe("VACANT_ALERT");
    });

    it("rejects MERGE_WITH_PAIR if pair post is not OCCUPIED", () => {
      const ctx: TransitionContext = {
        post: { id: "P2", tier: "TIER2", status: "VACANT_ALERT", pairWith: ["P3"] },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "P2", kind: "MERGE_WITH_PAIR", payload: { pairPostStatus: "VACANT_ALERT" } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx)).toThrow(InvalidTransitionError);
    });
  });

  describe("4. Tier 1 Zero-Vacancy Invariant Checks", () => {
    it("strictly forbids ACCEPT_PLANNED_GAP on Tier 1 posts", () => {
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "VACANT_ALERT" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "ACCEPT_PLANNED_GAP", payload: {} },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx)).toThrow(Tier1InvariantError);
    });

    it("strictly forbids MERGE_WITH_PAIR on Tier 1 posts", () => {
      const ctx: TransitionContext = {
        post: { id: "G4", tier: "TIER1", status: "VACANT_ALERT", pairWith: ["G3"] },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G4", kind: "MERGE_WITH_PAIR", payload: { pairPostStatus: "OCCUPIED" } },
        siteMode: "NORMAL",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx)).toThrow(Tier1InvariantError);
    });
  });

  describe("5. Emergency Mode & Site-wide Transitions", () => {
    it("suspends per-post transitions while site is in EMERGENCY mode (except SHIFT_END)", () => {
      const ctx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "OCCUPIED" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "PRESENCE_UNCERTAIN", payload: {} },
        siteMode: "EMERGENCY",
        now: baseTime
      };
      expect(() => evaluateTransition(ctx)).toThrow(InvalidTransitionError);

      // SHIFT_END is permitted during EMERGENCY
      const shiftEndCtx: TransitionContext = {
        post: { id: "G1", tier: "TIER1", status: "OCCUPIED" },
        event: { siteId: "AEON_THANH_KHE_F1", postId: "G1", kind: "SHIFT_END", payload: {} },
        siteMode: "EMERGENCY",
        now: baseTime
      };
      expect(evaluateTransition(shiftEndCtx).toStatus).toBe("NOT_ACTIVE");
    });

    it("evaluates FIRE_ALARM to EMERGENCY mode", () => {
      const out = service.evaluateSiteTransition(
        { site_id: "AEON_THANH_KHE_F1", mode: "NORMAL", version: 1, since: baseTime },
        { siteId: "AEON_THANH_KHE_F1", kind: "FIRE_ALARM", payload: { location: "Zone 1" } }
      );
      expect(out.siteMode).toBe("EMERGENCY");
      expect(out.topic).toBe("emergency.started");
    });

    it("evaluates EMERGENCY_CLEARED back to NORMAL mode", () => {
      const out = service.evaluateSiteTransition(
        { site_id: "AEON_THANH_KHE_F1", mode: "EMERGENCY", version: 2, since: baseTime },
        { siteId: "AEON_THANH_KHE_F1", kind: "EMERGENCY_CLEARED", payload: {} }
      );
      expect(out.siteMode).toBe("NORMAL");
      expect(out.topic).toBe("emergency.cleared");
    });

    it("rejects invalid site event kind", () => {
      expect(() =>
        service.evaluateSiteTransition(
          { site_id: "AEON_THANH_KHE_F1", mode: "NORMAL", version: 1, since: baseTime },
          { siteId: "AEON_THANH_KHE_F1", kind: "SHIFT_START", payload: {} }
        )
      ).toThrow(InvalidTransitionError);
    });
  });

  describe("6. Two-Way Handshake Lock for Guard Break Start", () => {
    it("allows break when status is RELIEVED_FOR_MEAL", () => {
      const check = service.canStartBreak({
        post_id: "G1",
        status: "RELIEVED_FOR_MEAL",
        guard_id: 10,
        since: baseTime,
        deadline_at: null,
        version: 1
      });
      expect(check.allowed).toBe(true);
    });

    it("allows break when status is HANDOVER_PENDING and float checkin accepted", () => {
      const check = service.canStartBreak(
        {
          post_id: "G1",
          status: "HANDOVER_PENDING",
          guard_id: 10,
          since: baseTime,
          deadline_at: null,
          version: 1
        },
        { floatCheckinAccepted: true }
      );
      expect(check.allowed).toBe(true);
    });

    it("rejects break when status is OCCUPIED", () => {
      const check = service.canStartBreak({
        post_id: "G1",
        status: "OCCUPIED",
        guard_id: 10,
        since: baseTime,
        deadline_at: null,
        version: 1
      });
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("Handshake requires RELIEVED_FOR_MEAL");
    });

    it("rejects break when status is HANDOVER_PENDING without float checkin", () => {
      const check = service.canStartBreak({
        post_id: "G1",
        status: "HANDOVER_PENDING",
        guard_id: 10,
        since: baseTime,
        deadline_at: null,
        version: 1
      });
      expect(check.allowed).toBe(false);
    });
  });

  describe("7. Custom Error Classes", () => {
    it("instantiates OptimisticLockError properly", () => {
      const err = new OptimisticLockError("G1", 3);
      expect(err.name).toBe("OptimisticLockError");
      expect(err.postId).toBe("G1");
      expect(err.expectedVersion).toBe(3);
    });

    it("instantiates Tier1InvariantError properly with and without custom details", () => {
      const errDefault = new Tier1InvariantError("G1", "VACANT_PLANNED");
      expect(errDefault.name).toBe("Tier1InvariantError");
      expect(errDefault.postId).toBe("G1");
      expect(errDefault.attemptedStatus).toBe("VACANT_PLANNED");

      const errCustom = new Tier1InvariantError("G1", "COVERED_BY_PAIR", "Special reason");
      expect(errCustom.message).toContain("Special reason");
    });

    it("instantiates InvalidTransitionError with and without reason", () => {
      const errNoReason = new InvalidTransitionError("NOT_ACTIVE", "SHIFT_END");
      expect(errNoReason.reason).toBe("Transition not allowed by state machine table");

      const errWithReason = new InvalidTransitionError("NOT_ACTIVE", "SHIFT_START", "Custom reason");
      expect(errWithReason.reason).toBe("Custom reason");
    });
  });
});
