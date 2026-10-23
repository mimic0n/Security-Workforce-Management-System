import "reflect-metadata";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://grey@localhost:5432/swms_test";
}
