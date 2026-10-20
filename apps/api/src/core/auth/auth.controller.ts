import { Body, Controller, Get, Inject, Post, UseGuards } from "@nestjs/common";
import { AuthService } from "./auth.service.js";
import { LoginRequestSchema } from "@swms/contracts";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { CurrentUser } from "./current-user.decorator.js";
import { JwtPayload } from "./jwt-payload.interface.js";

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post("login")
  async login(@Body() body: any) {
    const valid = LoginRequestSchema.parse(body);
    return this.authService.login(valid);
  }

  @Post("refresh")
  async refresh(@Body("refreshToken") refreshToken: string) {
    return this.authService.refresh(refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @Get("me")
  async me(@CurrentUser() user: JwtPayload) {
    return this.authService.getMe(user.sub);
  }
}
