import "dotenv/config";
import { Client } from "pg";
import { createLogger, errorToMessage } from "../shared/logger";

const log = createLogger("refresh-listener-temperatures");

function toPort(value: string | undefined, fallback = 5432) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function getDbConfig(env: NodeJS.ProcessEnv) {
  const host = env.DB_HOST;
  const user = env.DB_USER;
  const password = env.DB_PASSWORD;
  const database = env.DB_NAME;
  const port = toPort(env.DB_PORT);

  if (!host || !user || !password || !database) {
    return null;
  }

  return { host, user, password, database, port };
}

async function run() {
  const dbConfig = getDbConfig(process.env);
  if (!dbConfig) {
    log.error("DB接続情報が不足しているため実行できません。(DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)");
    process.exitCode = 1;
    return;
  }

  const client = new Client(dbConfig);

  try {
    await client.connect();
    log.info("refresh_all_listener_temperatures を実行します。");
    await client.query("SELECT refresh_all_listener_temperatures();");
    log.info("refresh_all_listener_temperatures の実行が完了しました。");
  } catch (error) {
    log.error("refresh_all_listener_temperatures の実行に失敗しました", errorToMessage(error));
    process.exitCode = 1;
  } finally {
    try {
      await client.end();
    } catch {
      // no-op
    }
  }
}

void run();
