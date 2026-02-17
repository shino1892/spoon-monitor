import type { Client } from "pg";

export type AccountType = "DJ" | "MONITOR";

export async function loadAccountTokens(
  db: Client,
  accountType: AccountType
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const res = await db.query(
    "SELECT access_token, refresh_token FROM account_tokens WHERE account_type = $1",
    [accountType]
  );
  const row = res.rows?.[0];
  if (!row?.access_token || !row?.refresh_token) return null;
  return { accessToken: row.access_token, refreshToken: row.refresh_token };
}

export async function upsertAccountTokens(
  db: Client,
  accountType: AccountType,
  accessToken: string,
  refreshToken: string
): Promise<void> {
  const query = `
    INSERT INTO account_tokens (account_type, access_token, refresh_token, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (account_type) DO UPDATE
    SET access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        updated_at = NOW();
  `;
  await db.query(query, [accountType, accessToken, refreshToken]);
}
