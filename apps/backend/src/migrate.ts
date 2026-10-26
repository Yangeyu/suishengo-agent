import { migrateDatabase } from "@plugins/sessions-pg/src/migrate";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
try {
  await migrateDatabase(process.env.DATABASE_URL);
  console.info("Database migrations applied.");
} catch {
  console.error("Database migration failed.");
  process.exitCode = 1;
}
