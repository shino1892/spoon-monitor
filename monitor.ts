import { spawn, ChildProcess } from "child_process";
import "dotenv/config";

const CONFIG = {
  DJ_ID: process.env.DJ_ID!,
  TOKEN: process.env.MONITOR_TOKEN!,
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
  } catch (error) {
    console.error("❌ 送信中にエラーが発生しました:", error.message);
  }
}

async function monitor() {
  console.log("🚀 精密監視システム 起動");

  while (true) {
    const now = new Date();
    try {
      const url = `https://jp-api.spooncast.net/lives/subscribed/?ts=${now.getTime()}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${CONFIG.TOKEN}`,
          "User-Agent": "Spoon/8.10.1 (Android; 13; ja-JP)",
          "x-spoon-api-version": "2",
        },
      });

      //console.log(`[Debug] API Status: ${response.status} (Target DJ: ${CONFIG.DJ_ID})`);

      // 460エラー検知時の処理（monitor.ts 内）
      if (response.status === 460) {
        await sendBotMessage(` 🚨 **トークン失効を検知しました**\n監視が止まっています。\n\`!update monitor <token>\` または \`!update dj <token>\` で更新してください。`);
        process.exit(1); // PM2 が自動でリトライしますが、トークンが古い間は止めておく
      }

      if (response.ok) {
        const data: any = await response.json();
        //console.log(`[Debug] Is Live?: ${data.results.length > 0}`);
        const liveList = data.results || [];
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
      }
    } catch (err: any) {
      console.error(`\n⚠️ エラー:`, err.message);
    }
    await new Promise((r) => setTimeout(r, CONFIG.CHECK_INTERVAL));
  }
}

monitor();
