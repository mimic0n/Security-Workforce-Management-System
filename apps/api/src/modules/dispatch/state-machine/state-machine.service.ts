import { Injectable, Inject } from "@nestjs/common";
import {
  PostStatus,
  SiteMode,
  StateTransitionEvent,
  PostStateRecord,
  SiteStateRecord,
  Clock
} from "@swms/contracts";
import { CLOCK_TOKEN } from "../../../core/clock/clock.interface.js";
import {
  evaluateTransition,
  TransitionContext,
  TransitionRule,
  PostContext
} from "./transitions.js";
import { InvalidTransitionError } from "./invalid-transition.error.js";

export interface EvaluatedTransitionOutput {
  siteId: string;
  postId?: string | null;
  fromStatus?: PostStatus | null;
  toStatus?: PostStatus | null;
  guardId?: number | null;
  deadlineAt?: Date | null;
  topic: string;
  rule?: TransitionRule;
  siteMode?: SiteMode;
  payload: Record<string, any>;
}

@Injectable()
export class StateMachineService {
  constructor(@Inject(CLOCK_TOKEN) private readonly clock: Clock) {}

  /**
   * Evaluate a post transition given the current post state, post context, and incoming event.
   */
  evaluatePostTransition(
    post: PostContext,
    event: StateTransitionEvent,
    siteMode: SiteMode = "NORMAL",
    extra?: TransitionContext["extra"]
  ): EvaluatedTransitionOutput {
    const now = event.simTs ? new Date(event.simTs) : this.clock.now();

    const ctx: TransitionContext = {
      post,
      event,
      siteMode,
      now,
      extra
    };

    const { toStatus, rule } = evaluateTransition(ctx);

    let nextGuardId: number | null | undefined = post.guardId;
    let nextDeadlineAt: Date | null | undefined = null;

    switch (event.kind) {
      case "SHIFT_START":
        nextGuardId = null;
        nextDeadlineAt = event.payload?.deadlineAt
          ? new Date(event.payload.deadlineAt)
          : null;
        break;

      case "CHECKIN_ACCEPTED":
        nextGuardId = event.payload?.guardId ?? event.actorId;
        nextDeadlineAt = null;
        break;

      case "MEAL_WINDOW_OPEN": {
        // Original guard remains guard_id; deadline set for handover buffer from config/payload
        const bufferMin =
          event.payload?.handoverBufferMin ??
          extra?.config?.handoverBufferMin ??
          5;
        nextDeadlineAt = event.payload?.deadlineAt
          ? new Date(event.payload.deadlineAt)
          : new Date(now.getTime() + bufferMin * 60 * 1000);
        break;
      }

      case "FLOAT_CHECKIN": {
        // Post relieved for meal; deadline set for slot end from config/payload
        const breakMins =
          event.payload?.breakMinutes ??
          extra?.config?.breakMinutes ??
          30;
        nextDeadlineAt = event.payload?.deadlineAt
          ? new Date(event.payload.deadlineAt)
          : new Date(now.getTime() + breakMins * 60 * 1000);
        break;
      }

      case "HANDOVER_TIMEOUT":
      case "ABSENCE_REPORTED":
      case "ESCALATE_TIMEOUT":
        nextGuardId = null;
        nextDeadlineAt = null;
        break;

      case "ORIGINAL_BACK":
        nextGuardId = event.payload?.originalGuardId ?? event.payload?.guardId ?? post.guardId;
        nextDeadlineAt = null;
        break;

      case "MEAL_OVERRUN":
        // Self-transition warning; preserve guard_id and deadline
        nextGuardId = post.guardId;
        nextDeadlineAt = post.deadlineAt;
        break;

      case "PRESENCE_UNCERTAIN": {
        // Set escalate deadline (configured attendance.tier1_escalate_after_sec or max_vacant_sec)
        const escalateSec =
          event.payload?.escalateAfterSec ??
          (post.tier === "TIER1"
            ? (extra?.config?.tier1EscalateSec ?? 120)
            : (post.maxVacantSec ?? extra?.config?.maxVacantSec ?? 900));
        nextDeadlineAt = event.payload?.deadlineAt
          ? new Date(event.payload.deadlineAt)
          : new Date(now.getTime() + escalateSec * 1000);
        break;
      }

      case "QR_CONFIRMED":
        nextDeadlineAt = null;
        break;

      case "REPLACEMENT_ASSIGNED":
        // Stays VACANT_ALERT; deadline set for check-in ack/timeout
        nextDeadlineAt = event.payload?.deadlineAt
          ? new Date(event.payload.deadlineAt)
          : null;
        break;

      case "ACCEPT_PLANNED_GAP":
        nextGuardId = null;
        nextDeadlineAt = null;
        break;

      case "MERGE_WITH_PAIR":
        nextGuardId = event.payload?.pairGuardId ?? event.payload?.guardId ?? null;
        nextDeadlineAt = null;
        break;

      case "SHIFT_END":
        nextGuardId = null;
        nextDeadlineAt = null;
        break;
    }

    return {
      siteId: event.siteId,
      postId: post.id,
      fromStatus: post.status,
      toStatus,
      guardId: nextGuardId,
      deadlineAt: nextDeadlineAt,
      topic: rule.topic,
      rule,
      payload: {
        siteId: event.siteId,
        postId: post.id,
        fromStatus: post.status,
        toStatus,
        guardId: nextGuardId,
        deadlineAt: nextDeadlineAt ? nextDeadlineAt.toISOString() : null,
        cause: event.kind,
        details: event.payload
      }
    };
  }

  /**
   * Evaluate a site-wide emergency transition (FIRE_ALARM / EMERGENCY_CLEARED).
   */
  evaluateSiteTransition(
    currentSite: SiteStateRecord,
    event: StateTransitionEvent
  ): EvaluatedTransitionOutput {
    if (event.kind === "FIRE_ALARM") {
      return {
        siteId: currentSite.site_id,
        postId: null,
        fromStatus: null,
        toStatus: null,
        siteMode: "EMERGENCY",
        topic: "emergency.started",
        payload: {
          siteId: currentSite.site_id,
          previousMode: currentSite.mode,
          currentMode: "EMERGENCY",
          cause: "FIRE_ALARM",
          details: event.payload
        }
      };
    }

    if (event.kind === "EMERGENCY_CLEARED") {
      return {
        siteId: currentSite.site_id,
        postId: null,
        fromStatus: null,
        toStatus: null,
        siteMode: "NORMAL",
        topic: "emergency.cleared",
        payload: {
          siteId: currentSite.site_id,
          previousMode: currentSite.mode,
          currentMode: "NORMAL",
          cause: "EMERGENCY_CLEARED",
          details: event.payload
        }
      };
    }

    throw new InvalidTransitionError(
      currentSite.mode,
      event.kind,
      `Site event '${event.kind}' is not a valid site-wide transition`
    );
  }

  /**
   * Check Two-way handshake lock for guard's "start break" action (§6.2, §12).
   * Guard's "start break" action is rejected unless post status is RELIEVED_FOR_MEAL
   * or (status HANDOVER_PENDING and float check-in accepted).
   */
  canStartBreak(
    postState: PostStateRecord,
    options?: { floatCheckinAccepted?: boolean }
  ): { allowed: boolean; reason?: string } {
    if (postState.status === "RELIEVED_FOR_MEAL") {
      return { allowed: true };
    }

    if (postState.status === "HANDOVER_PENDING" && options?.floatCheckinAccepted) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Cannot start break while post is in state '${postState.status}'. Handshake requires RELIEVED_FOR_MEAL or accepted float check-in.`
    };
  }
}
