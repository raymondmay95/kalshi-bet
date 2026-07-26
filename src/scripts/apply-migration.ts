import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { getEnv } from "../config/environment.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const sqlPath = join(__dirname, "../../drizzle/0001_prediction_pipeline.sql");
  const sqlText = readFileSync(sqlPath, "utf8");
  const client = postgres(getEnv().DATABASE_URL, { max: 1 });
  try {
    await client.unsafe(sqlText);
    console.log("Applied drizzle/0001_prediction_pipeline.sql");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
