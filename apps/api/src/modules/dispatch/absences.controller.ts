import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Headers,
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
import { AbsencesService } from "./absences.service.js";
import {
  CreateAbsenceSchema,
  AbsenceDecisionSchema,
  type CreateAbsenceDto,
  type AbsenceDecisionDto
} from "@swms/contracts";

@Controller("absences")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AbsencesController {
  constructor(
    @Inject(AbsencesService) private readonly absencesService: AbsencesService
  ) {}

  /**
   * POST /absences (with Idempotency-Key header support)
   */
  @Post()
  @Roles("ADMIN", "DISPATCHER", "MANAGER", "SUPERVISOR", "FLOAT", "GUARD")
  async createAbsence(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey?: string,
    @CurrentUser() user?: JwtPayload
  ) {
    const parsed = CreateAbsenceSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        title: "Validation Error",
        status: 400,
        errors: parsed.error.errors
      });
    }

    const dto = parsed.data;

    // Guards can only report absences for themselves
    if (user?.role === "GUARD" || user?.role === "FLOAT") {
      if (user.guard_id && user.guard_id !== dto.guardId) {
        throw new BadRequestException(`Guards can only report absences for themselves`);
      }
    }

    return this.absencesService.createAbsence(dto, idempotencyKey);
  }

  /**
   * GET /absences
   */
  @Get()
  @Roles("ADMIN", "DISPATCHER", "MANAGER", "SUPERVISOR", "FLOAT", "GUARD")
  async getAbsences(
    @Query("guardId") guardId?: string,
    @Query("forShift") forShift?: string,
    @Query("forDate") forDate?: string,
    @Query("status") status?: string,
    @CurrentUser() user?: JwtPayload
  ) {
    let effectiveGuardId = guardId ? parseInt(guardId, 10) : undefined;
    if (user?.role === "GUARD" || user?.role === "FLOAT") {
      if (user.guard_id) effectiveGuardId = user.guard_id;
    }

    return this.absencesService.getAbsences({
      guardId: effectiveGuardId,
      forShift,
      forDate,
      status
    });
  }

  /**
   * POST /absences/:id/decision
   */
  @Post(":id/decision")
  @Roles("ADMIN", "DISPATCHER", "MANAGER")
  async makeDecision(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown
  ) {
    const parsed = AbsenceDecisionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        title: "Validation Error",
        status: 400,
        errors: parsed.error.errors
      });
    }

    return this.absencesService.makeDecision(id, parsed.data);
  }
}
