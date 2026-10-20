import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import bcrypt from "bcryptjs";
import { DatabaseService } from "../database/database.service.js";
import { LoginRequest, LoginResponse, UserRole } from "@swms/contracts";
import { JwtPayload } from "./jwt-payload.interface.js";

@Injectable()
export class AuthService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(JwtService) private readonly jwtService: JwtService
  ) {}

  async validateUser(username: string, pass: string): Promise<any> {
    const res = await this.db.query(
      `SELECT id, username, password_hash, role, guard_id 
       FROM users 
       WHERE username = $1`,
      [username]
    );

    if (res.rows.length === 0) {
      return null;
    }

    const user = res.rows[0];
    const isMatch = await bcrypt.compare(pass, user.password_hash);
    if (!isMatch) {
      return null;
    }

    return {
      id: Number(user.id),
      username: user.username,
      role: user.role as UserRole,
      guard_id: user.guard_id ? Number(user.guard_id) : null
    };
  }

  async login(loginReq: LoginRequest): Promise<LoginResponse> {
    const user = await this.validateUser(loginReq.username, loginReq.password);
    if (!user) {
      throw new UnauthorizedException("Invalid username or password");
    }

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      guard_id: user.guard_id
    };

    const accessToken = this.jwtService.sign(payload, { expiresIn: "1h" });
    const refreshToken = this.jwtService.sign(payload, { expiresIn: "7d" });

    return {
      accessToken,
      refreshToken,
      user
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string }> {
    try {
      const decoded = this.jwtService.verify<JwtPayload>(refreshToken);
      const payload: JwtPayload = {
        sub: decoded.sub,
        username: decoded.username,
        role: decoded.role,
        guard_id: decoded.guard_id
      };
      const accessToken = this.jwtService.sign(payload, { expiresIn: "1h" });
      return { accessToken };
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
  }

  async getMe(userId: number) {
    const res = await this.db.query(
      `SELECT id, username, role, guard_id, created_at 
       FROM users 
       WHERE id = $1`,
      [userId]
    );
    if (res.rows.length === 0) {
      throw new UnauthorizedException("User not found");
    }
    const u = res.rows[0];
    return {
      id: Number(u.id),
      username: u.username,
      role: u.role,
      guard_id: u.guard_id ? Number(u.guard_id) : null,
      created_at: u.created_at
    };
  }
}
