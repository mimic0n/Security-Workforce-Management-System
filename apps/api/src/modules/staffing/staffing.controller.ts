import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  UseGuards
} from "@nestjs/common";
import { StaffingService } from "./staffing.service.js";
import { JwtAuthGuard } from "../../core/auth/jwt-auth.guard.js";
import { RolesGuard } from "../../core/auth/roles.guard.js";
import { Roles } from "../../core/auth/roles.decorator.js";
import {
  StaffingSimulateSchema,
  CreateStaffingRequestSchema,
  StaffingRequestFilterSchema,
  AnnualDaysParamsSchema,
  type ShiftCode
} from "@swms/contracts";
import type { ZodSchema } from "zod";

function parseWithZod<T>(schema: ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new BadRequestException({
      type: "https://tools.ietf.org/html/rfc7807",
      title: "Validation Error",
      status: 400,
      detail: "Invalid input parameters",
      errors: result.error.errors
    });
  }
  return result.data;
}

@Controller("staffing")
@UseGuards(JwtAuthGuard, RolesGuard)
export class StaffingController {
  constructor(@Inject(StaffingService) private readonly staffingService: StaffingService) {}

  @Get("calc")
  @Roles("ADMIN", "HR", "MANAGER", "DISPATCHER", "SUPERVISOR", "FLOAT", "GUARD")
  async getStaffingCalculation(@Query("at") at?: string) {
    const atDate = at ? new Date(at) : undefined;
    return this.staffingService.calculate(undefined, atDate);
  }

  @Post("simulate")
  @HttpCode(HttpStatus.OK)
  @Roles("ADMIN", "HR", "MANAGER", "DISPATCHER", "SUPERVISOR")
  async simulateStaffing(@Body() body: any, @Query("at") at?: string) {
    const dto = parseWithZod(StaffingSimulateSchema, body);
    const atDate = at ? new Date(at) : undefined;
    return this.staffingService.calculate(dto, atDate);
  }

  @Get("requests")
  @Roles("ADMIN", "HR", "MANAGER", "DISPATCHER", "SUPERVISOR")
  async getStaffingRequests(
    @Query("shift") shift?: ShiftCode,
    @Query("status") status?: string
  ) {
    const filter = parseWithZod(StaffingRequestFilterSchema, {
      shift: shift || undefined,
      status: status || undefined
    });
    return this.staffingService.getStaffingRequests(filter);
  }

  @Post("requests")
  @HttpCode(HttpStatus.CREATED)
  @Roles("ADMIN", "HR", "MANAGER", "DISPATCHER")
  async createStaffingRequest(@Body() body: any) {
    const dto = parseWithZod(CreateStaffingRequestSchema, body);
    return this.staffingService.createStaffingRequest(dto);
  }

  @Post("compute-k")
  @HttpCode(HttpStatus.OK)
  @Roles("ADMIN", "HR", "MANAGER", "DISPATCHER", "SUPERVISOR")
  async computeK(@Body() body: any) {
    const params = parseWithZod(AnnualDaysParamsSchema, body);
    const k = this.staffingService.computeKFromAnnualDays(params);
    return { k, params };
  }
}
