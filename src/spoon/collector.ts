// import { SpoonV2 } from "@sopia-bot/core";
import fs from "fs";
import path from "path";
import "dotenv/config";
import { Client } from "pg";
import { EventName } from "./events";
import { initSpoon } from "../app";

const [, , liveIdRaw, liveStartTime, liveTitle, folderName] = process.argv;
if (!liveIdRaw) process.exit(1);
const liveId = Number(liveIdRaw);
if (!Number.isFinite(liveId)) process.exit(1);

const db = new Client({
  host: "192.168.0.56",
  user: "spoon_user",
  password: "Spoon_User",
  database: "spoon_monitor",
});

const POLL_INTERVAL_MS = (() => {
  const raw = process.env.LISTENER_POLL_INTERVAL;
  if (!raw) return 10_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10_000;
})();
let isDbConnected = false;

const DEBUG_SPOON_EVENTS = process.env.SPOON_DEBUG_EVENTS === "1";
const DEBUG_SPOON_PAYLOAD = process.env.SPOON_DEBUG_PAYLOAD === "1";
const DEBUG_SPOON_UNKNOWN_EVENTS = process.env.SPOON_DEBUG_UNKNOWN_EVENTS === "1";
const DEBUG_SPOON_MAX_CHARS = (() => {
  const raw = process.env.SPOON_DEBUG_MAX_CHARS;
  if (!raw) return 12_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 12_000;
})();

const SENSITIVE_KEYS = new Set(["authorization", "cookie", "set-cookie", "token", "access_token", "accessToken", "refresh_token", "refreshToken", "jwt", "roomJwt", "liveToken", "password"]);

function truncateForLog(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20))}... (truncated ${text.length - maxChars} chars)`;
}

function maskSecret(value: unknown) {
  if (typeof value !== "string") return "[REDACTED]";
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function sanitizeForLog(input: unknown, seen = new WeakSet<object>()): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === "bigint") return input.toString();
  if (typeof input !== "object") return input;

  const obj = input as Record<string, unknown>;
  if (seen.has(obj)) return "[Circular]";
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map((v) => sanitizeForLog(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const keyLower = k.toLowerCase();
    if (SENSITIVE_KEYS.has(keyLower)) {
      out[k] = maskSecret(v);
      continue;
    }
    out[k] = sanitizeForLog(v, seen);
  }
  return out;
}

function dumpJson(label: string, value: unknown) {
  const sanitized = sanitizeForLog(value);
  const json = JSON.stringify(sanitized, null, 2);
  console.log(`${label}:\n${truncateForLog(json, DEBUG_SPOON_MAX_CHARS)}`);
}

function toPositiveInt(value: unknown, fallback = 1) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
}

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
  if (!isDbConnected) {
    throw new Error("DB未接続のため保存できません");
  }

  let reportId: number | null = null;
  try {
    console.log("🗄️ データを PostgreSQL に保存中...");
    await db.query("BEGIN");

    const reportQuery = `
      INSERT INTO live_reports (live_id, title, dj_name, duration, likes, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id;
    `;
    const reportValues = [summary.id, summary.title, summary.dj_name, summary.duration, summary.likes];
    const reportRes = await db.query(reportQuery, reportValues);
    reportId = reportRes.rows[0].id;

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

    await db.query("COMMIT");

    const verifyRes = await db.query("SELECT COUNT(*)::int AS count FROM listener_activities WHERE report_id = $1", [reportId]);
    console.log(`✅ DB保存完了 report_id=${reportId} listener_count=${verifyRes.rows[0].count}`);

    await sendBotMessage(`
📊 **配信終了レポート (管理番号: ${reportId})**
━━━━━━━━━━━━━━
🎤 **タイトル**: ${summary.title}
🕒 **配信時間**: ${summary.duration} 分
❤️ **合計いいね**: ${summary.likes}
👥 **総リスナー数**: ${summary.userStats.size} 名
━━━━━━━━━━━━━━
✅ 全リスナーの活動データも保存されました。(保存件数: ${verifyRes.rows[0].count})
    `);
  } catch (err: any) {
    try {
      await db.query("ROLLBACK");
    } catch {}
    throw new Error(`終了処理エラー: ${err?.message || err}`);
  }
}

async function setupClients() {
  const djClient = await initSpoon("DJ");

  // レポート保存用DB接続（トークンはenvのみで管理）
  try {
    await db.connect();
    isDbConnected = true;
  } catch (e: any) {
    isDbConnected = false;
    console.warn("⚠️ DB接続に失敗。DB保存なしで続行:", e?.message || e);
  }

  return djClient;
}

async function startCollector() {
  const startupLog = `\n[${new Date().toLocaleTimeString()}] 🚀 collector 起動 (liveId: ${liveId})`;
  console.log(startupLog);
  await sendBotMessage(startupLog);

  const client = await setupClients();

  const live = client.live;
  const userStats = new Map<number, UserActivity>();
  let currentListeners = new Set<number>();
  let totalLikes = 0; // 💡 枠全体のいいね合計
  let pollInterval: NodeJS.Timeout;
  let isShuttingDown = false;

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
    if (isShuttingDown) return;
    isShuttingDown = true;

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
    } catch (e: any) {
      const message = `❌ 終了保存エラー: ${e?.message || e}`;
      console.error(message);
      await sendBotMessage(message);
    } finally {
      if (isDbConnected) {
        try {
          await db.end();
        } catch {}
      }
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

  const knownEventNames = new Set<string>(Object.values(EventName));
  const unknownEventNames = new Set<string>();

  live.on("event:all", (eventName: any, payload: any, raw: any) => {
    const nowISO = new Date().toISOString();
    const eName = String(eventName);
    const gen = payload?.generator || payload?.author || payload?.user || payload;
    const extractedUserId = gen?.id ?? gen?.userId ?? payload?.userId ?? payload?.memberId ?? payload?.authorId;
    const userId = extractedUserId !== undefined && extractedUserId !== null ? Number(extractedUserId) : undefined;
    const nickname = gen?.nickname || payload?.nickname || "リスナー";

    const djId = process.env.DJ_ID;
    const isSelf = userId !== undefined && djId && userId.toString() === djId;

    if (DEBUG_SPOON_EVENTS) {
      console.log(`[event] ${eName} userId=${userId ?? "(none)"} nick=${nickname} self=${isSelf}`);
    }
    if (DEBUG_SPOON_PAYLOAD) {
      dumpJson(`[payload] ${eName}`, payload);
      dumpJson(`[raw] ${eName}`, raw);
    }

    if (DEBUG_SPOON_UNKNOWN_EVENTS && !knownEventNames.has(eName) && !unknownEventNames.has(eName)) {
      unknownEventNames.add(eName);
      console.warn(`⚠️ 未対応イベント検知: ${eName}`);
      if (DEBUG_SPOON_PAYLOAD) {
        dumpJson(`[unknown payload] ${eName}`, payload);
        dumpJson(`[unknown raw] ${eName}`, raw);
      }
    }

    // 💡 自分自身（DJ/ボット）由来のユーザーイベントは無視
    if (isSelf) return;

    // 💡 userId が取れるイベントだけ入室/カウント処理をする（MetaUpdate等は userId が無い）
    let stats: UserActivity | undefined;
    if (userId !== undefined && Number.isFinite(userId)) {
      handleEntry(gen, nowISO);
      stats = userStats.get(userId);
      if (stats) stats.lastSeen = nowISO;
    }

    if (userId !== undefined) {
      console.log(`${nickname}さんから、${eName}を検知しました。`);
    } else {
      console.log(`${eName} を検知しました。`);
    }

    // 💡 カウント処理の整理
    if (stats && eName === EventName.CHAT_MESSAGE) {
      console.log(`「${payload.message}」を受信しました。`);
      stats.counts.chat++;
    } else if (stats && (eName === EventName.LIVE_FREE_LIKE || eName === EventName.LIVE_PAID_LIKE)) {
      // FreeLike は count, PaidLike は amount (core の型定義)
      const likeCount = eName === EventName.LIVE_PAID_LIKE ? toPositiveInt(payload?.amount, 1) : toPositiveInt(payload?.count, 1);

      stats.counts.heart += likeCount;
      totalLikes += likeCount;

      console.log(`ハート数：${likeCount}`);
    } else if (stats && eName === EventName.LIVE_DONATION) {
      stats.counts.spoon += payload.amount || 0;

      console.log(`${payload.amount}スプーンをもらいました。`);
    }

    // --- 3. 自動ハーコメ機能 ---
    // 自分自身のいいねを除外（上で isSelf return 済み）
    if (stats && (eName === EventName.LIVE_FREE_LIKE || eName === EventName.LIVE_PAID_LIKE)) {
      const namePrefix = `${nickname}さん\n`;
      const likeCount = eName === EventName.LIVE_PAID_LIKE ? toPositiveInt(payload?.amount, 1) : toPositiveInt(payload?.count, 1);

      if (DEBUG_SPOON_EVENTS) {
        console.log(`[auto-message] try send: event=${eName} count=${likeCount} userId=${userId}`);
      }

      if (likeCount === 1) {
        live.message(`${namePrefix}ハートありがとう！`).catch((err) => console.error("❌ ハートお礼送信失敗:", err.message));
      } else if (likeCount < 10) {
        live.message(`${namePrefix}ミニバスターありがとう！`).catch((err) => console.error("❌ ハートお礼送信失敗:", err.message));
      } else {
        live.message(`${namePrefix}バスターありがとう！`).catch((err) => console.error("❌ ハートお礼送信失敗:", err.message));
      }
    }

    // 💡 配信終了検知
    if (eventName === EventName.LIVE_META_UPDATE && (payload.streamStatus === "FINISHED" || payload.streamStatus === "STOP")) {
      saveAndExit(); // ここは await なしでも saveAndExit 内部で処理されます
    }
  });

  try {
    await live.join(liveId);
    const collectStartLog = `📡 収集開始 (Title: ${liveTitle})`;
    console.log(collectStartLog);
    await sendBotMessage(collectStartLog);
    if (process.env.DEBUG_LIVE_METHODS === "1") {
      console.log(
        "🛠️ Liveオブジェクトのプロパティ一覧:",
        Object.getOwnPropertyNames(Object.getPrototypeOf(live)).filter((p) => typeof (live as any)[p] === "function"),
      );
    }
  } catch (err) {
    console.error("❌ 入室失敗:", err);
    process.exit(1);
  }
}

startCollector();
