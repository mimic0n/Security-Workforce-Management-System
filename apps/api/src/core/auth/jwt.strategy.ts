import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { JwtPayload } from "./jwt-payload.interface.js";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || "swms-super-secret-key-123456789"
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    return {
      sub: payload.sub,
      username: payload.username,
      role: payload.role,
      guard_id: payload.guard_id
    };
  }
}
