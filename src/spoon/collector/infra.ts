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
    const listenerCount = verifyRes.rows[0].count;
    log.info(`DB保存完了 report_id=${reportId} listener_count=${listenerCount}`);

    return { reportId, listenerCount };
  } catch (err: any) {
    try {
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
