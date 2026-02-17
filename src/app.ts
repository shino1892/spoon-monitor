import "dotenv/config";

// @sopia-bot/core のHTTP DEBUGログには Authorization が含まれるため、デフォルトで抑制
// 必要なときだけ `SOPIA_HTTP_DEBUG=1` で有効化する
if (process.env.SOPIA_HTTP_DEBUG !== "1") {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.debug = () => {};
}
import fs from "fs";
import path from "path";
import { Client } from "pg";
import { SpoonV2, Country, LogLevel } from "@sopia-bot/core";
import { EventName } from "./spoon/events";
import { loadAccountTokens, upsertAccountTokens } from "./db/token-store";
import { sendDiscordMessage } from "./discord/notifier";

const DISCORD_ALERT_THROTTLE_MS = Number(process.env.DISCORD_ALERT_THROTTLE_MS || "3600000"); // default: 1h
const discordThrottleState = new Map<string, number>();
const TOKEN_REFRESH_BACKOFF_MS = Number(process.env.TOKEN_REFRESH_BACKOFF_MS || "300000"); // default: 5min
let tokenRefreshBackoffUntil = 0;
const SPOON_HTTP_ANOMALY_BACKOFF_MS = Number(process.env.SPOON_HTTP_ANOMALY_BACKOFF_MS || "600000"); // default: 10min
const TOKEN_EXPIRED_LOG_THROTTLE_MS = Number(process.env.TOKEN_EXPIRED_LOG_THROTTLE_MS || "60000"); // default: 60s
let lastTokenExpiredLogAt = 0;
const HTTP_ANOMALY_LOG_THROTTLE_MS = Number(process.env.HTTP_ANOMALY_LOG_THROTTLE_MS || "60000"); // default: 60s
let lastHttpAnomalyLogAt = 0;

const db = new Client({
  host: "192.168.0.56",
  user: "spoon_user",
  password: "Spoon_User",
  database: "spoon_monitor",
});

const CONFIG = {
  DJ_ID: process.env.DJ_ID!,
  DETECT_ACCOUNT: (process.env.DETECT_ACCOUNT || "MONITOR") as "DJ" | "MONITOR",
  USE_LIVE_CHECK: process.env.USE_LIVE_CHECK !== "0",
  AUTO_THANKS: process.env.AUTO_THANKS !== "0",
  DIAG_DETECT: process.env.DIAG_DETECT === "1",
  DIAG_COMPARE_CLIENTS: process.env.DIAG_COMPARE_CLIENTS === "1",
  DJ_DETECT_FALLBACK_MONITOR: process.env.DJ_DETECT_FALLBACK_MONITOR === "1",
  CHECK_INTERVAL_MS: Number(process.env.CHECK_INTERVAL || "30000"),
  LISTENER_POLL_INTERVAL_MS: Number(process.env.LISTENER_POLL_INTERVAL || "10000"),
  END_CHECK_INTERVAL_MS: Number(process.env.END_CHECK_INTERVAL || "15000"),
  HTTP_END_CONFIRMATIONS: Number(process.env.HTTP_END_CONFIRMATIONS || "2"),
  WS_HINT_GRACE_MS: Number(process.env.WS_HINT_GRACE_MS || "90000"),
};

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

type Session = {
  liveId: number;
  title: string;
  startTimeIso: string;
  folderName: string;
  userStats: Map<number, UserActivity>;
  currentListeners: Set<number>;
  totalLikes: number;
  wsEndHintAt: number | null;
  consecutiveHttpEnd: number;
  consecutiveInfoErrors: number;
  consecutiveCheckErrors: number;
  finishing: boolean;
  stopRequested: boolean;
  removeHandlers: () => void;
};

async function sendBotMessage(content: string) {
  try {
    await sendDiscordMessage(content);
  } catch (e: any) {
    console.error("❌ Discord通知エラー:", e?.message || e);
  }
}

async function sendBotMessageThrottled(key: string, content: string, minIntervalMs = DISCORD_ALERT_THROTTLE_MS) {
  const now = Date.now();
  const last = discordThrottleState.get(key) || 0;
  if (now - last < minIntervalMs) {
    return;
  }
  discordThrottleState.set(key, now);
  await sendBotMessage(content);
}

function makeFolderName(title: string) {
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

  const safeTitle = title.replace(/[\\/:*?"<>|]/g, "_");
  return `${ts}_${safeTitle}`;
}

async function saveToDbAndDiscord(summary: {
  id: number;
  title: string;
  djName: string;
  durationMinutes: number;
  likes: number;
  userStats: Map<number, UserActivity>;
}) {
  // 1. 配信サマリーを保存し、その ID を取得
  const reportQuery = `
    INSERT INTO live_reports (live_id, title, dj_name, duration, likes, created_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    RETURNING id;
  `;
  const reportValues = [summary.id.toString(), summary.title, summary.djName, summary.durationMinutes, summary.likes];
  const reportRes = await db.query(reportQuery, reportValues);
  const reportId = reportRes.rows[0].id;

  // 2. リスナーデータを保存
  for (const [userId, stats] of summary.userStats) {
    const listenerQuery = `
      INSERT INTO listener_activities (
        report_id, user_id, nickname, stay_seconds, entry_count,
        chat_count, heart_count, spoon_count, first_seen, last_seen
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
    `;
    const listenerValues = [
      reportId,
      userId,
      stats.nickname,
      Math.floor(stats.staySeconds),
      stats.entryCount,
      stats.counts.chat,
      stats.counts.heart,
      stats.counts.spoon,
      stats.firstSeen,
      stats.lastSeen,
    ];
    await db.query(listenerQuery, listenerValues);
  }

  await sendBotMessage(`
📊 **配信終了レポート (管理番号: ${reportId})**
━━━━━━━━━━━━━━
🎤 **タイトル**: ${summary.title}
🕒 **配信時間**: ${summary.durationMinutes} 分
❤️ **合計いいね**: ${summary.likes}
👥 **総リスナー数**: ${summary.userStats.size} 名
━━━━━━━━━━━━━━
✅ 全リスナーの活動データも保存されました。
  `);
}

async function initClientFromDbOrEnv(accountType: "DJ" | "MONITOR") {
  const client = new SpoonV2(Country.JAPAN, { logLevel: LogLevel.WARN });
  await client.init();

  let accessToken: string | undefined;
  let refreshToken: string | undefined;

  try {
    const fromDb = await loadAccountTokens(db, accountType);
    if (fromDb) {
      accessToken = fromDb.accessToken;
      refreshToken = fromDb.refreshToken;
    }
  } catch (e: any) {
    console.warn("⚠️ DBトークン読み込み失敗。envで続行:", e?.message || e);
  }

  if (!accessToken || !refreshToken) {
    if (accountType === "DJ") {
      accessToken = process.env.DJ_ACCESS_TOKEN;
      refreshToken = process.env.DJ_REFRESH_TOKEN;
    } else {
      accessToken = process.env.MONITOR_ACCESS_TOKEN;
      refreshToken = process.env.MONITOR_REFRESH_TOKEN;
    }
  }

  if (!accessToken || !refreshToken) {
    throw new Error(`${accountType} token is missing (DB/env)`);
  }

  await client.setToken(accessToken, refreshToken);

  // どのユーザーとしてログインしているか（トークン取り違え切り分け用）
  try {
    const u: any = (client as any).logonUser;
    if (u?.id) {
      console.log(`👤 ${accountType} client logonUser: ${u.id} (${u.nickname || u.tag || ""})`);
    }
  } catch {}

  // 起動時点のトークンをDBへ反映
  try {
    await upsertAccountTokens(db, accountType, client.token, client.refreshToken);
  } catch (e: any) {
    console.warn("⚠️ DBトークン保存失敗:", e?.message || e);
  }

  // 30分ごとにトークンをDBへ反映
  setInterval(async () => {
    try {
      await upsertAccountTokens(db, accountType, client.token, client.refreshToken);
    } catch (e: any) {
      console.error(`❌ ${accountType} トークン同期エラー:`, e?.message || e);
    }
  }, 1000 * 60 * 30);

  return client;
}

function handleEntry(
  session: Session,
  user: any,
  nowISO: string
) {
  const userId = user.id || user.userId;
  const wasKnown = session.userStats.has(userId);
  if (!session.userStats.has(userId)) {
    session.userStats.set(userId, {
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
  } else if (!session.currentListeners.has(userId)) {
    const stats = session.userStats.get(userId)!;
    stats.entryCount++;
    stats.lastSeen = nowISO;
  }
  session.currentListeners.add(userId);

  if (!wasKnown) {
    const nickname = user.nickname || "(unknown)";
    console.log(`👤 new listener: ${nickname} (${userId})`);
  }
}

async function main() {
  if (!CONFIG.DJ_ID) {
    throw new Error("DJ_ID is required");
  }

  console.log(
    `🔧 config: DETECT_ACCOUNT=${CONFIG.DETECT_ACCOUNT} CHECK_INTERVAL=${CONFIG.CHECK_INTERVAL_MS}ms DIAG_DETECT=${CONFIG.DIAG_DETECT ? "1" : "0"} DIAG_COMPARE_CLIENTS=${CONFIG.DIAG_COMPARE_CLIENTS ? "1" : "0"} DJ_DETECT_FALLBACK_MONITOR=${CONFIG.DJ_DETECT_FALLBACK_MONITOR ? "1" : "0"} USE_LIVE_CHECK=${CONFIG.USE_LIVE_CHECK ? "1" : "0"}`
  );

  try {
    await db.connect();
    console.log("🐘 PostgreSQL 接続完了 (192.168.0.56)");
  } catch (e: any) {
    console.warn("⚠️ DB接続に失敗。DB保存なしで続行:", e?.message || e);
  }

  const monitorClient = await initClientFromDbOrEnv("MONITOR");
  const djClient = await initClientFromDbOrEnv("DJ");

  // DJ_IDとDJトークンのユーザーが一致するかを確認（ズレてると自己検知は成立しません）
  try {
    const djUser: any = (djClient as any).logonUser;
    if (djUser?.id && djUser.id.toString() !== CONFIG.DJ_ID) {
      console.warn(
        `⚠️ DJ token user mismatch: DJ_ID=${CONFIG.DJ_ID} but DJ token is ${djUser.id} (${djUser.nickname || djUser.tag || ""})`
      );
    }
  } catch {}

  let session: Session | null = null;

  const finishSession = async () => {
    if (!session || session.finishing) return;
    session.finishing = true;

    try {
      console.log(`✅ finishing session (LiveId: ${session.liveId}, Title: ${session.title})`);
      const liveEndTime = new Date().toISOString();
      const durationSeconds = Math.floor(Date.now() - new Date(session.startTimeIso).getTime());
      const durationMinutes = Math.floor(durationSeconds / 1000 / 60);

      const finalReport = {
        live_info: {
          live_id: session.liveId,
          title: session.title,
          start_time: session.startTimeIso,
          end_time: liveEndTime,
          duration_seconds: Math.floor(durationSeconds / 1000),
        },
        users: Object.fromEntries(session.userStats),
      };

      const dataDir = path.join(process.cwd(), "data", session.folderName);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "summary.json"), JSON.stringify(finalReport, null, 2));
      console.log(`💾 saved summary.json -> ${path.join("data", session.folderName, "summary.json")}`);

      // DB接続が成功している場合のみDB保存
      // pg.Clientには公式な接続状態プロパティがないため、ここは例外で判定する
      try {
        await saveToDbAndDiscord({
          id: session.liveId,
          title: session.title,
          djName: "shino",
          durationMinutes,
          likes: session.totalLikes,
          userStats: session.userStats,
        });
      } catch (e: any) {
        console.warn("⚠️ DB保存/Discord通知をスキップ:", e?.message || e);
      }
    } catch (e: any) {
      console.error("❌ 終了保存エラー:", e?.message || e);
    } finally {
      try {
        session.removeHandlers();
      } catch {}
      try {
        await djClient.live.close(true);
      } catch {}
      session = null;
    }
  };

  const startSession = async (liveId: number, title: string) => {
    const nowIso = new Date().toISOString();
    const folderName = makeFolderName(title);

    const newSession: Session = {
      liveId,
      title,
      startTimeIso: nowIso,
      folderName,
      userStats: new Map(),
      currentListeners: new Set(),
      totalLikes: 0,
      wsEndHintAt: null,
      consecutiveHttpEnd: 0,
      consecutiveInfoErrors: 0,
      consecutiveCheckErrors: 0,
      finishing: false,
      stopRequested: false,
      removeHandlers: () => {},
    };

    const live = djClient.live;

    // 配信開始通知（管理者DM/チャンネルは notifier の設定に従う）
    await sendBotMessage(`🎬 **配信開始**\n🎤 タイトル: ${title}\n🆔 LiveId: ${liveId}\n🕒 開始: ${nowIso}`);

    const onEventAll = (eventName: any, payload: any) => {
      const nowISO = new Date().toISOString();
      const gen = payload.generator || payload.author || payload.user || payload;
      const userId = gen?.id || gen?.userId;
      const nickname = gen?.nickname || "リスナー";

      if (!userId || userId.toString() === process.env.DJ_ID) return;

      handleEntry(newSession, gen, nowISO);
      const stats = newSession.userStats.get(userId)!;
      stats.lastSeen = nowISO;

      const eName = eventName;

      if (eName === EventName.CHAT_MESSAGE) {
        stats.counts.chat++;
      } else if (eName === EventName.LIVE_FREE_LIKE || eName === EventName.LIVE_PAID_LIKE) {
        const count = payload.count || 1;
        stats.counts.heart += count;
        newSession.totalLikes += count;

        console.log(`❤️ like +${count} from ${nickname} (${userId})`);

        // 自動お礼（必要なら）
        if (
          CONFIG.AUTO_THANKS &&
          (eName === EventName.LIVE_FREE_LIKE || eName === EventName.LIVE_PAID_LIKE) &&
          userId?.toString() !== process.env.DJ_ID
        ) {
          const namePrefix = `${nickname}さん\n`;
          const msg =
            count === 1
              ? `${namePrefix}ハートありがとう！`
              : count < 10
                ? `${namePrefix}ミニバスターありがとう！`
                : `${namePrefix}バスターありがとう！`;

          void live
            .message(msg)
            .then(() => {
              console.log(`💬 auto-reply sent to ${nickname} (${userId})`);
            })
            .catch((e: any) => {
              console.warn(`⚠️ auto-reply failed for ${nickname} (${userId}):`, e?.message || e);
            });
        }
      } else if (eName === EventName.LIVE_DONATION) {
        stats.counts.spoon += payload.amount || 0;
      }

      if (eventName === EventName.LIVE_META_UPDATE) {
        if (payload.streamStatus === "FINISHED" || payload.streamStatus === "STOP") {
          newSession.wsEndHintAt = Date.now();
        }
      }
    };

    live.on("event:all", onEventAll);

    newSession.removeHandlers = () => {
      live.off("event:all", onEventAll as any);
    };

    await live.join(liveId);
    console.log(`📡 収集開始 (LiveId: ${liveId}, Title: ${title})`);

    session = newSession;

    // リスナーポーリング（滞在時間用）
    const listenerPoller = setInterval(async () => {
      if (!session || session.finishing || session.liveId !== liveId) return;
      if (tokenRefreshBackoffUntil && Date.now() < tokenRefreshBackoffUntil) return;
      try {
        const data = await djClient.api.live.getListeners(liveId);
        const latestListeners = data.results || [];
        const latestIds = new Set<number>(latestListeners.map((u: any) => u.id));
        const nowISO = new Date().toISOString();

        latestListeners.forEach((user: any) => {
          handleEntry(newSession, user, nowISO);
          const stats = newSession.userStats.get(user.id)!;
          stats.staySeconds += CONFIG.LISTENER_POLL_INTERVAL_MS / 1000;
          stats.lastSeen = nowISO;
        });

        newSession.currentListeners = latestIds;
      } catch (e: any) {
        // ポーリング失敗は終了扱いにしない
        console.warn("⚠️ listeners poll failed:", e?.message || e);
      }
    }, CONFIG.LISTENER_POLL_INTERVAL_MS);

    // 終了確定（HTTP併用）
    const endChecker = setInterval(async () => {
      if (!session || session.finishing || session.liveId !== liveId) return;
      if (tokenRefreshBackoffUntil && Date.now() < tokenRefreshBackoffUntil) return;

      let endEvidence = 0;
      try {
        const info = await djClient.api.live.getInfo(liveId);
        newSession.consecutiveInfoErrors = 0;
        if ((info as any).closed === true) {
          endEvidence += 2;
        }
      } catch (e: any) {
        newSession.consecutiveInfoErrors++;
        if (newSession.consecutiveInfoErrors >= 2) {
          endEvidence += 1;
        }
      }

      // /lives/{userId}/check/ を併用（API側の終了反映が遅いケースに強い）
      if (CONFIG.USE_LIVE_CHECK) {
        try {
          const checkRes: any = await djClient.api.live.check(Number(CONFIG.DJ_ID));
          newSession.consecutiveCheckErrors = 0;

          const results = Array.isArray(checkRes?.results) ? checkRes.results : [];
          const status = results[0]?.status;
          // status: 1 진행중 / 2 정상 종료 / -2 비정상 종료
          if (status === 2 || status === -2) {
            endEvidence += 2;
          }
        } catch (e: any) {
          newSession.consecutiveCheckErrors++;
          // checkが連続で失敗する場合は弱い終了証拠として扱う
          if (newSession.consecutiveCheckErrors >= 3) {
            endEvidence += 1;
          }
        }
      }

      if (endEvidence > 0) {
        newSession.consecutiveHttpEnd++;
      } else {
        newSession.consecutiveHttpEnd = 0;
      }

      const wsHintActive =
        newSession.wsEndHintAt !== null &&
        Date.now() - newSession.wsEndHintAt < CONFIG.WS_HINT_GRACE_MS;

      const shouldFinish =
        newSession.consecutiveHttpEnd >= CONFIG.HTTP_END_CONFIRMATIONS ||
        (wsHintActive && newSession.consecutiveHttpEnd >= 1);

      if (shouldFinish) {
        clearInterval(listenerPoller);
        clearInterval(endChecker);
        await finishSession();
      }
    }, CONFIG.END_CHECK_INTERVAL_MS);

    // セッション終了時にタイマーも止める
    const prevRemove = newSession.removeHandlers;
    newSession.removeHandlers = () => {
      clearInterval(listenerPoller);
      clearInterval(endChecker);
      prevRemove();
    };
  };

  const detectLoop = async () => {
    if (session) return;
    const detectClient = CONFIG.DETECT_ACCOUNT === "DJ" ? djClient : monitorClient;

    // トークン失効(460)が続く間はバックオフしてAPI連打を避ける
    if (tokenRefreshBackoffUntil && Date.now() < tokenRefreshBackoffUntil) return;

    try {
      // MONITOR検知: 購読配信一覧からDJの配信を見つける
      if (CONFIG.DETECT_ACCOUNT !== "DJ") {
        const data = await detectClient.api.live.getSubscribed({ page_size: 50, page: 1 });
        const liveList = data.results || [];
        const myLive = liveList.find((l: any) => l.author.id.toString() === CONFIG.DJ_ID);
        if (myLive) {
          console.log(`🎬 live detected by ${CONFIG.DETECT_ACCOUNT}: ${myLive.id} (${myLive.title})`);
          await startSession(Number(myLive.id), myLive.title);
        }
        return;
      }

      // DJ自己検知: 自分の current_live_id を見る
      const djId = Number(CONFIG.DJ_ID);
      let liveId = 0;
      let title = "(untitled)";

      const now = Date.now();
      let currentLiveIsLive: boolean | null = null;
      let currentLiveId: number | null = null;
      let userInfoLiveId: number | null = null;

      (detectLoop as any)._lastLiveCheckStatus ??= null;
      (detectLoop as any)._lastLiveCheckLiveId ??= null;
      (detectLoop as any)._lastLiveCheckResultType ??= null;
      (detectLoop as any)._lastLiveCheckStatusCode ??= null;
      let checkStatus: number | null = (detectLoop as any)._lastLiveCheckStatus;
      let checkLiveId: number | null = (detectLoop as any)._lastLiveCheckLiveId;
      let checkResultType: string | null = (detectLoop as any)._lastLiveCheckResultType;
      let checkStatusCode: number | null = (detectLoop as any)._lastLiveCheckStatusCode;

      let monitorCurrentLiveIsLive: boolean | null = null;
      let monitorCurrentLiveId: number | null = null;
      let monitorUserInfoLiveId: number | null = null;

      // /users/{id}/live が最も確実
      try {
        const current: any = await djClient.api.user.getCurrentLive(djId);
        currentLiveIsLive = typeof current?.is_live === "boolean" ? current.is_live : null;
        currentLiveId =
          current?.current_live_id === null || typeof current?.current_live_id === "number"
            ? current.current_live_id
            : typeof current?.currentLiveId === "number"
              ? current.currentLiveId
              : null;
        liveId = Number(currentLiveId || 0);
      } catch {}

      // フォールバック: getUserInfo(include_current_liveが付かないと0になりがち)
      // 1秒間隔だと負荷が高いので、フォールバックは15秒に1回へ間引く
      (detectLoop as any)._lastUserInfoAt ??= 0;
      const lastUserInfoAt = Number((detectLoop as any)._lastUserInfoAt);
      if (liveId <= 0 && now - lastUserInfoAt >= 15000) {
        (detectLoop as any)._lastUserInfoAt = now;
        try {
          const me: any = await djClient.api.user.getUserInfo(djId);
          const meUser: any = Array.isArray(me?.results) ? me.results[0] : me?.results || me;
          userInfoLiveId =
            typeof meUser?.current_live_id === "number"
              ? meUser.current_live_id
              : typeof meUser?.current_live?.id === "number"
                ? meUser.current_live.id
                : typeof meUser?.currentLiveId === "number"
                  ? meUser.currentLiveId
                  : null;
          liveId = Number(userInfoLiveId || 0);
        } catch {}
      }

      // フォールバック（推奨）: MONITORトークンで同じUser APIを叩く
      // 「DJのトークンだけ /users/{id}/live が常にfalse」を切り分けできる
      if (liveId <= 0 && CONFIG.DJ_DETECT_FALLBACK_MONITOR) {
        (detectLoop as any)._lastMonitorUserLiveAt ??= 0;
        const lastMonitorUserLiveAt = Number((detectLoop as any)._lastMonitorUserLiveAt);
        if (now - lastMonitorUserLiveAt >= 5000) {
          (detectLoop as any)._lastMonitorUserLiveAt = now;
          try {
            const current: any = await monitorClient.api.user.getCurrentLive(djId);
            monitorCurrentLiveIsLive = typeof current?.is_live === "boolean" ? current.is_live : null;
            monitorCurrentLiveId =
              current?.current_live_id === null || typeof current?.current_live_id === "number"
                ? current.current_live_id
                : typeof current?.currentLiveId === "number"
                  ? current.currentLiveId
                  : typeof current?.id === "number" && current?.is_live
                    ? current.id
                    : null;
            liveId = Number(monitorCurrentLiveId || 0);
          } catch {}

          // getUserInfoは自分以外でも current_live_id が取れるケースがある
          if (liveId <= 0) {
            try {
              const u: any = await monitorClient.api.user.getUserInfo(djId);
              monitorUserInfoLiveId =
                typeof u?.current_live_id === "number"
                  ? u.current_live_id
                  : typeof u?.current_live?.id === "number"
                    ? u.current_live.id
                    : null;
              liveId = Number(monitorUserInfoLiveId || 0);
            } catch {}
          }
        }
      }

      // 追加診断: /lives/{userId}/check/ の結果も見る（配信中判定に使える可能性がある）
      // 連打を避けるため 5秒に1回へ間引く
      if (liveId <= 0) {
        (detectLoop as any)._lastLiveCheckAt ??= 0;
        const lastLiveCheckAt = Number((detectLoop as any)._lastLiveCheckAt);
        if (now - lastLiveCheckAt >= 5000) {
          (detectLoop as any)._lastLiveCheckAt = now;
          try {
            const checkRes: any = await djClient.api.live.check(djId);
            checkResultType = Array.isArray(checkRes?.results) ? "array" : typeof checkRes?.results;
            checkStatusCode = typeof checkRes?.status_code === "number" ? checkRes.status_code : null;

            const results = Array.isArray(checkRes?.results) ? checkRes.results : null;
            const r0 = results?.[0] ?? checkRes?.results ?? null;
            checkStatus =
              typeof r0?.status === "number"
                ? r0.status
                : typeof checkRes?.status === "number"
                  ? checkRes.status
                  : null;
            checkLiveId =
              typeof r0?.live_id === "number"
                ? r0.live_id
                : typeof r0?.liveId === "number"
                  ? r0.liveId
                  : typeof r0?.live?.id === "number"
                    ? r0.live.id
                    : null;

            (detectLoop as any)._lastLiveCheckStatus = checkStatus;
            (detectLoop as any)._lastLiveCheckLiveId = checkLiveId;
            (detectLoop as any)._lastLiveCheckResultType = checkResultType;
            (detectLoop as any)._lastLiveCheckStatusCode = checkStatusCode;

            // liveIdが取れるならDJ自己検知の根拠にできる
            if (liveId <= 0 && typeof checkLiveId === "number" && checkLiveId > 0) {
              liveId = Number(checkLiveId);
            }
          } catch (e: any) {
            checkResultType = "error";
            checkStatusCode =
              typeof e?.status_code === "number"
                ? e.status_code
                : typeof e?.error?.status_code === "number"
                  ? e.error.status_code
                  : null;
            (detectLoop as any)._lastLiveCheckResultType = checkResultType;
            (detectLoop as any)._lastLiveCheckStatusCode = checkStatusCode;
          }
        }
      }

      // 診断ログ（値変化 or 30秒に1回）
      if (CONFIG.DIAG_DETECT) {
        (detectLoop as any)._lastDiagAt ??= 0;
        (detectLoop as any)._lastDiagKey ??= "";
        const lastDiagAt = Number((detectLoop as any)._lastDiagAt);
        const keyBase = `dj:is_live=${currentLiveIsLive};dj:current_live_id=${currentLiveId};dj:userInfoLiveId=${userInfoLiveId};check:rtype=${checkResultType};check:code=${checkStatusCode};check:status=${checkStatus};check:liveId=${checkLiveId}`;
        const keyCompare = CONFIG.DIAG_COMPARE_CLIENTS
          ? `;mon:is_live=${monitorCurrentLiveIsLive};mon:current_live_id=${monitorCurrentLiveId};mon:userInfoLiveId=${monitorUserInfoLiveId}`
          : "";
        const key = `${keyBase}${keyCompare}`;
        if (key !== (detectLoop as any)._lastDiagKey || now - lastDiagAt >= 30000) {
          (detectLoop as any)._lastDiagAt = now;
          (detectLoop as any)._lastDiagKey = key;
          console.log(`🔎 DJ detect: ${key}`);
        }
      }

      if (liveId > 0) {
        if (title === "(untitled)") {
          try {
            const info: any = await djClient.api.live.getInfo(liveId);
            title = info?.title || title;
          } catch {}
        }

        console.log(`🎬 live detected by DJ(self): ${liveId} (${title})`);
        await startSession(liveId, title);
        return;
      }

      // フォールバック（任意）: MONITOR購読から拾う
      if (CONFIG.DJ_DETECT_FALLBACK_MONITOR) {
        try {
          const data = await monitorClient.api.live.getSubscribed({ page_size: 50, page: 1 });
          const liveList = data.results || [];
          const myLive = liveList.find((l: any) => l.author.id.toString() === CONFIG.DJ_ID);
          if (myLive) {
            console.log(`🎬 live detected by DJ(fallback:MONITOR): ${myLive.id} (${myLive.title})`);
            await startSession(Number(myLive.id), myLive.title);
          }
        } catch {}
      }
    } catch (e: any) {
      // トークン失効などのときは refresh を試みる
      const status = e?.status_code || e?.error?.status_code;
      const message = String(e?.message || "");

      if (status === 460) {
        // @sopia-bot/core 側で 460 のとき自動的に token refresh を試みます。
        // ここでさらに tokenRefresh() を呼ぶと失敗ログが増幅するため、通知とバックオフだけ行います。
        tokenRefreshBackoffUntil = Date.now() + TOKEN_REFRESH_BACKOFF_MS;

        const now = Date.now();
        if (now - lastTokenExpiredLogAt >= TOKEN_EXPIRED_LOG_THROTTLE_MS) {
          lastTokenExpiredLogAt = now;
          console.log(
            `🔄 ${CONFIG.DETECT_ACCOUNT}トークン失効(460)。手動ログインが必要です。${Math.floor(
              TOKEN_REFRESH_BACKOFF_MS / 1000
            )}秒バックオフします。`
          );
        }

        await sendBotMessageThrottled(
          `token-refresh-failed:${CONFIG.DETECT_ACCOUNT}`,
          `🚨 **${CONFIG.DETECT_ACCOUNT}アカウントの復旧に失敗しました**\n手動ログインが必要です。\n次の再試行まで: ${Math.floor(
            TOKEN_REFRESH_BACKOFF_MS / 1000
          )}秒\n(このアラートはスパム防止のため間引き送信されます)`
        );
        return;
      }

      // 「通常の失敗ではない」系: JSONではなくHTMLが返る / refresh応答にJWTがない
      // Cloudflare/メンテ/リダイレクト等でHTMLが返ると JSON.parse で落ちます。
      const looksLikeHtmlJsonParse =
        message.includes("Unexpected token '<'") ||
        message.includes("is not valid JSON") ||
        message.toLowerCase().includes("<html");
      const looksLikeNoJwt = message.includes("No JWT in response");

      if (looksLikeHtmlJsonParse || looksLikeNoJwt) {
        tokenRefreshBackoffUntil = Date.now() + SPOON_HTTP_ANOMALY_BACKOFF_MS;

        const now = Date.now();
        if (now - lastHttpAnomalyLogAt >= HTTP_ANOMALY_LOG_THROTTLE_MS) {
          lastHttpAnomalyLogAt = now;
          console.log(
            `⚠️ Spoon API異常応答の可能性。${Math.floor(SPOON_HTTP_ANOMALY_BACKOFF_MS / 1000)}秒バックオフします。 msg=${message.slice(0, 200)}`
          );
        }

        await sendBotMessageThrottled(
          `spoon-http-anomaly:${CONFIG.DETECT_ACCOUNT}`,
          `🚨 **Spoon APIの応答が想定外です**\n${CONFIG.DETECT_ACCOUNT}でAPI呼び出しに失敗しました。\n\n症状: ${looksLikeNoJwt ? "Token refresh応答にJWTがありません" : "JSONではなくHTMLが返っている可能性"}\n次の再試行まで: ${Math.floor(
            SPOON_HTTP_ANOMALY_BACKOFF_MS / 1000
          )}秒\nエラー: ${message.slice(0, 180)}\n(このアラートはスパム防止のため間引き送信されます)`
        );
        return;
      }

      console.warn("⚠️ detectLoop error:", e?.message || e);
    }
  };

  setInterval(detectLoop, CONFIG.CHECK_INTERVAL_MS);
  await detectLoop();

  const shutdown = async (signal: string) => {
    console.log(`\n🛑 ${signal} received. shutting down...`);
    try {
      await finishSession();
    } finally {
      try {
        await db.end();
      } catch {}
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});
