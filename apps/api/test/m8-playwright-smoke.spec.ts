import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { chromium, Browser, Page } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppModule } from "../src/app.module.js";
import { AuthService } from "../src/core/auth/auth.service.js";
import { DatabaseService } from "../src/core/database/database.service.js";
import { DispatchService } from "../src/modules/dispatch/dispatch.service.js";
import { runMigration } from "../../../db/migrate.js";
import { runSeed } from "../../../db/seed/seed.js";
import bcrypt from "bcryptjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testDbUrl = process.env.TEST_DATABASE_URL || "postgres://grey@localhost:5432/swms_test";

describe("Milestone M8 Playwright Smoke Tests — Web Dashboard & Mobile PWA (§14, §15)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let authService: AuthService;
  let db: DatabaseService;
  let dispatchService: DispatchService;
  let browser: Browser;
  let staticServer: http.Server;

  let apiPort: number;
  let apiUrl: string;
  let webPort: number;
  let webUrl: string;

  let dispatcherToken: string;
  let guard10Token: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    await runMigration("up", testDbUrl);
    await runSeed(testDbUrl);

    // 1. Start NestJS API Server
    moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableCors();
    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address();
    apiPort = typeof address === "string" ? 3000 : address.port;
    apiUrl = `http://localhost:${apiPort}`;

    authService = moduleRef.get<AuthService>(AuthService);
    db = moduleRef.get<DatabaseService>(DatabaseService);
    dispatchService = moduleRef.get<DispatchService>(DispatchService);

    // Create tokens
    const dispLogin = await authService.login({ username: "dispatcher", password: "password123" });
    dispatcherToken = dispLogin.accessToken;

    const hash = await bcrypt.hash("password123", 10);
    const guard10Res = await db.query(`SELECT id FROM users WHERE guard_id = 10;`);
    if (guard10Res.rows.length === 0) {
      await db.query(
        `INSERT INTO users (username, password_hash, role, guard_id)
         VALUES ('guard10', $1, 'GUARD', 10);`,
        [hash]
      );
    }
    const guardLogin = await authService.login({ username: "guard10", password: "password123" });
    guard10Token = guardLogin.accessToken;

    // Reset test posts to OCCUPIED
    await db.query("TRUNCATE TABLE outbox;");
    await db.query(
      `UPDATE post_state 
       SET status = 'OCCUPIED', guard_id = 1, since = clock_timestamp(), deadline_at = NULL, version = version + 1
       WHERE post_id IN ('G4', 'P1');`
    );

    // 2. Start Static Web & Mobile Server
    const webDist = path.resolve(__dirname, "../../web/dist");
    const mobileDist = path.resolve(__dirname, "../../mobile/dist");

    staticServer = http.createServer((req, res) => {
      const urlPath = req.url?.split("?")[0] || "/";
      let filePath: string;
      let contentType = "text/html";

      if (urlPath === "/mobile" || urlPath === "/mobile/") {
        filePath = path.join(mobileDist, "index.html");
      } else {
        const cleanPath = urlPath.startsWith("/") ? urlPath.slice(1) : urlPath;
        if (fs.existsSync(path.join(webDist, cleanPath)) && fs.statSync(path.join(webDist, cleanPath)).isFile()) {
          filePath = path.join(webDist, cleanPath);
        } else if (fs.existsSync(path.join(mobileDist, cleanPath)) && fs.statSync(path.join(mobileDist, cleanPath)).isFile()) {
          filePath = path.join(mobileDist, cleanPath);
        } else if (urlPath.startsWith("/mobile")) {
          filePath = path.join(mobileDist, "index.html");
        } else {
          filePath = path.join(webDist, "index.html");
        }
      }

      if (filePath.endsWith(".js")) contentType = "application/javascript";
      else if (filePath.endsWith(".css")) contentType = "text/css";
      else if (filePath.endsWith(".json")) contentType = "application/json";
      else if (filePath.endsWith(".svg")) contentType = "image/svg+xml";

      try {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    await new Promise<void>((resolve) => {
      staticServer.listen(0, () => resolve());
    });
    const staticAddr = staticServer.address();
    webPort = staticAddr && typeof staticAddr === "object" ? staticAddr.port : 5173;
    webUrl = `http://localhost:${webPort}`;

    // 3. Launch Playwright Chromium Headless
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
    if (staticServer) {
      await new Promise<void>((resolve) => staticServer.close(() => resolve()));
    }
    if (app) {
      await app.close();
    }
  });

  it("Playwright smoke: dispatcher sees post turn red (VACANT_ALERT) then green (OCCUPIED)", async () => {
    const page: Page = await browser.newPage();

    // 1. Dispatcher opens dashboard
    await page.goto(`${webUrl}/?token=${dispatcherToken}&apiUrl=${apiUrl}`);

    // Wait for post marker G4
    await page.waitForSelector('[data-testid="post-marker-G4"]', { timeout: 10000 });
    const g4Circle = page.locator('[data-testid="post-marker-G4"] circle[data-status]');

    // Verify initial green / OCCUPIED state
    expect(await g4Circle.getAttribute("data-status")).toBe("OCCUPIED");
    expect(await g4Circle.getAttribute("fill")).toBe("#22c55e");

    // 2. Trigger vacancy transition: OCCUPIED -> VACANT_ALERT
    await dispatchService.applyWithRetry({
      siteId: "AEON_THANH_KHE_F1",
      postId: "G4",
      kind: "ABSENCE_REPORTED",
      payload: { guardId: 1, reason: "Playwright test" }
    });

    // 3. Dispatcher sees post turn RED (#ef4444)
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="post-marker-G4"] circle[data-status]')
          ?.getAttribute("data-status") === "VACANT_ALERT",
      { timeout: 10000 }
    );
    expect(await g4Circle.getAttribute("fill")).toBe("#ef4444");

    // 4. Replacement checks in: VACANT_ALERT -> OCCUPIED
    await dispatchService.applyWithRetry({
      siteId: "AEON_THANH_KHE_F1",
      postId: "G4",
      kind: "CHECKIN_ACCEPTED",
      payload: { guardId: 2 }
    });

    // 5. Dispatcher sees post turn GREEN (#22c55e)
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="post-marker-G4"] circle[data-status]')
          ?.getAttribute("data-status") === "OCCUPIED",
      { timeout: 10000 }
    );
    expect(await g4Circle.getAttribute("fill")).toBe("#22c55e");

    await page.close();
  }, 15000);

  it("Playwright smoke: mobile 'break' button locked until relief checks in", async () => {
    // Reset post P1 to OCCUPIED by guard 10
    await db.query(
      `UPDATE post_state 
       SET status = 'OCCUPIED', guard_id = 10, since = clock_timestamp(), deadline_at = NULL, version = version + 1
       WHERE post_id = 'P1';`
    );

    const page: Page = await browser.newPage();

    // 1. Guard opens mobile PWA
    await page.goto(`${webUrl}/mobile?token=${guard10Token}&apiUrl=${apiUrl}&guardId=10&postId=P1`);

    // Verify break button is locked / disabled initially
    await page.waitForSelector('[data-testid="break-button"]', { timeout: 10000 });
    const breakBtn = page.locator('[data-testid="break-button"]');
    expect(await breakBtn.isDisabled()).toBe(true);

    // Verify explanation text is displayed
    const explanation = page.locator('[data-testid="break-lock-explanation"]');
    expect(await explanation.isVisible()).toBe(true);
    expect(await explanation.innerText()).toContain("bàn giao");

    // 2. Relief float arrives and checks in
    await dispatchService.applyWithRetry({
      siteId: "AEON_THANH_KHE_F1",
      postId: "P1",
      kind: "MEAL_WINDOW_OPEN",
      payload: { floatId: 2 }
    });

    await dispatchService.applyWithRetry({
      siteId: "AEON_THANH_KHE_F1",
      postId: "P1",
      kind: "FLOAT_CHECKIN",
      payload: { floatId: 2, guardId: 10 }
    });

    // 3. Mobile break button becomes UNLOCKED / enabled
    await page.waitForFunction(
      () =>
        !(document.querySelector('[data-testid="break-button"]') as HTMLButtonElement | null)
          ?.disabled,
      { timeout: 10000 }
    );
    expect(await breakBtn.isEnabled()).toBe(true);

    await page.close();
  }, 15000);
});
