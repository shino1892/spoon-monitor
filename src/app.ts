import "dotenv/config";
import { SpoonV2, Country, LogLevel } from "@sopia-bot/core";

// HTTP デバッグを明示的に有効化していない場合は冗長ログを抑止する。
if (process.env.SOPIA_HTTP_DEBUG !== "1") {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.debug = () => {};
}

export async function initSpoon(type: "DJ" | "MONITOR") {
  const client = new SpoonV2(Country.JAPAN, { logLevel: LogLevel.WARN });
  await client.init();

  // 実行モードごとに参照するトークン環境変数を切り替える。
  const accessToken = type === "DJ" ? process.env.DJ_ACCESS_TOKEN || process.env.COLLECTOR_TOKEN : process.env.MONITOR_ACCESS_TOKEN || process.env.MONITOR_TOKEN;
  const refreshToken = type === "DJ" ? process.env.DJ_REFRESH_TOKEN : process.env.MONITOR_REFRESH_TOKEN;

  if (!accessToken) throw new Error(`${type} token is missing.`);

  // refreshToken は任意（token-only でも動作可能）
  await client.setToken(accessToken, refreshToken);
  const me: any = (client as any).logonUser;
  console.log(`👤 ${type} ログイン完了: ${me?.nickname} (${me?.id})`);
  return client;
}

if (require.main === module) {
  console.log("ℹ️ app.ts は共通ログイン関数モジュールです。単体実行は想定していません。");
}
