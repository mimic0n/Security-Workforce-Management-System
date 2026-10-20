import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

export async function runMigration(direction: "up" | "down" = "up", connectionString?: string) {
  const dbUrl = connectionString || process.env.DATABASE_URL || "postgres://grey@localhost:5432/swms";
  const pool = new Pool({ connectionString: dbUrl });
  const client = await pool.connect();

  try {
    const filename = direction === "up" ? "001_initial_schema.sql" : "001_initial_schema_down.sql";
    const filePath = path.join(__dirname, "migrations", filename);
    const sql = fs.readFileSync(filePath, "utf-8");

    console.log(`Running migration [${direction}]: ${filename} on ${dbUrl}`);
    await client.query(sql);
    console.log(`Migration [${direction}] completed successfully.`);
  } finally {
    client.release();
    await pool.end();
  }
}

// If invoked directly from CLI
if (process.argv[1] === __filename) {
  const direction = (process.argv[2] === "down" ? "down" : "up") as "up" | "down";
  runMigration(direction).catch((err) => {
    console.error("Migration error:", err);
    process.exit(1);
  });
}
