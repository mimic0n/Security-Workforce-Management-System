import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards
} from "@nestjs/common";
import { GuardsService } from "./guards.service.js";
import { JwtAuthGuard } from "../../core/auth/jwt-auth.guard.js";
import { RolesGuard } from "../../core/auth/roles.guard.js";
import { Roles } from "../../core/auth/roles.decorator.js";
import {
  CreateCertificationSchema,
  CreateDeviceSchema,
  CreateGuardSchema,
  UpdateGuardSchema
} from "@swms/contracts";

@Controller("guards")
@UseGuards(JwtAuthGuard, RolesGuard)
export class GuardsController {
  constructor(@Inject(GuardsService) private readonly guardsService: GuardsService) {}

  @Get()
  @Roles("ADMIN", "HR", "MANAGER", "DISPATCHER", "SUPERVISOR")
  async findAll(@Query("role") role?: string, @Query("active") active?: string) {
    const isActive = active !== undefined ? active === "true" : undefined;
    return this.guardsService.findAll(role, isActive);
  }

  @Get(":id")
  @Roles("ADMIN", "HR", "MANAGER", "DISPATCHER", "SUPERVISOR", "GUARD", "FLOAT")
  async findOne(@Param("id", ParseIntPipe) id: number) {
    return this.guardsService.findOne(id);
  }

  @Post()
  @Roles("ADMIN", "HR")
  async create(@Body() body: any) {
    const dto = CreateGuardSchema.parse(body);
    return this.guardsService.create(dto);
  }

  @Patch(":id")
  @Roles("ADMIN", "HR", "MANAGER")
  async update(@Param("id", ParseIntPipe) id: number, @Body() body: any) {
    const dto = UpdateGuardSchema.parse(body);
    return this.guardsService.update(id, dto);
  }

  @Post(":id/certifications")
  @Roles("ADMIN", "HR")
  async addCertification(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: any
  ) {
    const dto = CreateCertificationSchema.parse({ ...body, guard_id: id });
    return this.guardsService.addCertification(id, dto);
  }

  @Post(":id/devices")
  @Roles("ADMIN", "HR")
  async addDevice(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: any
  ) {
    const dto = CreateDeviceSchema.parse({ ...body, guard_id: id });
    return this.guardsService.addDevice(id, dto);
  }
}
