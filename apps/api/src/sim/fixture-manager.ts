import pg from "pg";
import { type ScenarioSeed } from "@swms/contracts";
import { type Clock } from "@swms/contracts";
import { runSeed } from "../../../../db/seed/seed.js";

const { Pool } = pg;

export class FixtureManager {
  constructor(private readonly connectionString: string) {}

  async resetDatabase(): Promise<void> {
    await runSeed(this.connectionString);
  }

  async setupFixture(seed: ScenarioSeed, clock?: Clock): Promise<void> {
    const pool = new Pool({ connectionString: this.connectionString });
    const client = await pool.connect();

    try {
      await client.query("BEGIN;");

      // 1. Apply Policy Overrides if any
      if (seed.policyOverrides && Object.keys(seed.policyOverrides).length > 0) {
        for (const [key, value] of Object.entries(seed.policyOverrides)) {
          await client.query(
            `INSERT INTO policies (key, value, valid_from)
             VALUES ($1, $2, '2026-01-01T00:00:00Z');`,
            [key, JSON.stringify(value)]
          );
        }
      }

      // 2. Fetch all guards
      const guardsRes = await client.query(
        `SELECT id, code, role, float_kind FROM guards ORDER BY id ASC;`
      );
      const allGuards = guardsRes.rows;

      const regularGuards = allGuards.filter((g) => g.role === "GUARD");
      const floatT1Guards = allGuards.filter((g) => g.role === "FLOAT" && g.float_kind === "TIER1_RELIEF");
      const floatGenGuards = allGuards.filter((g) => g.role === "FLOAT" && g.float_kind === "GENERAL");
      const supervisorGuards = allGuards.filter((g) => g.role === "SUPERVISOR");

      // Create a base schedule row for the week
      const schedRes = await client.query(
        `INSERT INTO schedules (period, status, created_at)
         VALUES (daterange($1::date, ($1::date + 7)), 'PUBLISHED', now())
         RETURNING id;`,
        [seed.date]
      );
      const scheduleId = Number(schedRes.rows[0].id);

      const fixedPosts = [
        "G1", "G2", "G3", "G4", "G5", "G6",
        "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"
      ];
      const nightPosts = ["G1", "G3", "G4", "G5", "G6", "P8"];

      const dateObj = new Date(`${seed.date}T00:00:00+07:00`);
      const nextDateObj = new Date(dateObj.getTime() + 24 * 60 * 60 * 1000);
      const ny = nextDateObj.getFullYear();
      const nm = String(nextDateObj.getMonth() + 1).padStart(2, "0");
      const nd = String(nextDateObj.getDate()).padStart(2, "0");
      const nextDateStr = `${ny}-${nm}-${nd}`;

      // Setup specific fixture sets
      if (seed.fixtureSet === "full-roster" || seed.fixtureSet === "morning-full") {
        // Morning shift 06:00 - 14:00
        const mStart = `${seed.date} 06:00:00+07`;
        const mEnd = `${seed.date} 14:00:00+07`;

        // 14 fixed posts
        for (let i = 0; i < fixedPosts.length; i++) {
          const postId = fixedPosts[i];
          const guard = regularGuards[i];
          if (guard) {
            await client.query(
              `INSERT INTO assignments (schedule_id, guard_id, post_id, role, shift, period, source, status)
               VALUES ($1, $2, $3, 'FIXED', 'MORNING', tstzrange($4, $5, '[)'), 'ROSTER', 'ACTIVE');`,
              [scheduleId, guard.id, postId, mStart, mEnd]
            );

            await client.query(
              `UPDATE post_state
               SET status = 'OCCUPIED', guard_id = $1, since = $2, version = version + 1
               WHERE post_id = $3;`,
              [guard.id, mStart, postId]
            );
          }
        }

        // Floats & Supervisor for Morning
        if (floatT1Guards[0]) {
          await client.query(
            `INSERT INTO assignments (schedule_id, guard_id, role, shift, period, source, status)
             VALUES ($1, $2, 'FLOAT_T1', 'MORNING', tstzrange($3, $4, '[)'), 'ROSTER', 'ACTIVE');`,
            [scheduleId, floatT1Guards[0].id, mStart, mEnd]
          );
        }
        if (floatT1Guards[1]) {
          await client.query(
            `INSERT INTO assignments (schedule_id, guard_id, role, shift, period, source, status)
             VALUES ($1, $2, 'FLOAT_T1', 'MORNING', tstzrange($3, $4, '[)'), 'ROSTER', 'ACTIVE');`,
            [scheduleId, floatT1Guards[1].id, mStart, mEnd]
          );
        }
        if (floatGenGuards[0]) {
          await client.query(
            `INSERT INTO assignments (schedule_id, guard_id, role, shift, period, source, status)
             VALUES ($1, $2, 'FLOAT_GEN', 'MORNING', tstzrange($3, $4, '[)'), 'ROSTER', 'ACTIVE');`,
            [scheduleId, floatGenGuards[0].id, mStart, mEnd]
          );
        }
        if (supervisorGuards[0]) {
          await client.query(
            `INSERT INTO assignments (schedule_id, guard_id, role, shift, period, source, status)
             VALUES ($1, $2, 'SUPERVISOR', 'MORNING', tstzrange($3, $4, '[)'), 'ROSTER', 'ACTIVE');`,
            [scheduleId, supervisorGuards[0].id, mStart, mEnd]
          );
        }

        // Afternoon shift 14:00 - 22:00
        const aStart = `${seed.date} 14:00:00+07`;
        const aEnd = `${seed.date} 22:00:00+07`;
        for (let i = 0; i < fixedPosts.length; i++) {
          const postId = fixedPosts[i];
          const guard = regularGuards[14 + i];
          if (guard) {
            await client.query(
              `INSERT INTO assignments (schedule_id, guard_id, post_id, role, shift, period, source, status)
               VALUES ($1, $2, $3, 'FIXED', 'AFTERNOON', tstzrange($4, $5, '[)'), 'ROSTER', 'ACTIVE');`,
              [scheduleId, guard.id, postId, aStart, aEnd]
            );
          }
        }
        if (floatT1Guards[2]) {
          await client.query(
            `INSERT INTO assignments (schedule_id, guard_id, role, shift, period, source, status)
             VALUES ($1, $2, 'FLOAT_T1', 'AFTERNOON', tstzrange($3, $4, '[)'), 'ROSTER', 'ACTIVE');`,
            [scheduleId, floatT1Guards[2].id, aStart, aEnd]
          );
        }
        if (floatT1Guards[3]) {
          await client.query(
            `INSERT INTO assignments (schedule_id, guard_id, role, shift, period, source, status)
             VALUES ($1, $2, 'FLOAT_T1', 'AFTERNOON', tstzrange($3, $4, '[)'), 'ROSTER', 'ACTIVE');`,
            [scheduleId, floatT1Guards[3].id, aStart, aEnd]
          );
        }
        if (floatGenGuards[1]) {
          await client.query(
            `INSERT INTO assignments (schedule_id, guard_id, role, shift, period, source, status)
             VALUES ($1, $2, 'FLOAT_GEN', 'AFTERNOON', tstzrange($3, $4, '[)'), 'ROSTER', 'ACTIVE');`,
            [scheduleId, floatGenGuards[1].id, aStart, aEnd]
          );
        }
        if (supervisorGuards[1]) {
          await client.query(
            `INSERT INTO assignments (schedule_id, guard_id, role, shift, period, source, status)
             VALUES ($1, $2, 'SUPERVISOR', 'AFTERNOON', tstzrange($3, $4, '[)'), 'ROSTER', 'ACTIVE');`,
            [scheduleId, supervisorGuards[1].id, aStart, aEnd]
          );
        }

        // Night shift 22:00 - 06:00
        const nStart = `${seed.date} 22:00:00+07`;
        const nEnd = `${nextDateStr} 06:00:00+07`;
        for (let i = 0; i < nightPosts.length; i++) {
          const postId = nightPosts[i];
          const guard = regularGuards[28 + i];
          if (guard) {
            await client.query(
              `INSERT INTO assignments (schedule_id, guard_id, post_id, role, shift, period, source, status)
               VALUES ($1, $2, $3, 'FIXED', 'NIGHT', tstzrange($4, $5, '[)'), 'ROSTER', 'ACTIVE');`,
              [scheduleId, guard.id, postId, nStart, nEnd]
            );
          }
        }
        if (floatGenGuards[2]) {
          await client.query(
            `INSERT INTO assignments (schedule_id, guard_id, role, shift, period, source, status)
             VALUES ($1, $2, 'FLOAT_GEN', 'NIGHT', tstzrange($3, $4, '[)'), 'ROSTER', 'ACTIVE');`,
            [scheduleId, floatGenGuards[2].id, nStart, nEnd]
          );
        }
      } else if (seed.fixtureSet === "night-shift") {
        const nStart = `${seed.date} 22:00:00+07`;
        const nEnd = `${nextDateStr} 06:00:00+07`;

        for (let i = 0; i < nightPosts.length; i++) {
          const postId = nightPosts[i];
          const guard = regularGuards[i];
          if (guard) {
            await client.query(
              `INSERT INTO assignments (schedule_id, guard_id, post_id, role, shift, period, source, status)
               VALUES ($1, $2, $3, 'FIXED', 'NIGHT', tstzrange($4, $5, '[)'), 'ROSTER', 'ACTIVE');`,
              [scheduleId, guard.id, postId, nStart, nEnd]
            );

            await client.query(
              `UPDATE post_state
               SET status = 'OCCUPIED', guard_id = $1, since = $2, version = version + 1
               WHERE post_id = $3;`,
              [guard.id, nStart, postId]
            );
          }
        }

        for (const p of fixedPosts) {
          if (!nightPosts.includes(p)) {
            await client.query(
              `UPDATE post_state SET status = 'NOT_ACTIVE', guard_id = NULL WHERE post_id = $1;`,
              [p]
            );
          }
        }

        if (floatGenGuards[0]) {
          await client.query(
            `INSERT INTO assignments (schedule_id, guard_id, role, shift, period, source, status)
             VALUES ($1, $2, 'FLOAT_GEN', 'NIGHT', tstzrange($3, $4, '[)'), 'ROSTER', 'ACTIVE');`,
            [scheduleId, floatGenGuards[0].id, nStart, nEnd]
          );
        }
        if (supervisorGuards[0]) {
          await client.query(
            `INSERT INTO assignments (schedule_id, guard_id, role, shift, period, source, status)
             VALUES ($1, $2, 'SUPERVISOR', 'NIGHT', tstzrange($3, $4, '[)'), 'ROSTER', 'ACTIVE');`,
            [scheduleId, supervisorGuards[0].id, nStart, nEnd]
          );
        }
      } else if (seed.fixtureSet === "understaffed-week") {
        const tier1Posts = ["G1", "G4", "G5", "P1", "P6", "P7", "P8"];
        const mergedTier2 = ["P3", "P4", "G3"];
        const activeTier2 = ["P2", "P5", "G2", "G6"];

        const mStart = `${seed.date} 06:00:00+07`;
        const mEnd = `${seed.date} 14:00:00+07`;

        let gIdx = 0;
        // Staff all Tier-1 posts
        for (const p of tier1Posts) {
          const guard = regularGuards[gIdx++];
          await client.query(
            `INSERT INTO assignments (schedule_id, guard_id, post_id, role, shift, period, source, status)
             VALUES ($1, $2, $3, 'FIXED', 'MORNING', tstzrange($4, $5, '[)'), 'ROSTER', 'ACTIVE');`,
            [scheduleId, guard.id, p, mStart, mEnd]
          );
          await client.query(
            `UPDATE post_state SET status = 'OCCUPIED', guard_id = $1 WHERE post_id = $2;`,
            [guard.id, p]
          );
        }

        // Staff primary Tier-2 posts
        for (const p of activeTier2) {
          const guard = regularGuards[gIdx++];
          await client.query(
            `INSERT INTO assignments (schedule_id, guard_id, post_id, role, shift, period, source, status)
             VALUES ($1, $2, $3, 'FIXED', 'MORNING', tstzrange($4, $5, '[)'), 'ROSTER', 'ACTIVE');`,
            [scheduleId, guard.id, p, mStart, mEnd]
          );
          await client.query(
            `UPDATE post_state SET status = 'OCCUPIED', guard_id = $1 WHERE post_id = $2;`,
            [guard.id, p]
          );
        }

        // Set merged Tier-2 posts to COVERED_BY_PAIR
        for (const p of mergedTier2) {
          await client.query(
            `UPDATE post_state SET status = 'COVERED_BY_PAIR', guard_id = NULL WHERE post_id = $1;`,
            [p]
          );
        }

        // Record staffing request for gap = 15
        await client.query(
          `INSERT INTO staffing_requests (created_at, shift, qty, reason, status)
           VALUES ($1, 'MORNING', 15, 'Headcount standard understaffing gap (45 present / 60 required)', 'OPEN');`,
          [mStart]
        );
      }

      await client.query("COMMIT;");
    } catch (err) {
      await client.query("ROLLBACK;");
      throw err;
    } finally {
      client.release();
      await pool.end();
    }
  }
}
