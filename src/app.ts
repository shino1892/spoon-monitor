import "dotenv/config";
import { SpoonV2, Country, LogLevel } from "@sopia-bot/core";
import { getDynamicTokenFor } from "./token/token-store";

// HTTP デバッグを明示的に有効化していない場合は冗長ログを抑止する。
if (process.env.SOPIA_HTTP_DEBUG !== "1") {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.debug = () => {};
}

export async function initSpoon(type: "DJ" | "MONITOR") {
  const client = new SpoonV2(Country.JAPAN, { logLevel: LogLevel.WARN });
  await client.init();

  // 実行モードごとに参照するトークン環境変数を切り替える。
  const envAccessToken = type === "DJ" ? process.env.DJ_ACCESS_TOKEN || process.env.COLLECTOR_TOKEN : process.env.MONITOR_ACCESS_TOKEN || process.env.MONITOR_TOKEN;
  const envRefreshToken = type === "DJ" ? process.env.DJ_REFRESH_TOKEN : process.env.MONITOR_REFRESH_TOKEN;

  const dynamic = await getDynamicTokenFor(type);

  // どちらのトークンを使用したかの判定フラグ
  const isDynamic = !!dynamic.accessToken;

  const accessToken = dynamic.accessToken || envAccessToken;
  const refreshToken = dynamic.refreshToken || envRefreshToken;

  if (!accessToken) throw new Error(`${type} token is missing.`);

  await client.setToken(accessToken, refreshToken);
  const me: any = (client as any).logonUser;

  // 💡 ログ出力部分を修正：トークンのソース（[拡張機能] または [環境変数]）を明示する
  const tokenSource = isDynamic ? "拡張機能 (tokens.json)" : "環境変数 (.env)";
  console.log(`👤 ${type} ログイン完了 [ソース: ${tokenSource}]: ${me?.nickname} (${me?.id})`);

  return client;
}

if (require.main === module) {
  console.log("ℹ️ app.ts は共通ログイン関数モジュールです。単体実行は想定していません。");
}
