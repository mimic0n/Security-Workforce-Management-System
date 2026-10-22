import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards
} from "@nestjs/common";
import { PoliciesService } from "./policies.service.js";
import { JwtAuthGuard } from "../../core/auth/jwt-auth.guard.js";
import { RolesGuard } from "../../core/auth/roles.guard.js";
import { Roles } from "../../core/auth/roles.decorator.js";
import { CurrentUser } from "../../core/auth/current-user.decorator.js";
import { UpdatePolicySchema, PolicyPreviewSchema } from "@swms/contracts";

@Controller("policies")
@UseGuards(JwtAuthGuard, RolesGuard)
export class PoliciesController {
  constructor(@Inject(PoliciesService) private readonly policiesService: PoliciesService) {}

  @Get()
  @Roles("ADMIN", "HR", "MANAGER", "DISPATCHER", "SUPERVISOR", "FLOAT", "GUARD")
  async getAll(@Query("at") at?: string) {
    const atDate = at ? new Date(at) : undefined;
    return this.policiesService.getAll(atDate);
  }

  @Get(":key")
  @Roles("ADMIN", "HR", "MANAGER", "DISPATCHER", "SUPERVISOR", "FLOAT", "GUARD")
  async getOne(@Param("key") key: string, @Query("at") at?: string) {
    const atDate = at ? new Date(at) : undefined;
    return this.policiesService.get(key, atDate);
  }

  @Put(":key")
  @Roles("ADMIN", "MANAGER")
  async update(
    @Param("key") key: string,
    @Body() body: any,
    @CurrentUser("sub") userId: number
  ) {
    const dto = UpdatePolicySchema.parse(body);
    return this.policiesService.update(key, dto, userId);
  }

  @Post("preview")
  @HttpCode(HttpStatus.OK)
  @Roles("ADMIN", "HR", "MANAGER", "DISPATCHER")
  async preview(@Body() body: any, @Query("at") at?: string) {
    const dto = PolicyPreviewSchema.parse(body);
    const atDate = at ? new Date(at) : undefined;
    return this.policiesService.preview(dto, atDate);
  }
}
