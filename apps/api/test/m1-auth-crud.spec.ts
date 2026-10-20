import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import { AppModule } from "../src/app.module.js";
import { AuthService } from "../src/core/auth/auth.service.js";
import { GuardsService } from "../src/modules/guards/guards.service.js";
import { PostsService } from "../src/modules/posts/posts.service.js";
import { runMigration } from "../../../db/migrate.js";
import { runSeed } from "../../../db/seed/seed.js";
import { DatabaseService } from "../src/core/database/database.service.js";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { RolesGuard } from "../src/core/auth/roles.guard.js";
import { Reflector } from "@nestjs/core";

const testDbUrl = process.env.TEST_DATABASE_URL || "postgres://grey@localhost:5432/swms_test";

describe("Milestone M1 Auth & CRUD Integration Tests", () => {
  let moduleRef: TestingModule;
  let authService: AuthService;
  let guardsService: GuardsService;
  let postsService: PostsService;
  let dbService: DatabaseService;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    await runMigration("up", testDbUrl);
    await runSeed(testDbUrl);

    moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    }).compile();
    await moduleRef.init();

    authService = moduleRef.get<AuthService>(AuthService);
    guardsService = moduleRef.get<GuardsService>(GuardsService);
    postsService = moduleRef.get<PostsService>(PostsService);
    dbService = moduleRef.get<DatabaseService>(DatabaseService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  describe("Authentication & RBAC", () => {
    it("logs in successfully with valid credentials", async () => {
      const res = await authService.login({
        username: "admin",
        password: "password123"
      });
      expect(res.accessToken).toBeDefined();
      expect(res.refreshToken).toBeDefined();
      expect(res.user.role).toBe("ADMIN");
      expect(res.user.username).toBe("admin");
    });

    it("rejects login with invalid credentials", async () => {
      await expect(
        authService.login({
          username: "admin",
          password: "wrongpassword"
        })
      ).rejects.toThrow(UnauthorizedException);
    });

    it("refreshes access token with valid refresh token", async () => {
      const loginRes = await authService.login({
        username: "dispatcher",
        password: "password123"
      });
      const refreshRes = await authService.refresh(loginRes.refreshToken);
      expect(refreshRes.accessToken).toBeDefined();
    });

    it("enforces RBAC: guards can only act on themselves", () => {
      const reflector = new Reflector();
      const rolesGuard = new RolesGuard(reflector);

      // Guard 1 trying to access guard 2
      const mockContextForbidden: any = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            user: { sub: 4, username: "guard01", role: "GUARD", guard_id: 1 },
            params: { id: "2" }
          })
        })
      };

      expect(() => rolesGuard.canActivate(mockContextForbidden)).toThrow(ForbiddenException);

      // Guard 1 accessing own ID
      const mockContextAllowed: any = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            user: { sub: 4, username: "guard01", role: "GUARD", guard_id: 1 },
            params: { id: "1" }
          })
        })
      };

      expect(rolesGuard.canActivate(mockContextAllowed)).toBe(true);
    });
  });

  describe("Guards CRUD", () => {
    let createdGuardId: number;

    it("creates a new guard with valid role", async () => {
      const newGuard = await guardsService.create({
        code: "G99",
        full_name: "Test Guard 99",
        role: "GUARD",
        active: true,
        phone: "0909999999"
      });

      expect(newGuard.id).toBeDefined();
      expect(newGuard.code).toBe("G99");
      createdGuardId = newGuard.id!;
    });

    it("fetches the created guard with certifications and devices", async () => {
      const guard = await guardsService.findOne(createdGuardId);
      expect(guard.code).toBe("G99");
      expect(Array.isArray(guard.certifications)).toBe(true);
      expect(Array.isArray(guard.devices)).toBe(true);
    });

    it("adds certification and device to the guard", async () => {
      const cert = await guardsService.addCertification(createdGuardId, {
        guard_id: createdGuardId,
        cert_no: "CERT-G99",
        issued_on: "2026-01-01",
        expires_on: "2029-01-01"
      });
      expect(cert.cert_no).toBe("CERT-G99");

      const dev = await guardsService.addDevice(createdGuardId, {
        guard_id: createdGuardId,
        device_uid: "DEV_G99",
        active: true
      });
      expect(dev.device_uid).toBe("DEV_G99");

      const updated = await guardsService.findOne(createdGuardId);
      expect(updated.certifications.length).toBe(1);
      expect(updated.devices.length).toBe(1);
    });

    it("updates guard info", async () => {
      const updated = await guardsService.update(createdGuardId, {
        phone: "0988888888"
      });
      expect(updated.phone).toBe("0988888888");
    });
  });

  describe("Posts & Rules CRUD", () => {
    it("lists all 14 posts with rules and state", async () => {
      const posts = await postsService.findAll();
      expect(posts.length).toBe(14);
      const g1 = posts.find((p) => p.id === "G1");
      expect(g1).toBeDefined();
      expect(g1.tier).toBe("TIER1");
      expect(g1.max_vacant_sec).toBe(0);
    });

    it("rejects setting max_vacant_sec > 0 on Tier 1 post via service", async () => {
      await expect(
        postsService.updateRules("G1", {
          tier: "TIER1",
          max_vacant_sec: 300
        })
      ).rejects.toThrow("Zero-Vacancy invariant");
    });

    it("allows updating max_vacant_sec on Tier 2 post", async () => {
      const updated = await postsService.updateRules("G2", {
        max_vacant_sec: 600
      });
      expect(Number(updated.max_vacant_sec)).toBe(600);
    });
  });
});
