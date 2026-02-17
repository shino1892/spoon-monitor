import { SpoonV2, Country } from "@sopia-bot/core";
import fs from "fs";
import path from "path";
import "dotenv/config";
import { Client } from "pg";
import { EventName } from "./events";
import { loadAccountTokens, upsertAccountTokens } from "../db/token-store";

const [, , liveIdRaw, liveStartTime, liveTitle, folderName] = process.argv;
if (!liveIdRaw) process.exit(1);
const liveId = Number(liveIdRaw);
if (!Number.isFinite(liveId)) process.exit(1);

const db = new Client({
  host: "192.168.0.56", // DBコンテナのIP
  user: "spoon_user",
  password: "Spoon_User",
  database: "spoon_monitor",
});

const POLL_INTERVAL_MS = 10_000;

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
  } catch (error) {
    console.error("❌ 送信中にエラーが発生しました:", error.message);
  }
}

async function finishStream(summary: any) {
  try {
    console.log("🗄️ データを PostgreSQL に保存中...");

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

async function setupClients() {
  const djClient = new SpoonV2(Country.JAPAN);
  await djClient.init();

  // DBを正とする（無ければ.envにフォールバック）
  try {
    await db.connect();
  } catch (e: any) {
    console.warn("⚠️ DB接続に失敗。トークン永続化なしで続行:", e?.message || e);
  }

  let accessToken = process.env.DJ_ACCESS_TOKEN;
  let refreshToken = process.env.DJ_REFRESH_TOKEN;

  try {
    const fromDb = await loadAccountTokens(db, "DJ");
    if (fromDb) {
      accessToken = fromDb.accessToken;
      refreshToken = fromDb.refreshToken;
    }
  } catch (e: any) {
    console.warn("⚠️ DBトークン読み込み失敗。envで続行:", e?.message || e);
  }

  if (!accessToken || !refreshToken) {
    throw new Error("DJ token is missing (DB/env)");
  }

  // トークンのセット（これで自動更新が有効になります）
  await djClient.setToken(accessToken, refreshToken);

  // 起動時点のトークンをDBへ反映
  try {
    await upsertAccountTokens(db, "DJ", djClient.token, djClient.refreshToken);
  } catch (e: any) {
    console.warn("⚠️ DBトークン保存失敗:", e?.message || e);
  }

  // 💡 【追加】トークンが更新された際に DB を同期する仕組み
  // SpoonV2 内で tokenRefresh() が呼ばれると token プロパティが書き換わります
  setInterval(async () => {
    try {
      await upsertAccountTokens(db, "DJ", djClient.token, djClient.refreshToken);

    } catch (e:any) {
      console.error("❌ トークン同期エラー:", e.message);
    }
  }, 1000 * 60 * 30); // 30分ごとに生存確認を兼ねて保存

  return djClient;
}

async function startCollector() {
  const client = await setupClients();

  const live = client.live;
  const userStats = new Map<number, UserActivity>();
  let currentListeners = new Set<number>();
  let totalLikes = 0; // 💡 枠全体のいいね合計
  let pollInterval: NodeJS.Timeout;

  // setupClients() 内でDB接続を試行済み（ここでは必須化しない）

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
      const data = await client.api.live.getListeners(liveId);
      const latestListeners = data.results || [];
      const latestIds = new Set<number>(latestListeners.map((u: any) => u.id));
      const nowISO = new Date().toISOString();

      // 生存確認と入室処理
      latestListeners.forEach((user: any) => {
        handleEntry(user, nowISO);

        // 滞在時間の積み上げ (POLL_INTERVAL_MS)
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
    } catch (e: any) {
      console.error("Polling Error:", e?.message || e);
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

  pollInterval = setInterval(pollListeners, POLL_INTERVAL_MS);

  pollListeners();

  // 💡 終了シグナルの受け取りを async に対応
  process.stdin.on("data", async (d) => {
    if (d.toString().trim() === "exit") await saveAndExit();
  });
  process.on("SIGTERM", async () => await saveAndExit());

  live.on("event:all", (eventName: any, payload: any) => {
    const nowISO = new Date().toISOString();
    const gen = payload.generator || payload.author || payload.user || payload;
    const userId = gen?.id || gen?.userId;
    const nickname = gen?.nickname || "リスナー";

    // 💡 【修正点】自分自身（DJ/ボット）のイベントは完全に無視する
    if (!userId || userId.toString() === process.env.DJ_ID) {
      return; 
    }

    handleEntry(gen, nowISO);
    const stats = userStats.get(userId)!;
    stats.lastSeen = nowISO;

    const eName = eventName;

    // 💡 カウント処理の整理
    if (eName === EventName.CHAT_MESSAGE) {
      stats.counts.chat++;
    } else if (eName === EventName.LIVE_FREE_LIKE || eName === EventName.LIVE_PAID_LIKE) {
      const count = payload.count || 1;
      stats.counts.heart += count;
      totalLikes += count;
    } else if (eName === EventName.LIVE_DONATION) {
      stats.counts.spoon += payload.amount || 0;
    }

    // --- 2. 未知のイベント処理（サブロジック：非同期・メインを妨げない） ---
    // if (!KNOWN_EVENTS.some(e => eName.includes(e))) {
    //   // 💡 await を付けずに実行することで、DB保存を待たずに次のチャット処理へ移れます
    //   const query = `
    //     INSERT INTO unknown_events (live_id, event_name, payload)
    //     VALUES ($1, $2, $3);
    //   `;
    //   db.query(query, [liveId, eventName, JSON.stringify(payload)])
    //     .then(() => console.log(`🔍 未知イベント保存完了: ${eventName}`))
    //     .catch(err => console.error("❌ 未知イベント保存失敗:", err.message));
    
    //   // 💡 重要：ここでも await しないことで、メインループを止めません
    // }

    // --- 3. 自動ハーコメ機能 ---
    // 自分自身のいいねを除外
    if ((eName === EventName.LIVE_FREE_LIKE || eName === EventName.LIVE_PAID_LIKE) && userId?.toString() !== process.env.DJ_ID) {
      const namePrefix = `${nickname}さん\n`;
      const count = payload.count || 1;

      if (count === 1) {
        live.message(`${namePrefix}ハートありがとう！`)
          .catch(err => console.error("❌ ハートお礼送信失敗:", err.message));
      } else if (count < 10) {
        live.message(`${namePrefix}ミニバスターありがとう！`)
          .catch(err => console.error("❌ ハートお礼送信失敗:", err.message));
      } else {
        live.message(`${namePrefix}バスターありがとう！`)
          .catch(err => console.error("❌ ハートお礼送信失敗:", err.message));
      }
    } 

    // 💡 配信終了検知
    if (eventName === EventName.LIVE_META_UPDATE && (payload.streamStatus === "FINISHED" || payload.streamStatus === "STOP")) {
      saveAndExit(); // ここは await なしでも saveAndExit 内部で処理されます
    }
  });

  try {
    await live.join(liveId);
    console.log(`📡 収集開始 (Title: ${liveTitle})`);
    if (process.env.DEBUG_LIVE_METHODS === "1") {
      console.log(
        "🛠️ Liveオブジェクトのプロパティ一覧:",
        Object.getOwnPropertyNames(Object.getPrototypeOf(live)).filter(
          (p) => typeof (live as any)[p] === "function"
        )
      );
    }
  } catch (err) {
    console.error("❌ 入室失敗:", err);
    process.exit(1);
  }
}

startCollector();
