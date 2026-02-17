import "dotenv/config";

import { Client } from "pg";
import { upsertAccountTokens } from "../db/token-store";

function maskToken(token: string) {
  const tail = token.slice(-4);
  return `len=${token.length}, ****${tail}`;
}

async function syncOne(db: Client, accountType: "DJ" | "MONITOR") {
  const accessToken =
    accountType === "DJ" ? process.env.DJ_ACCESS_TOKEN : process.env.MONITOR_ACCESS_TOKEN;
  const refreshToken =
    accountType === "DJ" ? process.env.DJ_REFRESH_TOKEN : process.env.MONITOR_REFRESH_TOKEN;

  if (!accessToken || !refreshToken) {
    throw new Error(`${accountType} token is missing in .env`);
  }

  await upsertAccountTokens(db, accountType, accessToken, refreshToken);
  console.log(
    `✅ synced ${accountType} tokens to DB (access:${maskToken(accessToken)} refresh:${maskToken(refreshToken)})`
  );
}

async function main() {
  const db = new Client({
    host: process.env.PGHOST || "192.168.0.56",
    user: process.env.PGUSER || "spoon_user",
    password: process.env.PGPASSWORD || "Spoon_User",
    database: process.env.PGDATABASE || "spoon_monitor",
  });

  await db.connect();
  try {
    await syncOne(db, "MONITOR");
    await syncOne(db, "DJ");
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error("❌ sync failed:", e?.message || e);
  process.exit(1);
});
