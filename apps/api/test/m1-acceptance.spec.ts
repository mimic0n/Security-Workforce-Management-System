import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { runMigration } from "../../../db/migrate.js";
import { runSeed } from "../../../db/seed/seed.js";

const testDbUrl = process.env.TEST_DATABASE_URL || "postgres://grey@localhost:5432/swms_test";
const { Pool } = pg;

describe("Milestone M1 Acceptance Criteria", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testDbUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("1. Migration up and down works cleanly", async () => {
    // Run down first in case leftover tables exist
    await runMigration("down", testDbUrl);

    // Verify tables are dropped
    const checkEmpty = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public';
    `);
    expect(checkEmpty.rows.length).toBe(0);

    // Run up migration
    await runMigration("up", testDbUrl);

    // Verify all core tables created
    const checkTables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public';
    `);
    const tableNames = checkTables.rows.map((r) => r.table_name);
    expect(tableNames).toContain("guards");
    expect(tableNames).toContain("posts");
    expect(tableNames).toContain("post_rules");
    expect(tableNames).toContain("assignments");
    expect(tableNames).toContain("policies");
    expect(tableNames).toContain("state_events");
    expect(tableNames).toContain("users");
  });

  it("2. Seed yields exactly 14 posts, 45 guards, valid certs and devices", async () => {
    await runSeed(testDbUrl);

    // 14 posts
    const postsRes = await pool.query("SELECT COUNT(*) FROM posts;");
    expect(parseInt(postsRes.rows[0].count, 10)).toBe(14);

    // 45 guards
    const guardsRes = await pool.query("SELECT COUNT(*) FROM guards;");
    expect(parseInt(guardsRes.rows[0].count, 10)).toBe(45);

    // Check roles composition: 36 GUARD, 4 FLOAT (TIER1_RELIEF), 3 FLOAT (GENERAL), 2 SUPERVISOR
    const rolesRes = await pool.query(`
      SELECT role, float_kind, COUNT(*) as cnt 
      FROM guards 
      GROUP BY role, float_kind;
    `);
    const roleCounts: Record<string, number> = {};
    for (const r of rolesRes.rows) {
      const key = `${r.role}${r.float_kind ? `_${r.float_kind}` : ""}`;
      roleCounts[key] = parseInt(r.cnt, 10);
    }
    expect(roleCounts["GUARD"]).toBe(36);
    expect(roleCounts["FLOAT_TIER1_RELIEF"]).toBe(4);
    expect(roleCounts["FLOAT_GENERAL"]).toBe(3);
    expect(roleCounts["SUPERVISOR"]).toBe(2);

    // Exactly 2 expired certificates (for LegalGuard tests)
    const expiredCerts = await pool.query(`
      SELECT COUNT(*) 
      FROM certifications 
      WHERE expires_on < '2026-01-01';
    `);
    expect(parseInt(expiredCerts.rows[0].count, 10)).toBe(2);

    // Each guard has a device
    const devicesRes = await pool.query("SELECT COUNT(*) FROM devices;");
    expect(parseInt(devicesRes.rows[0].count, 10)).toBe(45);
  });

  it("3. EXCLUDE constraint rejects overlapping assignments for the same guard", async () => {
    const guardRes = await pool.query("SELECT id FROM guards LIMIT 1;");
    const guardId = guardRes.rows[0].id;

    // Insert first assignment
    await pool.query(`
      INSERT INTO assignments (guard_id, post_id, role, shift, period, source, status)
      VALUES (
        ${guardId}, 'G1', 'FIXED', 'MORNING',
        tstzrange('2026-11-07 06:00:00+07', '2026-11-07 14:00:00+07', '[)'),
        'ROSTER', 'ACTIVE'
      );
    `);

    // Insert overlapping assignment for the same guard -> must reject with exclusion violation (SQLSTATE 23P01)
    let error: any = null;
    try {
      await pool.query(`
        INSERT INTO assignments (guard_id, post_id, role, shift, period, source, status)
        VALUES (
          ${guardId}, 'G2', 'FIXED', 'MORNING',
          tstzrange('2026-11-07 10:00:00+07', '2026-11-07 18:00:00+07', '[)'),
          'DISPATCH', 'ACTIVE'
        );
      `);
    } catch (err) {
      error = err;
    }

    expect(error).not.toBeNull();
    // PostgreSQL exclusion constraint violation code: 23P01
    expect(error.code).toBe("23P01");

    // But cancelled assignment overlapping should be allowed
    await pool.query(`
      INSERT INTO assignments (guard_id, post_id, role, shift, period, source, status)
      VALUES (
        ${guardId}, 'G2', 'FIXED', 'MORNING',
        tstzrange('2026-11-07 10:00:00+07', '2026-11-07 18:00:00+07', '[)'),
        'DISPATCH', 'CANCELLED'
      );
    `);
  });

  it("4. Tier-1 CHECK rejects max_vacant_sec > 0 (Zero-Vacancy invariant)", async () => {
    // Post G1 is TIER1. Trying to set max_vacant_sec > 0 must throw check constraint violation (SQLSTATE 23514)
    let error: any = null;
    try {
      await pool.query(`
        UPDATE post_rules 
        SET max_vacant_sec = 60 
        WHERE post_id = 'G1' AND tier = 'TIER1';
      `);
    } catch (err) {
      error = err;
    }

    expect(error).not.toBeNull();
    // PostgreSQL check constraint violation code: 23514
    expect(error.code).toBe("23514");

    // Tier 2 post G2 allows max_vacant_sec > 0
    await pool.query(`
      UPDATE post_rules 
      SET max_vacant_sec = 1200 
      WHERE post_id = 'G2' AND tier = 'TIER2';
    `);

    const g2Res = await pool.query("SELECT max_vacant_sec FROM post_rules WHERE post_id = 'G2';");
    expect(parseInt(g2Res.rows[0].max_vacant_sec, 10)).toBe(1200);
  });
});
