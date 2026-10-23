import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  UseGuards,
  Inject,
  HttpCode,
  HttpStatus,
  BadRequestException
} from "@nestjs/common";
import { JwtAuthGuard } from "../../core/auth/jwt-auth.guard.js";
import { RolesGuard } from "../../core/auth/roles.guard.js";
import { Roles } from "../../core/auth/roles.decorator.js";
import { MealPlannerService } from "./meal-planner/meal-planner.service.js";

@Controller("break-plans")
@UseGuards(JwtAuthGuard, RolesGuard)
export class BreakPlansController {
  constructor(
    @Inject(MealPlannerService) private readonly mealPlannerService: MealPlannerService
  ) {}

  @Get()
  @Roles("ADMIN", "MANAGER", "DISPATCHER", "SUPERVISOR", "FLOAT", "GUARD")
  async getBreakPlans(@Query("shift") shiftKey: string) {
    if (!shiftKey) {
      throw new BadRequestException("Query parameter 'shift' is required (e.g. 2026-10-24:MORNING)");
    }
    const slots = await this.mealPlannerService.getBreakPlans(shiftKey);
    return {
      shiftKey,
      slots
    };
  }

  @Post("generate")
  @Roles("ADMIN", "MANAGER", "DISPATCHER")
  async generateBreakPlan(
    @Body()
    body: {
      shiftKey: string;
      shiftCode?: "MORNING" | "AFTERNOON" | "NIGHT";
      date?: string;
      availableFloatIds?: number[];
      scheduleJobs?: boolean;
    }
  ) {
    if (!body.shiftKey) {
      throw new BadRequestException("shiftKey is required");
    }

    const result = await this.mealPlannerService.generateAndPersistPlan(body);
    if (result.feasible && body.scheduleJobs !== false) {
      await this.mealPlannerService.scheduleSlotJobs(body.shiftKey);
    }
    return result;
  }

  @Post("replan")
  @HttpCode(HttpStatus.OK)
  @Roles("ADMIN", "MANAGER", "DISPATCHER")
  async replan(
    @Body()
    body: {
      shiftKey: string;
      shiftCode?: "MORNING" | "AFTERNOON" | "NIGHT";
      date?: string;
      availableFloatIds?: number[];
    }
  ) {
    if (!body.shiftKey) {
      throw new BadRequestException("shiftKey is required");
    }

    return this.mealPlannerService.replan(body);
  }
}
