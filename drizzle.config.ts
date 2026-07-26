import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/storage/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://kalshi:kalshi@localhost:5432/kalshi_bet",
  },
});
