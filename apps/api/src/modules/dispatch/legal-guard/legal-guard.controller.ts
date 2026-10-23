import {
  Controller,
  Post,
  Body,
  UseGuards,
  Inject,
  BadRequestException
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../core/auth/jwt-auth.guard.js";
import { RolesGuard } from "../../../core/auth/roles.guard.js";
import { Roles } from "../../../core/auth/roles.decorator.js";
import { LegalGuardService } from "./legal-guard.service.js";

@Controller("dispatch/legal-guard")
@UseGuards(JwtAuthGuard, RolesGuard)
export class LegalGuardController {
  constructor(
    @Inject(LegalGuardService) private readonly legalGuardService: LegalGuardService
  ) {}

  @Post("validate")
  @Roles("ADMIN", "MANAGER", "DISPATCHER")
  async validateCandidate(
    @Body()
    body: {
      guardId: number;
      startTime: string;
      endTime: string;
      isOvertime?: boolean;
    }
  ) {
    if (!body.guardId || !body.startTime || !body.endTime) {
      throw new BadRequestException("guardId, startTime and endTime are required");
    }

    const candidate = {
      guardId: Number(body.guardId),
      startTime: new Date(body.startTime),
      endTime: new Date(body.endTime),
      isOvertime: Boolean(body.isOvertime)
    };

    return this.legalGuardService.validate(candidate);
  }

  @Post("cost")
  @Roles("ADMIN", "MANAGER", "DISPATCHER")
  async estimateCost(
    @Body()
    body: {
      startTime: string;
      endTime: string;
      isOvertime?: boolean;
      baseHourlyRate?: number;
    }
  ) {
    if (!body.startTime || !body.endTime) {
      throw new BadRequestException("startTime and endTime are required");
    }

    return this.legalGuardService.estimateCost({
      startTime: new Date(body.startTime),
      endTime: new Date(body.endTime),
      isOvertime: Boolean(body.isOvertime),
      baseHourlyRate: body.baseHourlyRate ? Number(body.baseHourlyRate) : undefined
    });
  }
}
