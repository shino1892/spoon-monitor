import "dotenv/config";
import { v2 } from "@sopia-bot/core";
import { initSpoon } from "../app";
import { loadCollectorConfig } from "./collector/config";
import { applyPollingSnapshot, createCollectorState } from "./collector/state";
import { applyEventToState, createLikeAutoReply, isLikeEvent, parseCollectorEvent, ROOM_CLOSE_EVENT_NAME } from "./collector/events";
import { connectDb, createDbClient, sendDiscordMessage } from "./collector/infra";
import { createSaveAndExitHandler } from "./collector/shutdown";
import { createLogger, errorToMessage } from "../shared/logger";

const { EventName } = v2;
const log = createLogger("collector");
const collectorConfig = loadCollectorConfig(process.argv, process.env);
const { liveId, liveStartTime, liveTitle, folderName, pollIntervalMs: POLL_INTERVAL_MS, debugSpoonEvents: DEBUG_SPOON_EVENTS, debugSpoonPayload: DEBUG_SPOON_PAYLOAD, debugSpoonUnknownEvents: DEBUG_SPOON_UNKNOWN_EVENTS, debugSpoonMaxChars: DEBUG_SPOON_MAX_CHARS, debugLiveMethods: DEBUG_LIVE_METHODS, djId: DJ_ID, discordBotToken: DISCORD_BOT_TOKEN, discordChannelId: DISCORD_CHANNEL_ID, db: DB_CONFIG } = collectorConfig;

const db = createDbClient(DB_CONFIG);
let isDbConnected = false;

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
  log.debug(`${label}:\n${truncateForLog(json, DEBUG_SPOON_MAX_CHARS)}`);
}

function toPositiveInt(value: unknown, fallback = 1) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
}

async function setupClients() {
  const djClient = await initSpoon("DJ");
  isDbConnected = await connectDb(db);

  return djClient;
}

async function startCollector() {
  const startupLog = `collector 起動 (liveId: ${liveId})`;
  log.info(startupLog);
  await sendDiscordMessage(DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, startupLog);

  const client = await setupClients();

  const live = client.live;
  const state = createCollectorState();
  let pollInterval: NodeJS.Timeout | undefined;

  const pollListeners = async () => {
    try {
      const data = await client.api.live.getListeners(liveId);
      const latestListeners = data.results || [];
      const nowISO = new Date().toISOString();

      const pollMessages = applyPollingSnapshot(state, latestListeners, nowISO, POLL_INTERVAL_MS);
      pollMessages.forEach((message) => {
        log.info(message);
        void sendDiscordMessage(DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, message);
      });
    } catch (e: any) {
      log.error("Polling Error", errorToMessage(e));
    }
  };

  const saveAndExit = createSaveAndExitHandler({
    liveId,
    liveStartTime,
    liveTitle,
    folderName,
    state,
    db,
    isDbConnected: () => isDbConnected,
    clearPolling: () => {
      if (pollInterval) clearInterval(pollInterval);
    },
    discordBotToken: DISCORD_BOT_TOKEN,
    discordChannelId: DISCORD_CHANNEL_ID,
  });

  pollInterval = setInterval(pollListeners, POLL_INTERVAL_MS);

  pollListeners();

  // 終了判定は RoomClose イベントのみで行う。

  const knownEventNames = new Set<string>([...Object.values(EventName), ROOM_CLOSE_EVENT_NAME]);
  const unknownEventNames = new Set<string>();

  live.on("event:all", (eventName: any, payload: any, raw: any) => {
    const nowISO = new Date().toISOString();
    const event = parseCollectorEvent(eventName, payload, raw, DJ_ID);

    if (DEBUG_SPOON_EVENTS) {
      log.debug(`[event] ${event.eName} userId=${event.userId ?? "(none)"} nick=${event.nickname} self=${event.isSelf}`);
    }
    if (DEBUG_SPOON_PAYLOAD) {
      dumpJson(`[payload] ${event.eName}`, event.payload);
      dumpJson(`[raw] ${event.eName}`, event.raw);
    }

    if (DEBUG_SPOON_UNKNOWN_EVENTS && !knownEventNames.has(event.eName) && !unknownEventNames.has(event.eName)) {
      unknownEventNames.add(event.eName);
      log.warn(`未対応イベント検知: ${event.eName}`);
      if (DEBUG_SPOON_PAYLOAD) {
        dumpJson(`[unknown payload] ${event.eName}`, event.payload);
        dumpJson(`[unknown raw] ${event.eName}`, event.raw);
      }
    }

    // 💡 自分自身（DJ/ボット）由来のユーザーイベントは無視
    if (event.isSelf) return;

    const result = applyEventToState(state, event, nowISO, toPositiveInt);

    result.entryMessages.forEach((message) => {
      log.info(message);
      void sendDiscordMessage(DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, message);
    });

    if (event.userId !== undefined) {
      log.info(`${event.nickname}さんから、${event.eName}を検知しました。`);
    } else {
      log.info(`${event.eName} を検知しました。`);
    }

    if (result.metricLogMessage) {
      log.info(result.metricLogMessage);
    }

    // --- 3. 自動ハーコメ機能 ---
    // 自分自身のいいねを除外（上で isSelf return 済み）
    if (result.stats && result.likeCount !== undefined && isLikeEvent(event.eName)) {
      const replyMessage = createLikeAutoReply(event.nickname, result.likeCount);

      if (DEBUG_SPOON_EVENTS) {
        log.debug(`[auto-message] try send: event=${event.eName} count=${result.likeCount} userId=${event.userId}`);
      }

      live.message(replyMessage).catch((err) => log.error("ハートお礼送信失敗", errorToMessage(err)));
    }

    // 💡 配信終了検知
    if (event.eName === ROOM_CLOSE_EVENT_NAME) {
      // RoomClose(reason: EXPLICIT 等) は終了確定シグナルとして扱う
      void saveAndExit();
      return;
    }
  });

  try {
    await live.join(liveId);
    const collectStartLog = `📡 収集開始 (Title: ${liveTitle})`;
    log.info(collectStartLog);
    await sendDiscordMessage(DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, collectStartLog);
    if (DEBUG_LIVE_METHODS) {
      log.debug(
        "🛠️ Liveオブジェクトのプロパティ一覧:",
        Object.getOwnPropertyNames(Object.getPrototypeOf(live)).filter((p) => typeof (live as any)[p] === "function"),
      );
    }
  } catch (err) {
    log.error("入室失敗", errorToMessage(err));
    process.exit(1);
  }
}

startCollector();
