import { join } from "node:path";
import pg from "../src/lib/db/pg";
import { migrate } from "../src/lib/db/migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const applied = await migrate(client, join(import.meta.dirname, "..", "db", "migrations"));
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
} finally {
  await client.end();
}
