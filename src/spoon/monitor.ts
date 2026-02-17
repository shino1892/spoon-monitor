import { spawn, ChildProcess } from "child_process";
import { SpoonV2, Country } from "@sopia-bot/core";
import { Client } from "pg";
import "dotenv/config";
import { loadAccountTokens, upsertAccountTokens } from "../db/token-store";

const db = new Client({
  host: "192.168.0.56", // DBコンテナのIP
  user: "spoon_user",
  password: "Spoon_User",
  database: "spoon_monitor",
});

const CONFIG = {
  DJ_ID: process.env.DJ_ID!,
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL || "30000"),
};
let workerProcess: ChildProcess | null = null;
let isStopping = false;

// Bot としてメッセージを送信する関数
async function sendBotMessage(content: string) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;

  if (!token || !channelId) {
    console.error("⚠️ Bot トークンまたはチャンネル ID が設定されていません。");
    return;
  }

  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`, // Webhook と違い、"Bot " プレフィックスが必要です
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("❌ Discord API エラー:", errorData);
    }
  } catch (error:any) {
    console.error("❌ 送信中にエラーが発生しました:", error.message);
  }
}

async function setupClients() {
  const monitorClient = new SpoonV2(Country.JAPAN);
  await monitorClient.init();
  
  // DBを正とする（無ければ.envにフォールバック）
  try {
    await db.connect();
  } catch (e: any) {
    console.warn("⚠️ DB接続に失敗。トークン永続化なしで続行:", e?.message || e);
  }

  let accessToken = process.env.MONITOR_ACCESS_TOKEN;
  let refreshToken = process.env.MONITOR_REFRESH_TOKEN;

  try {
    const fromDb = await loadAccountTokens(db, "MONITOR");
    if (fromDb) {
      accessToken = fromDb.accessToken;
      refreshToken = fromDb.refreshToken;
    }
  } catch (e: any) {
    console.warn("⚠️ DBトークン読み込み失敗。envで続行:", e?.message || e);
  }

  if (!accessToken || !refreshToken) {
    throw new Error("MONITOR token is missing (DB/env)");
  }

  // トークンのセット（これで自動更新が有効になります）
  await monitorClient.setToken(accessToken, refreshToken);

  // 起動時点のトークンをDBへ反映
  try {
    await upsertAccountTokens(db, "MONITOR", monitorClient.token, monitorClient.refreshToken);
  } catch (e: any) {
    console.warn("⚠️ DBトークン保存失敗:", e?.message || e);
  }

  // 💡 【追加】トークンが更新された際に DB を同期する仕組み
  // SpoonV2 内で tokenRefresh() が呼ばれると token プロパティが書き換わります
  setInterval(async () => {
    try {
      await upsertAccountTokens(db, "MONITOR", monitorClient.token, monitorClient.refreshToken);
    } catch (e:any) {
      console.error("❌ トークン同期エラー:", e.message);
    }
  }, 1000 * 60 * 30); // 30分ごとに生存確認を兼ねて保存

  return monitorClient;
}

async function monitor() {
  console.log(`\n[${new Date().toLocaleTimeString()}] 🚀 精密監視システム 起動`);

  // 💡 【重要】監視用クライアントを初期化
  const monitorClient = await setupClients(); 
  
  while (true) {
    try {
      // 💡 クライアントが持っている最新のトークンを使用する
      // もし APIClient を直接使うのが難しい場合は、以下のように client.token を参照します
      const data = await monitorClient.api.live.getSubscribed({ page_size: 50, page: 1 });
      const liveList = data.results || [];
        // DJ_ID は monitorClient.logonUser.id などからも取得可能ですが、今のままでもOK
        const myLive = liveList.find((l: any) => l.author.id.toString() === CONFIG.DJ_ID);
        if (myLive && !workerProcess) {
          // --- 1. 配信開始：メタデータ生成 ---
          const liveId = myLive.id.toString();
          const startTime = new Date().toISOString();

          // 💡 フォルダ用タイムスタンプ (YYYYMMDD_HHmmss)
          const ts = new Date()
            .toLocaleString("ja-JP", {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })
            .replace(/[\/\s:]/g, "");

          // 💡 ファイルシステム禁止文字を置換
          const safeTitle = myLive.title.replace(/[\\/:*?"<>|]/g, "_");
          const folderName = `${ts}_${safeTitle}`;

          console.log(`\n[${new Date().toLocaleTimeString()}] ✅ 配信検知: "${myLive.title}"`);

          isStopping = false;
          // 引数として startTime, safeTitle, folderName を追加
          // index.ts の修正箇所
          workerProcess = spawn("pnpm", ["tsx", "collector.ts", liveId, startTime, safeTitle, folderName], {
            stdio: ["pipe", "inherit", "inherit", "ipc"],
            shell: true,
          });

          workerProcess.on("exit", () => {
            console.log(`\n[${new Date().toLocaleTimeString()}] 🏁 ワーカー終了。`);
            workerProcess = null;
            isStopping = false;
          });
        } else if (!myLive && workerProcess && !isStopping) {
          // --- 2. 配信終了検知 ---
          isStopping = true;
          console.log(`\n[${new Date().toLocaleTimeString()}] 🛑 終了を確認。停止命令を送信...`);
          workerProcess.stdin?.write("exit\n");

          setTimeout(() => {
            if (workerProcess) {
              console.log("\n⚠️ 強制終了します。");
              workerProcess.kill("SIGKILL");
            }
          }, 30000);
        }
        // ... (ステータス表示ロジック) ...
    } catch (err: any) {
      console.error(`\n⚠️ エラー:`, err.message);
    }
    await new Promise((r) => setTimeout(r, CONFIG.CHECK_INTERVAL));
  }
}

monitor();
