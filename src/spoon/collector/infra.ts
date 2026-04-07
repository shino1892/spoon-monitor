import fs from "fs";
import path from "path";
import { Client } from "pg";
import { postChannelMessage } from "../../discord/api";
import { DbConfig } from "./config";
import { UserActivity } from "./state";
import { createLogger, errorToMessage } from "../../shared/logger";

const log = createLogger("collector-infra");

export interface StreamSummary {
  id: number;
  title: string;
  djName: string;
  durationMinutes: number;
  likes: number;
  userStats: Map<number, UserActivity>;
}

export interface KnownUserHistory {
  seenUserIds: Set<number>;
  lastVisitByUserId: Map<number, string>;
}

export function createDbClient(dbConfig: DbConfig | null) {
  if (!dbConfig) {
    log.warn("DB環境変数が不足しているため、DB保存を無効化します。(DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)");
    return null;
  }

  return new Client({
    host: dbConfig.host,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    port: dbConfig.port,
  });
}

export async function connectDb(db: Client | null) {
  if (!db) return false;
  try {
    await db.connect();
    return true;
  } catch (e: any) {
    log.warn("DB接続に失敗。DB保存なしで続行", errorToMessage(e));
    return false;
  }
}

export async function closeDb(db: Client | null) {
  if (!db) return;
  try {
    await db.end();
  } catch {}
}

export async function sendDiscordMessage(token: string | undefined, channelId: string | undefined, content: string) {
  if (!token || !channelId) {
    log.warn("Bot トークンまたはチャンネル ID が設定されていません。");
    return;
  }

  try {
    await postChannelMessage(token, channelId, content);
  } catch (error: any) {
    log.error("送信中にエラーが発生しました", errorToMessage(error));
  }
}

function toFiniteUserId(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function toIsoStringOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

function setLatestVisit(map: Map<number, string>, userId: number, candidateIso: string | null) {
  if (!candidateIso) return;
  const prevIso = map.get(userId);
  if (!prevIso || Date.parse(candidateIso) > Date.parse(prevIso)) {
    map.set(userId, candidateIso);
  }
}

export async function loadKnownUserHistoryFromDb(db: Client): Promise<KnownUserHistory> {
  const res = await db.query("SELECT user_id, MAX(last_seen) AS last_seen FROM listener_activities GROUP BY user_id");
  const ids = new Set<number>();
  const lastVisitByUserId = new Map<number, string>();
  for (const row of res.rows) {
    const id = toFiniteUserId(row.user_id);
    if (id === null) continue;
    ids.add(id);
    setLatestVisit(lastVisitByUserId, id, toIsoStringOrNull(row.last_seen));
  }
  return { seenUserIds: ids, lastVisitByUserId };
}

export function loadKnownUserHistoryFromSummaryJson(dataDir = path.join(process.cwd(), "data"), maxFolders = 30): KnownUserHistory {
  const ids = new Set<number>();
  const lastVisitByUserId = new Map<number, string>();
  if (!fs.existsSync(dataDir)) return { seenUserIds: ids, lastVisitByUserId };

  const folders = fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const latestFolders = folders
    .map((folder) => {
      const summaryPath = path.join(dataDir, folder, "summary.json");
      if (!fs.existsSync(summaryPath)) return null;
      const mtimeMs = fs.statSync(summaryPath).mtimeMs;
      return { folder, summaryPath, mtimeMs };
    })
    .filter((v): v is { folder: string; summaryPath: string; mtimeMs: number } => !!v)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, maxFolders));

  for (const item of latestFolders) {
    const p = item.summaryPath;

    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const users = raw?.users;
      if (!users || typeof users !== "object") continue;

      for (const [key, value] of Object.entries(users as Record<string, unknown>)) {
        const id = toFiniteUserId(key);
        if (id === null) continue;

        ids.add(id);
        const user = value as { lastSeen?: unknown };
        setLatestVisit(lastVisitByUserId, id, toIsoStringOrNull(user.lastSeen));
      }
    } catch (e: any) {
      log.warn(`summary.json 読み込み失敗: ${p} (${errorToMessage(e)})`);
    }
  }

  return { seenUserIds: ids, lastVisitByUserId };
}

function mergeKnownUserHistoryPreferPrimary(primary: KnownUserHistory, secondary: KnownUserHistory): KnownUserHistory {
  const seenUserIds = new Set<number>(primary.seenUserIds);
  for (const id of secondary.seenUserIds) {
    seenUserIds.add(id);
  }

  // primary(DB) を優先し、欠けている値のみ secondary(JSON) で補完する。
  const lastVisitByUserId = new Map<number, string>(primary.lastVisitByUserId);
  for (const [id, iso] of secondary.lastVisitByUserId) {
    if (!lastVisitByUserId.has(id)) {
      lastVisitByUserId.set(id, iso);
    }
  }

  return { seenUserIds, lastVisitByUserId };
}

export async function loadKnownUserHistory(db: Client | null, isDbConnected: boolean): Promise<KnownUserHistory> {
  if (!db || !isDbConnected) {
    // DB が使えないときは直近 summary.json 群から既知ユーザーを復元する。
    const history = loadKnownUserHistoryFromSummaryJson();
    log.info(`既知ユーザー読込: JSONフォールバック (${history.seenUserIds.size}件, latest ${30} folders)`);
    return history;
  }

  try {
    const dbHistory = await loadKnownUserHistoryFromDb(db);
    const jsonHistory = loadKnownUserHistoryFromSummaryJson();
    const history = mergeKnownUserHistoryPreferPrimary(dbHistory, jsonHistory);
    log.info(`既知ユーザー読込: DB優先 (db=${dbHistory.seenUserIds.size}件, json補完=${Math.max(0, history.seenUserIds.size - dbHistory.seenUserIds.size)}件, total=${history.seenUserIds.size}件)`);
    return history;
  } catch (e: any) {
    log.warn(`既知ユーザーのDB読込に失敗。JSONへフォールバック (${errorToMessage(e)})`);
    const history = loadKnownUserHistoryFromSummaryJson();
    log.info(`既知ユーザー読込: JSONフォールバック (${history.seenUserIds.size}件, latest ${30} folders)`);
    return history;
  }
}

export async function loadKnownUserIds(db: Client | null, isDbConnected: boolean): Promise<Set<number>> {
  const history = await loadKnownUserHistory(db, isDbConnected);
  return history.seenUserIds;
}

export function saveSummaryJson(folderName: string, finalReport: unknown) {
  const dataDir = path.join(process.cwd(), "data", folderName);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "summary.json"), JSON.stringify(finalReport, null, 2));
}

export async function finishStream(db: Client | null, summary: StreamSummary) {
  if (!db) {
    log.warn("DB未接続のため、DB保存をスキップします。");
    return null;
  }

  let reportId: number | null = null;
  try {
    log.info("データを PostgreSQL に保存中...");
    // レポート本体とリスナー明細を同一トランザクションで確定する。
    await db.query("BEGIN");

    const reportQuery = `
      INSERT INTO live_reports (live_id, title, dj_name, duration, likes, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id;
    `;
    const reportValues = [summary.id, summary.title, summary.djName, summary.durationMinutes, summary.likes];
    const reportRes = await db.query(reportQuery, reportValues);
    reportId = reportRes.rows[0].id;

    log.info(`リスナー ${summary.userStats.size} 名の活動記録を保存中...`);

    const listenerRows = Array.from(summary.userStats.entries());
    const batchSize = 200;
    // プレースホルダ上限とクエリサイズを避けるため分割 INSERT する。
    for (let offset = 0; offset < listenerRows.length; offset += batchSize) {
      const chunk = listenerRows.slice(offset, offset + batchSize);
      const values: Array<number | string> = [];
      const placeholders = chunk
        .map(([userId, stats], index) => {
          const base = index * 10;
          values.push(reportId as number, userId, stats.nickname, Math.floor(stats.staySeconds), stats.entryCount, stats.counts.chat, stats.counts.heart, stats.counts.spoon, stats.firstSeen, stats.lastSeen);
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
        })
        .join(",\n");

      const listenerQuery = `
        INSERT INTO listener_activities (
          report_id, user_id, nickname, stay_seconds, entry_count,
          chat_count, heart_count, spoon_count, first_seen, last_seen
        )
        VALUES ${placeholders};
      `;
      await db.query(listenerQuery, values);
    }

    await db.query("COMMIT");

    const verifyRes = await db.query("SELECT COUNT(*)::int AS count FROM listener_activities WHERE report_id = $1", [reportId]);
    const listenerCount = verifyRes.rows[0].count;
    log.info(`DB保存完了 report_id=${reportId} listener_count=${listenerCount}`);

    return { reportId, listenerCount };
  } catch (err: any) {
    try {
      // 部分保存を残さないため失敗時は必ずロールバックする。
      await db.query("ROLLBACK");
    } catch {}
    throw new Error(`終了処理エラー: ${err?.message || err}`);
  }
}

export function buildDbSavedMessage(summary: StreamSummary, reportId: number, listenerCount: number) {
  return `
📊 **配信終了レポート (管理番号: ${reportId})**
━━━━━━━━━━━━━━
🎤 **タイトル**: ${summary.title}
🕒 **配信時間**: ${summary.durationMinutes} 分
❤️ **合計いいね**: ${summary.likes}
👥 **総リスナー数**: ${summary.userStats.size} 名
━━━━━━━━━━━━━━
✅ 全リスナーの活動データも保存されました。(保存件数: ${listenerCount})
    `;
}
