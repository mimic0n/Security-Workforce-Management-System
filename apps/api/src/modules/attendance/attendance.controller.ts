import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException
} from "@nestjs/common";
import {
  AttendanceCheckRequestSchema,
  AttendanceCheckRequest,
  AttendanceNonceRequestSchema,
  AttendanceNonceRequest,
  AttendancePingRequestSchema,
  AttendancePingRequest
} from "@swms/contracts";
import { JwtAuthGuard } from "../../core/auth/jwt-auth.guard.js";
import { RolesGuard } from "../../core/auth/roles.guard.js";
import { CurrentUser } from "../../core/auth/current-user.decorator.js";
import type { AuthUserPayload } from "@swms/contracts";
import { AttendanceService } from "./attendance.service.js";
import { PresenceMonitorService } from "./presence-monitor.service.js";

@Controller("attendance")
export class AttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly presenceMonitor: PresenceMonitorService
  ) {}

  /**
   * POST /attendance/nonce
   * Issues a short-lived single-use nonce for attendance verification.
   */
  @Post("nonce")
  @HttpCode(HttpStatus.OK)
  async getNonce(
    @Body() body: unknown,
    @CurrentUser() user?: AuthUserPayload
  ) {
    const parseRes = AttendanceNonceRequestSchema.safeParse(body);
    if (!parseRes.success) {
      throw new BadRequestException(parseRes.error.issues);
    }

    const dto: AttendanceNonceRequest = parseRes.data;
    const guardId = user?.guard_id ?? dto.guardId;

    if (!guardId) {
      throw new BadRequestException("Guard ID must be provided or derived from user token");
    }

    return this.attendanceService.createNonce({
      postId: dto.postId,
      guardId,
      deviceUid: dto.deviceUid
    });
  }

  /**
   * POST /attendance/check
   * Verifies check-in, check-out, or QR confirmation.
   */
  @Post("check")
  @HttpCode(HttpStatus.OK)
  async checkAttendance(
    @Body() body: unknown,
    @CurrentUser() user?: AuthUserPayload
  ) {
    const parseRes = AttendanceCheckRequestSchema.safeParse(body);
    if (!parseRes.success) {
      throw new BadRequestException(parseRes.error.issues);
    }

    const dto: AttendanceCheckRequest = parseRes.data;
    const authGuardId = user?.role === "GUARD" || user?.role === "FLOAT" ? user.guard_id : undefined;

    return this.attendanceService.checkAttendance(dto, authGuardId);
  }

  /**
   * POST /attendance/ping
   * GPS stream sample / presence ping for debounce filtering.
   */
  @Post("ping")
  @HttpCode(HttpStatus.OK)
  async pingPresence(@Body() body: unknown) {
    const parseRes = AttendancePingRequestSchema.safeParse(body);
    if (!parseRes.success) {
      throw new BadRequestException(parseRes.error.issues);
    }

    const dto: AttendancePingRequest = parseRes.data;
    const timestamp = dto.timestamp ? new Date(dto.timestamp) : undefined;

    return this.presenceMonitor.processPing({
      guardId: dto.guardId,
      postId: dto.postId,
      lat: dto.lat,
      lon: dto.lon,
      accuracy_m: dto.accuracy_m,
      timestamp
    });
  }
}
