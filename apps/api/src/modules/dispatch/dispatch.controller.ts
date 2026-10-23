import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  Inject,
  ParseIntPipe,
  BadRequestException
} from "@nestjs/common";
import { JwtAuthGuard } from "../../core/auth/jwt-auth.guard.js";
import { RolesGuard } from "../../core/auth/roles.guard.js";
import { Roles } from "../../core/auth/roles.decorator.js";
import { CurrentUser } from "../../core/auth/current-user.decorator.js";
import type { JwtPayload } from "../../core/auth/jwt-payload.interface.js";
import { DispatchService } from "./dispatch.service.js";
import {
  DispatchOverrideSchema,
  type DispatchOverrideDto,
  type DispatchOrder
} from "@swms/contracts";

@Controller("dispatch")
@UseGuards(JwtAuthGuard, RolesGuard)
export class DispatchController {
  constructor(
    @Inject(DispatchService) private readonly dispatchService: DispatchService
  ) {}

  /**
   * GET /dispatch/orders
   */
  @Get("orders")
  @Roles("ADMIN", "DISPATCHER", "MANAGER", "SUPERVISOR", "FLOAT", "GUARD")
  async getOrders(
    @Query("shiftKey") shiftKey?: string,
    @Query("status") status?: string,
    @Query("guardId") guardId?: string,
    @Query("kind") kind?: string,
    @CurrentUser() user?: JwtPayload
  ): Promise<DispatchOrder[]> {
    let effectiveGuardId = guardId ? parseInt(guardId, 10) : undefined;

    // Guards can only view orders assigned to them
    if (user?.role === "GUARD" || user?.role === "FLOAT") {
      if (user.guard_id) {
        effectiveGuardId = user.guard_id;
      }
    }

    return this.dispatchService.getOrders({
      shiftKey,
      status,
      guardId: effectiveGuardId,
      kind
    });
  }

  /**
   * POST /dispatch/orders/:id/ack
   */
  @Post("orders/:id/ack")
  @Roles("ADMIN", "DISPATCHER", "SUPERVISOR", "FLOAT", "GUARD")
  async ackOrder(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUser() user?: JwtPayload
  ): Promise<DispatchOrder> {
    const guardId = user?.guard_id || undefined;
    return this.dispatchService.ackOrder(id, guardId);
  }

  /**
   * POST /dispatch/orders/:id/decline
   */
  @Post("orders/:id/decline")
  @Roles("ADMIN", "DISPATCHER", "SUPERVISOR", "FLOAT", "GUARD")
  async declineOrder(
    @Param("id", ParseIntPipe) id: number,
    @Body("reason") reason?: string
  ): Promise<DispatchOrder> {
    return this.dispatchService.declineOrder(id, reason);
  }

  /**
   * POST /dispatch/override (dispatcher only)
   */
  @Post("override")
  @Roles("ADMIN", "DISPATCHER", "MANAGER")
  async overrideDispatch(
    @Body() body: unknown,
    @CurrentUser() user?: JwtPayload
  ): Promise<DispatchOrder> {
    const parsed = DispatchOverrideSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        title: "Validation Error",
        status: 400,
        errors: parsed.error.errors
      });
    }

    return this.dispatchService.overrideDispatch(parsed.data, user?.sub);
  }
}
