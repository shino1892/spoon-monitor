import { SpoonV2, Country } from "@sopia-bot/core";
import fs from "fs";
import path from "path";
import "dotenv/config";
import { Client } from "pg";

const [, , liveId, liveStartTime, liveTitle, folderName] = process.argv;
if (!liveId) process.exit(1);

const db = new Client({
  host: "192.168.0.56", // DBコンテナのIP
  user: "spoon_user",
  password: "Spoon_User",
  database: "spoon_monitor",
});

const CONFIG = { TOKEN: process.env.COLLECTOR_TOKEN! };

const POLL_INTERVAL_MS = 5000;

interface UserActivity {
  userId: number;
  nickname: string;
  accountAge: string;
  fanRank: number;
  firstSeen: string;
  lastSeen: string;
  staySeconds: number;
  entryCount: number;
  counts: { chat: number; heart: number; spoon: number };
}

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
  } catch (error : any) {
    console.error("❌ 送信中にエラーが発生しました:", error.message);
  }
}

async function finishStream(summary: any) {
  try {
    console.log("🗄️ データを PostgreSQL に保存中...");
    await db.connect();

    // 1. 配信サマリーを保存し、その ID を取得
    const reportQuery = `
      INSERT INTO live_reports (live_id, title, dj_name, duration, likes, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id;
    `;
    const reportValues = [summary.id, summary.title, summary.dj_name, summary.duration, summary.likes];
    const reportRes = await db.query(reportQuery, reportValues);
    const reportId = reportRes.rows[0].id; // 👈 この ID をリスナーデータに使用

    // 2. リスナーデータを一括（またはループ）で保存
    console.log(`👥 リスナー ${summary.userStats.size} 名の活動記録を保存中...`);

    for (const [userId, stats] of summary.userStats) {
      const listenerQuery = `
        INSERT INTO listener_activities (
          report_id, user_id, nickname, stay_seconds, entry_count, 
          chat_count, heart_count, spoon_count, first_seen, last_seen
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
      `;
      const listenerValues = [reportId, userId, stats.nickname, Math.floor(stats.staySeconds), stats.entryCount, stats.counts.chat, stats.counts.heart, stats.counts.spoon, stats.firstSeen, stats.lastSeen];
      await db.query(listenerQuery, listenerValues);
    }

    // 3. Discord へレポート送信
    await sendBotMessage(`
📊 **配信終了レポート (管理番号: ${reportId})**
━━━━━━━━━━━━━━
🎤 **タイトル**: ${summary.title}
🕒 **配信時間**: ${summary.duration} 分
❤️ **合計いいね**: ${summary.likes}
👥 **総リスナー数**: ${summary.userStats.size} 名
━━━━━━━━━━━━━━
✅ 全リスナーの活動データも保存されました。
    `);
  } catch (err) {
    console.error("❌ 終了処理エラー:", err.message);
  } finally {
    await db.end();
    process.exit(0);
  }
}

async function startCollector() {
  const client = new SpoonV2(Country.JAPAN);
  await client.init();
  await client.setToken(CONFIG.TOKEN);

  const live = client.live;
  const userStats = new Map<number, UserActivity>();
  let currentListeners = new Set<number>();
  let totalLikes = 0; // 💡 枠全体のいいね合計
  let pollInterval: NodeJS.Timeout;

  // 💡 共通の入室処理（二重カウント防止付）
  const handleEntry = (user: any, nowISO: string) => {
    const userId = user.id || user.userId;
    if (!userStats.has(userId)) {
      console.log(`[Join] ${user.nickname} (初回入室)`);
      userStats.set(userId, {
        userId,
        nickname: user.nickname,
        accountAge: user.date_joined || user.dateJoined || "",
        fanRank: user.fan_rank || 0,
        firstSeen: nowISO,
        lastSeen: nowISO,
        staySeconds: 0,
        entryCount: 1,
        counts: { chat: 0, heart: 0, spoon: 0 },
      });
    } else if (!currentListeners.has(userId)) {
      // 💡 すでにデータがあるが、前回の監視でいなかった場合は「再入室」
      const stats = userStats.get(userId)!;
      stats.entryCount++;
      stats.lastSeen = nowISO;
      console.log(`[Re-join] ${user.nickname} (累計: ${stats.entryCount}回)`);
    }
    // 💡 重要：入室を検知したら即座に生存リストに加える（ポーリングとの二重計上防止）
    currentListeners.add(userId);
  };

  const pollListeners = async () => {
    try {
      const url = `https://jp-api.spooncast.net/lives/${liveId}/listeners/?total_count=true`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${CONFIG.TOKEN}` } });

      // レートリミット等で失敗した場合はスキップ
      if (!res.ok) {
        if (res.status === 429) console.warn("⚠️ レートリミットに抵触しています。間隔を広げてください。");
        return;
      }

      const data: any = await res.json();
      const latestListeners = data.results || [];
      const latestIds = new Set<number>(latestListeners.map((u: any) => u.id));
      const nowISO = new Date().toISOString();

      // 生存確認と入室処理
      latestListeners.forEach((user: any) => {
        handleEntry(user, nowISO);

        // 滞在時間の積み上げ (10秒)
        const stats = userStats.get(user.id)!;
        stats.staySeconds += POLL_INTERVAL_MS / 1000;
        stats.lastSeen = nowISO;
        if (!stats.accountAge && user.date_joined) stats.accountAge = user.date_joined;
      });

      // 退室のログ出力（currentListenersにあってlatestIdsにない人）
      currentListeners.forEach((id) => {
        if (!latestIds.has(id)) {
          const s = userStats.get(id);
          console.log(`[Leave] ${s?.nickname || id} が退室しました`);
        }
      });

      // 💡 生存リストを最新に更新
      currentListeners = latestIds;
    } catch (e) {
      console.error("Polling Error:", e);
    }
  };

  // 💡 【統合・修正版】終了処理関数
  const saveAndExit = async () => {
    if (pollInterval) clearInterval(pollInterval);
    console.log("🛑 配信終了処理を開始します...");

    const liveEndTime = new Date().toISOString();
    const durationSeconds = Math.floor((Date.now() - new Date(liveStartTime).getTime()) / 1000);
    const durationMinutes = Math.floor(durationSeconds / 60);

    // 1. JSON用データ作成
    const finalReport = {
      live_info: {
        live_id: liveId,
        title: liveTitle,
        start_time: liveStartTime,
        end_time: liveEndTime,
        duration_seconds: durationSeconds,
      },
      users: Object.fromEntries(userStats),
    };

    // 2. DB/Discord用まとめ
    const summaryForDB = {
      id: liveId,
      title: liveTitle,
      dj_name: "shino",
      duration: durationMinutes,
      likes: totalLikes,
      userStats: userStats,
    };

    try {
      // JSON保存
      const dataDir = path.join(process.cwd(), "data", folderName);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "summary.json"), JSON.stringify(finalReport, null, 2));
      console.log(`💾 JSON保存完了: ${folderName}/summary.json`);

      // 🚀 PostgreSQL保存 & Discord通知 (await で完了を待つ)
      await finishStream(summaryForDB);
    } catch (e) {
      console.error("❌ 終了保存エラー:", e);
    } finally {
      process.exit(0);
    }
  };

  pollInterval = setInterval(pollListeners, 10000);

  pollListeners();

  // 💡 終了シグナルの受け取りを async に対応
  process.stdin.on("data", async (d) => {
    if (d.toString().trim() === "exit") await saveAndExit();
  });
  process.on("SIGTERM", async () => await saveAndExit());

  live.on("event:all", (eventName, payload) => {
    const nowISO = new Date().toISOString();
    const gen = (payload as any).generator || (payload as any).author || (payload as any).user || payload;
    const userId = (gen as any)?.id || (gen as any)?.userId;
    if (!userId) return;

    handleEntry(gen, nowISO);
    const stats = userStats.get(userId)!;
    stats.lastSeen = nowISO;

    const eName = eventName.toLowerCase();

    // 💡 カウント処理の整理
    if (eName.includes("chat")) {
      stats.counts.chat++;
    } else if (eName.includes("like")) {
      const count = (payload as any).count || 1;
      stats.counts.heart += count; // ユーザー個別のカウント
      totalLikes += count; // 👈 枠全体のカウントをここで更新
    } else if (eName.includes("present")) {
      stats.counts.spoon += (payload as any).amount || 0;
    }

    // 💡 配信終了検知
    if (eventName === "LiveMetaUpdate" && (payload as any).streamStatus && ((payload as any).streamStatus === "FINISHED" || (payload as any).streamStatus === "STOP")) {
      saveAndExit(); // ここは await なしでも saveAndExit 内部で処理されます
    }
  });

  try {
    await live.join(parseInt(liveId));
    console.log(`📡 収集開始 (Title: ${liveTitle})`);
  } catch (err) {
    console.error("❌ 入室失敗:", err);
    process.exit(1);
  }
}

startCollector();
