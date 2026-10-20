import pg from "pg";
import bcrypt from "bcryptjs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const { Pool } = pg;

export async function runSeed(connectionString?: string) {
  const dbUrl = connectionString || process.env.DATABASE_URL || "postgres://grey@localhost:5432/swms";
  const pool = new Pool({ connectionString: dbUrl });
  const client = await pool.connect();

  try {
    await client.query("BEGIN;");

    // Clean existing seed tables
    await client.query(`
      TRUNCATE TABLE 
        users, devices, certifications, assignments, schedules, 
        break_plans, dispatch_orders, absences, attendance_logs, incidents,
        state_events, post_state, site_state, post_travel, policies,
        shift_templates, post_rules, posts, guards 
      CASCADE;
    `);

    // 1. Posts & Post Rules
    const postsData = [
      { id: "G1", name: "Cổng Võ Văn Tân", zone: "north gate", tier: "TIER1", max_vacant_sec: 0, pair_with: [], x: 100, y: 100, qr_code_id: "QR_G1", group: "gates-north" },
      { id: "G2", name: "Cổng Hải Phòng", zone: "east gate", tier: "TIER2", max_vacant_sec: 900, pair_with: [], x: 800, y: 300, qr_code_id: "QR_G2", group: "gates-south" },
      { id: "G3", name: "Cổng Điện Biên Phủ", zone: "main facade", tier: "TIER2", max_vacant_sec: 900, pair_with: [], x: 500, y: 550, qr_code_id: "QR_G3", group: "gates-south" },
      { id: "G4", name: "Cổng Bách hóa góc dưới", zone: "south dept gate", tier: "TIER1", max_vacant_sec: 0, pair_with: [], x: 200, y: 550, qr_code_id: "QR_G4", group: "gates-south" },
      { id: "G5", name: "Cổng Bách hóa góc trên", zone: "north dept gate", tier: "TIER1", max_vacant_sec: 0, pair_with: [], x: 200, y: 100, qr_code_id: "QR_G5", group: "gates-north" },
      { id: "G6", name: "Cổng Hầm giữ xe", zone: "basement ramp", tier: "TIER2", max_vacant_sec: 900, pair_with: [], x: 850, y: 500, qr_code_id: "QR_G6", group: "gates-south" },
      { id: "P1", name: "Sảnh Mặt Trời", zone: "AEON Delica", tier: "TIER1", max_vacant_sec: 0, pair_with: [], x: 300, y: 250, qr_code_id: "QR_P1", group: "dept" },
      { id: "P2", name: "Khu vực Langfarm", zone: "specialty", tier: "TIER2", max_vacant_sec: 900, pair_with: ["P3"], x: 450, y: 250, qr_code_id: "QR_P2", group: "hall" },
      { id: "P3", name: "Sảnh Mặt Trăng", zone: "event hall", tier: "TIER2", max_vacant_sec: 900, pair_with: ["P2"], x: 600, y: 250, qr_code_id: "QR_P3", group: "hall" },
      { id: "P4", name: "AEON Bakery", zone: "bakery exit", tier: "TIER2", max_vacant_sec: 900, pair_with: ["P5"], x: 650, y: 400, qr_code_id: "QR_P4", group: "hall" },
      { id: "P5", name: "Cụm Cafe", zone: "Starbucks/Phê La", tier: "TIER2", max_vacant_sec: 900, pair_with: ["P4"], x: 500, y: 400, qr_code_id: "QR_P5", group: "hall" },
      { id: "P6", name: "Thang cuốn Bách hóa", zone: "dept escalator", tier: "TIER1", max_vacant_sec: 0, pair_with: [], x: 350, y: 400, qr_code_id: "QR_P6", group: "dept" },
      { id: "P7", name: "Cụm Thang máy", zone: "dept elevators", tier: "TIER1", max_vacant_sec: 0, pair_with: [], x: 350, y: 150, qr_code_id: "QR_P7", group: "dept" },
      { id: "P8", name: "Quầy Thu ngân/Thông tin", zone: "cashier/info", tier: "TIER1", max_vacant_sec: 0, pair_with: [], x: 250, y: 350, qr_code_id: "QR_P8", group: "gates-north" }
    ];

    const nightPosts = new Set(["G1", "G3", "G4", "G5", "G6", "P8"]);

    for (const p of postsData) {
      await client.query(
        `INSERT INTO posts (id, site_id, name, zone, x, y, lat, lon, geofence_m, qr_code_id)
         VALUES ($1, 'AEON_THANH_KHE_F1', $2, $3, $4, $5, 16.065, 108.202, 25, $6);`,
        [p.id, p.name, p.zone, p.x, p.y, p.qr_code_id]
      );

      const activeShifts = nightPosts.has(p.id)
        ? ["MORNING", "AFTERNOON", "NIGHT"]
        : ["MORNING", "AFTERNOON"];

      await client.query(
        `INSERT INTO post_rules (post_id, tier, max_vacant_sec, pair_with, active_shifts, needs_meal_cover)
         VALUES ($1, $2, $3, $4, $5, $6);`,
        [p.id, p.tier, p.max_vacant_sec, p.pair_with, activeShifts, p.tier === "TIER1"]
      );

      await client.query(
        `INSERT INTO post_state (post_id, status, since, version)
         VALUES ($1, 'NOT_ACTIVE', now(), 0);`,
        [p.id]
      );
    }

    // 2. Guards (45 guards: 36 GUARD, 4 FLOAT(TIER1_RELIEF), 3 FLOAT(GENERAL), 2 SUPERVISOR)
    const guardsData = [];
    const vietnameseNames = [
      "Nguyễn Văn An", "Trần Đình Bình", "Lê Hoàng Cường", "Phạm Quốc Dũng", "Hoàng Văn Em",
      "Vũ Hải Giang", "Đặng Minh Hải", "Bùi Thế Hùng", "Hồ Văn Khoa", "Ngô Quốc Long",
      "Đỗ Tuấn Minh", "Dương Văn Nam", "Lý Hoài Phong", "Mai Quốc Quân", "Trịnh Văn Sang",
      "Phan Đình Tài", "Lâm Quốc Uy", "Cao Văn Việt", "Võ Hải Xuân", "Châu Minh Yên",
      "Tạ Hoàng Bách", "Đinh Quốc Bảo", "Lương Văn Chung", "Hà Hải Đăng", "Quách Văn Khang",
      "Diệp Hoàng Lâm", "Tô Quốc Mạnh", "Thân Văn Nghĩa", "Triệu Hải Phát", "Khổng Văn Quyết",
      "Nghiêm Quốc Sơn", "Phùng Hải Thịnh", "Thái Văn Vinh", "Cù Quốc Vũ", "Bạch Văn Khánh",
      "Đoàn Hải Hòa" // 36 guards
    ];

    for (let i = 1; i <= 36; i++) {
      const code = `G${i.toString().padStart(2, "0")}`;
      guardsData.push({
        code,
        full_name: vietnameseNames[i - 1],
        role: "GUARD",
        float_kind: null
      });
    }

    // 4 FLOAT TIER1_RELIEF
    const floatT1Names = ["Nguyễn Hữu Tài (CĐ1)", "Trần Bảo Long (CĐ2)", "Lê Quốc Thịnh (CĐ3)", "Phạm Đức Thắng (CĐ4)"];
    for (let i = 1; i <= 4; i++) {
      guardsData.push({
        code: `F${i.toString().padStart(2, "0")}`,
        full_name: floatT1Names[i - 1],
        role: "FLOAT",
        float_kind: "TIER1_RELIEF"
      });
    }

    // 3 FLOAT GENERAL
    const floatGenNames = ["Vũ Đình Trọng (CĐ-TH1)", "Hoàng Minh Trí (CĐ-TH2)", "Đặng Văn Toàn (CĐ-TH3)"];
    for (let i = 1; i <= 3; i++) {
      guardsData.push({
        code: `FG${i.toString().padStart(2, "0")}`,
        full_name: floatGenNames[i - 1],
        role: "FLOAT",
        float_kind: "GENERAL"
      });
    }

    // 2 SUPERVISOR
    const supNames = ["Bùi Quốc Trưởng (GS1)", "Hồ Văn Giám (GS2)"];
    for (let i = 1; i <= 2; i++) {
      guardsData.push({
        code: `S${i.toString().padStart(2, "0")}`,
        full_name: supNames[i - 1],
        role: "SUPERVISOR",
        float_kind: null
      });
    }

    const insertedGuards: { id: number; code: string; role: string }[] = [];

    for (let i = 0; i < guardsData.length; i++) {
      const g = guardsData[i];
      const res = await client.query(
        `INSERT INTO guards (code, full_name, role, float_kind, phone, active, hired_on)
         VALUES ($1, $2, $3, $4, $5, true, '2025-01-01')
         RETURNING id, code, role;`,
        [g.code, g.full_name, g.role, g.float_kind, `09010000${(i + 1).toString().padStart(2, "0")}`]
      );
      insertedGuards.push(res.rows[0]);

      // Certifications: guard 44 and 45 deliberately expired for LegalGuard tests
      const isExpired = i >= 43; // 44th and 45th guards
      const expiresOn = isExpired ? "2024-01-01" : "2028-12-31";
      await client.query(
        `INSERT INTO certifications (guard_id, cert_no, issued_on, expires_on)
         VALUES ($1, $2, '2023-01-01', $3);`,
        [res.rows[0].id, `CERT-${g.code}`, expiresOn]
      );

      // Device: 1 device per guard
      await client.query(
        `INSERT INTO devices (guard_id, device_uid, active)
         VALUES ($1, $2, true);`,
        [res.rows[0].id, `DEV_${g.code}`]
      );
    }

    // 3. Shift Templates
    await client.query(`
      INSERT INTO shift_templates (code, start_time, end_time, crosses_midnight, break_minutes)
      VALUES 
        ('MORNING', '06:00:00', '14:00:00', false, 30),
        ('AFTERNOON', '14:00:00', '22:00:00', false, 30),
        ('NIGHT', '22:00:00', '06:00:00', true, 45);
    `);

    // 4. Default Policies
    const defaultPolicies: [string, any][] = [
      ["headcount.fixed", { MORNING: 14, AFTERNOON: 14, NIGHT: 6 }],
      ["headcount.float_t1", { MORNING: 2, AFTERNOON: 2, NIGHT: 0 }],
      ["headcount.float_gen", { MORNING: 1, AFTERNOON: 1, NIGHT: 1 }],
      ["headcount.sup", { MORNING: 1, AFTERNOON: 1, NIGHT: 1 }],
      ["relief.k_weekly_rest", 1.1667],
      ["relief.leave_sick_ratio", 0.15],
      ["relief.k_override", 1.35],
      ["relief.k_sensitivity_range", [1.25, 1.40]],
      ["meal.window", { MORNING: ["10:00", "12:45"], AFTERNOON: ["16:00", "18:45"] }],
      ["meal.handover_buffer_min", 5],
      ["meal.break_not_at_edges_min", 60],
      ["attendance.gps_accuracy_max_m", 30],
      ["attendance.out_samples_required", 3],
      ["attendance.uncertain_after_sec", 45],
      ["attendance.tier1_escalate_after_sec", 120],
      ["attendance.violation_after_sec", 600],
      ["attendance.nonce_ttl_sec", 45],
      ["legal.min_rest_hours", 12],
      ["legal.max_work_days_week", 6],
      ["legal.ot_cap_month_min", 2400],
      ["legal.ot_cap_year_min", 12000],
      ["legal.night_start", "22:00"],
      ["legal.night_end", "06:00"],
      ["dispatch.ack_timeout_sec", 60],
      ["dispatch.rank_weights", { distance: 1, ot: 2, load: 1.5 }]
    ];

    for (const [key, val] of defaultPolicies) {
      await client.query(
        `INSERT INTO policies (key, value, valid_from)
         VALUES ($1, $2, '2026-01-01T00:00:00Z');`,
        [key, JSON.stringify(val)]
      );
    }

    // 5. Post Travel Matrix (5 min within group, 10 min across groups)
    for (const p1 of postsData) {
      for (const p2 of postsData) {
        let minutes = 0;
        if (p1.id !== p2.id) {
          minutes = p1.group === p2.group ? 5 : 10;
        }
        await client.query(
          `INSERT INTO post_travel (from_post, to_post, minutes)
           VALUES ($1, $2, $3);`,
          [p1.id, p2.id, minutes]
        );
      }
    }

    // 6. Site State
    await client.query(`
      INSERT INTO site_state (site_id, mode, version, since)
      VALUES ('AEON_THANH_KHE_F1', 'NORMAL', 0, now());
    `);

    // 7. Seed Users (ADMIN, DISPATCHER, SUPERVISOR, GUARD)
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash("password123", salt);

    await client.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('admin', $1, 'ADMIN'),
              ('dispatcher', $1, 'DISPATCHER');`,
      [hash]
    );

    // Link supervisor user
    const sup1 = insertedGuards.find((g) => g.role === "SUPERVISOR");
    if (sup1) {
      await client.query(
        `INSERT INTO users (username, password_hash, role, guard_id)
         VALUES ('supervisor', $1, 'SUPERVISOR', $2);`,
        [hash, sup1.id]
      );
    }

    // Link a guard user
    const guard1 = insertedGuards.find((g) => g.code === "G01");
    if (guard1) {
      await client.query(
        `INSERT INTO users (username, password_hash, role, guard_id)
         VALUES ('guard01', $1, 'GUARD', $2);`,
        [hash, guard1.id]
      );
    }

    await client.query("COMMIT;");
    console.log("Database seeded successfully: 14 posts, 45 guards, policies, post travel, users.");
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] === __filename) {
  runSeed().catch((err) => {
    console.error("Seed error:", err);
    process.exit(1);
  });
}
