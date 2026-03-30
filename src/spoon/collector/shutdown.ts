import { Client } from "pg";
import { CollectorState } from "./state";
import { StreamSummary, buildDbSavedMessage, closeDb, finishStream, saveSummaryJson, sendDiscordMessage } from "./infra";
import { createLogger, errorToMessage } from "../../shared/logger";

const log = createLogger("collector-shutdown");

interface CreateSaveAndExitHandlerParams {
  liveId: number;
  liveStartTime: string;
  liveTitle: string;
  folderName: string;
  state: CollectorState;
  db: Client | null;
  isDbConnected: () => boolean;
  clearPolling: () => void;
  discordBotToken?: string;
  discordChannelId?: string;
}

function buildFinalReport(liveId: number, liveTitle: string, liveStartTime: string, liveEndTime: string, durationSeconds: number, state: CollectorState) {
  return {
    live_info: {
      live_id: liveId,
      title: liveTitle,
      start_time: liveStartTime,
      end_time: liveEndTime,
      duration_seconds: durationSeconds,
    },
    users: Object.fromEntries(state.userStats),
  };
}

function buildSummaryForDb(liveId: number, liveTitle: string, durationMinutes: number, state: CollectorState): StreamSummary {
  return {
    id: liveId,
    title: liveTitle,
    djName: "shino",
    durationMinutes,
    likes: state.totalLikes,
    userStats: state.userStats,
  };
}

export function createSaveAndExitHandler(params: CreateSaveAndExitHandlerParams) {
  let isShuttingDown = false;
  let hasError = false;

  return async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    params.clearPolling();
    log.info("配信終了処理を開始します...");

    const liveEndTime = new Date().toISOString();
    const durationSeconds = Math.floor((Date.now() - new Date(params.liveStartTime).getTime()) / 1000);
    const durationMinutes = Math.floor(durationSeconds / 60);

    const finalReport = buildFinalReport(params.liveId, params.liveTitle, params.liveStartTime, liveEndTime, durationSeconds, params.state);
    const summaryForDb = buildSummaryForDb(params.liveId, params.liveTitle, durationMinutes, params.state);

    try {
      saveSummaryJson(params.folderName, finalReport);
      log.info(`JSON保存完了: ${params.folderName}/summary.json`);

      if (params.isDbConnected()) {
        const saved = await finishStream(params.db, summaryForDb);
        if (saved?.reportId) {
          const message = buildDbSavedMessage(summaryForDb, saved.reportId, saved.listenerCount);
          await sendDiscordMessage(params.discordBotToken, params.discordChannelId, message);
        }
      } else {
        log.warn("DB未接続のため、DB保存をスキップします。");
      }
    } catch (e: any) {
      hasError = true;
      const message = `❌ 終了保存エラー: ${e?.message || e}`;
      log.error("終了保存エラー", errorToMessage(e));
      await sendDiscordMessage(params.discordBotToken, params.discordChannelId, message);
    } finally {
      await closeDb(params.db);
      process.exit(hasError ? 1 : 0);
    }
  };
}
