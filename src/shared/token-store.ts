import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type TokenAccount = "Monitor" | "DJ";

export type StoredTokenEntry = {
  Token: string;
  refreshToken: string;
  updatedAt: string;
};

export type StoredTokens = Partial<Record<TokenAccount, StoredTokenEntry>>;

const TOKENS_PATH = join(process.cwd(), "data", "tokens.json");

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function loadStoredTokens(): Promise<StoredTokens> {
  const parsed = await readJsonFile<unknown>(TOKENS_PATH);
  if (!parsed || typeof parsed !== "object") return {};

  const obj = parsed as any;
  const out: StoredTokens = {};

  for (const key of ["Monitor", "DJ"] as const) {
    const entry = obj[key];
    if (!entry || typeof entry !== "object") continue;

    if (typeof entry.Token !== "string" || entry.Token.trim() === "") continue;
    if (typeof entry.refreshToken !== "string" || entry.refreshToken.trim() === "") continue;
    if (typeof entry.updatedAt !== "string" || entry.updatedAt.trim() === "") continue;

    out[key] = {
      Token: entry.Token,
      refreshToken: entry.refreshToken,
      updatedAt: entry.updatedAt,
    };
  }

  return out;
}

export async function getDynamicTokenFor(type: "DJ" | "MONITOR"): Promise<{ accessToken?: string; refreshToken?: string }> {
  const stored = await loadStoredTokens();
  const key: TokenAccount = type === "DJ" ? "DJ" : "Monitor";
  const entry = stored[key];

  if (!entry) return {};
  return { accessToken: entry.Token, refreshToken: entry.refreshToken };
}
