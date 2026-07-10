import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import express from "express";
import cors from "cors";

// --- ユーザーが定義された既存の型とパス ---
export type TokenAccount = "Monitor" | "DJ";
export type StoredTokenEntry = {
  Token: string;
  refreshToken: string;
  updatedAt: string;
};
export type StoredTokens = Partial<Record<TokenAccount, StoredTokenEntry>>;

const TOKENS_PATH = join(process.cwd(), "data", "tokens.json");

// --- ユーザーが定義された既存の読み込み関数 ---
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

// =================================================================
// 🆕 追加: トークンを安全に保存・更新する関数
// =================================================================
export async function saveStoredToken(
  account: TokenAccount,
  token: string,
  refreshToken: string
): Promise<void> {
  // 1. 現時点での最新の tokens.json を読み込む（既存の他方のアカウントデータを消さないため）
  const currentTokens = await loadStoredTokens();

  // 2. 対象アカウントのデータを新しい内容で上書き（または新規追加）
  currentTokens[account] = {
    Token: token,
    refreshToken: refreshToken,
    updatedAt: new Date().toLocaleString("ja-JP"), // 保存したサーバー側の時刻
  };

  try {
    // 3. `data` ディレクトリが存在しない場合に備えて作成
    await mkdir(dirname(TOKENS_PATH), { recursive: true });

    // 4. インデント付きの綺麗なJSONとしてファイルに書き込み
    await writeFile(TOKENS_PATH, JSON.stringify(currentTokens, null, 2), "utf8");
    console.log(`[Success] ${account} のトークンを tokens.json に保存しました。`);
  } catch (err) {
    console.error("[Error] tokens.json の保存に失敗しました:", err);
    throw err;
  }
}

// =================================================================
// 🆕 追加: 拡張機能からのリクエストを受けるポート5000のサーバー
// =================================================================
const app = express();
const PORT = 5000;

// Chrome拡張機能からのリクエストを受け付けるための設定
app.use(cors()); // 必要に応じて `npm install cors @types/cors` してください
app.use(express.json());

// 拡張機能が POST するエンドポイント
// 拡張機能の仕様: SERVER_URL = "http://192.168.0.108:5000/update-token"
app.post("/update-token", async (req, res) => {
  try {
    const { Token, refreshToken, account } = req.body;

    // バリデーション: 拡張機能から必要なデータが来ているかチェック
    if (!Token || !refreshToken || !account) {
      res.status(400).json({ error: "必要なパラメータ（Token, refreshToken, account）が不足しています。" });
      return;
    }

    if (account !== "Monitor" && account !== "DJ") {
      res.status(400).json({ error: "account は 'Monitor' または 'DJ' である必要があります。" });
      return;
    }

    // 保存関数を呼び出し
    await saveStoredToken(account, Token, refreshToken);

    // 拡張機能側に成功を返す
    res.status(200).json({ message: `${account} のトークンを更新しました。` });
  } catch (err) {
    res.status(500).json({ error: "サーバー内部エラーが発生しました。" });
  }
});

// サーバー起動 (IP: 192.168.0.108 で待ち受け)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Token Receiver Server running on http://192.168.0.108:${PORT}`);
});