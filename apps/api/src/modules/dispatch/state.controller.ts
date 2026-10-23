import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  Inject,
  BadRequestException
} from "@nestjs/common";
import {
  StateSnapshotResponse,
  StartBreakDtoSchema,
  StartBreakDto,
  StateTransitionEventSchema,
  StateTransitionEvent,
  TransitionResult
} from "@swms/contracts";
import { JwtAuthGuard } from "../../core/auth/jwt-auth.guard.js";
import { RolesGuard } from "../../core/auth/roles.guard.js";
import { Roles } from "../../core/auth/roles.decorator.js";
import { CurrentUser } from "../../core/auth/current-user.decorator.js";
import { DispatchService } from "./dispatch.service.js";

@Controller("state")
@UseGuards(JwtAuthGuard, RolesGuard)
export class StateController {
  constructor(
    @Inject(DispatchService) private readonly dispatchService: DispatchService
  ) {}

  /**
   * GET /state/snapshot
   * Returns current site state, post states, and monotonic lastSeq (§12)
   */
  @Get("snapshot")
  @Roles("ADMIN", "MANAGER", "DISPATCHER", "SUPERVISOR", "FLOAT", "GUARD")
  async getSnapshot(
    @Query("siteId") siteId?: string
  ): Promise<StateSnapshotResponse> {
    return this.dispatchService.getStateSnapshot(siteId);
  }

  /**
   * POST /state/break/start
   * Guard initiates meal break; enforces Two-Way Handshake Lock (§6.2, §12)
   */
  @Post("break/start")
  @Roles("GUARD", "FLOAT", "SUPERVISOR", "ADMIN")
  async startBreak(
    @Body() body: StartBreakDto,
    @CurrentUser() user: any
  ): Promise<{ allowed: boolean; message: string }> {
    const parseRes = StartBreakDtoSchema.safeParse(body);
    if (!parseRes.success) {
      throw new BadRequestException({
        title: "Validation Error",
        status: 400,
        errors: parseRes.error.errors
      });
    }

    const { guardId, postId } = parseRes.data;

    // Guard can only start break for themselves unless admin/supervisor
    if (user.role === "GUARD" && user.guard_id && user.guard_id !== guardId) {
      throw new BadRequestException({
        title: "Forbidden",
        status: 403,
        detail: "Guards can only initiate breaks for their own assigned post"
      });
    }

    const check = await this.dispatchService.canStartBreak(postId, guardId);
    if (!check.allowed) {
      throw new BadRequestException({
        title: "Handshake Lock Rejected",
        status: 400,
        detail: check.reason || "Two-way handshake lock prevents starting break at this time"
      });
    }

    return {
      allowed: true,
      message: "Meal break authorized by Two-Way Handshake Lock"
    };
  }

  /**
   * POST /state/events
   * Trigger a state transition event (Dispatch / Admin / Supervisor / Sim)
   */
  @Post("events")
  @Roles("ADMIN", "DISPATCHER", "SUPERVISOR", "GUARD")
  async processEvent(
    @Body() body: StateTransitionEvent
  ): Promise<TransitionResult> {
    const parseRes = StateTransitionEventSchema.safeParse(body);
    if (!parseRes.success) {
      throw new BadRequestException({
        title: "Invalid Event Payload",
        status: 400,
        errors: parseRes.error.errors
      });
    }

    return this.dispatchService.applyWithRetry(parseRes.data);
  }
}
