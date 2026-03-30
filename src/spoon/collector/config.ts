export interface DbConfig {
  host: string;
  user: string;
  password: string;
  database: string;
  port: number;
}

export interface CollectorConfig {
  liveId: number;
  liveStartTime: string;
  liveTitle: string;
  folderName: string;
  pollIntervalMs: number;
  debugSpoonEvents: boolean;
  debugSpoonPayload: boolean;
  debugSpoonUnknownEvents: boolean;
  debugSpoonMaxChars: number;
  debugLiveMethods: boolean;
  djId?: string;
  discordBotToken?: string;
  discordChannelId?: string;
  db: DbConfig | null;
}

function toPositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
}

function toBool(value: string | undefined, fallback = false) {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  return fallback;
}

export function loadCollectorConfig(argv: string[], env: NodeJS.ProcessEnv): CollectorConfig {
  const [, , liveIdRaw, liveStartTime = "", liveTitle = "", folderName = ""] = argv;
  if (!liveIdRaw) process.exit(1);

  const liveId = Number(liveIdRaw);
  if (!Number.isFinite(liveId)) process.exit(1);

  const dbHost = env.DB_HOST;
  const dbUser = env.DB_USER;
  const dbPassword = env.DB_PASSWORD;
  const dbName = env.DB_NAME;
  const dbPort = toPositiveInt(env.DB_PORT, 5432);

  const db =
    dbHost && dbUser && dbPassword && dbName
      ? {
          host: dbHost,
          user: dbUser,
          password: dbPassword,
          database: dbName,
          port: dbPort,
        }
      : null;

  return {
    liveId,
    liveStartTime,
    liveTitle,
    folderName,
    pollIntervalMs: toPositiveInt(env.LISTENER_POLL_INTERVAL, 10_000),
    debugSpoonEvents: toBool(env.SPOON_DEBUG_EVENTS),
    debugSpoonPayload: toBool(env.SPOON_DEBUG_PAYLOAD),
    debugSpoonUnknownEvents: toBool(env.SPOON_DEBUG_UNKNOWN_EVENTS),
    debugSpoonMaxChars: toPositiveInt(env.SPOON_DEBUG_MAX_CHARS, 12_000),
    debugLiveMethods: toBool(env.DEBUG_LIVE_METHODS),
    djId: env.DJ_ID,
    discordBotToken: env.DISCORD_BOT_TOKEN,
    discordChannelId: env.DISCORD_CHANNEL_ID,
    db,
  };
}
