type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLogLevel(raw: string | undefined): LogLevel {
  const normalized = (raw || "info").toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  // 想定外の値は info に丸めてログ欠落を防ぐ。
  return "info";
}

const ACTIVE_LEVEL = resolveLogLevel(process.env.LOG_LEVEL);
const LOG_TIME_ZONE = process.env.LOG_TIME_ZONE || "Asia/Tokyo";
const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("sv-SE", {
  timeZone: LOG_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});

function shouldLog(level: LogLevel) {
  // しきい値以上のレベルのみ出力する。
  return LEVEL_ORDER[level] >= LEVEL_ORDER[ACTIVE_LEVEL];
}

function formatTimestamp(date: Date = new Date()) {
  const localTs = TIMESTAMP_FORMATTER.format(date).replace(" ", "T");
  return `${localTs} ${LOG_TIME_ZONE}`;
}

function formatMeta(meta: unknown) {
  if (meta === undefined || meta === null) return "";
  if (meta instanceof Error) {
    return ` | ${meta.name}: ${meta.message}`;
  }
  if (typeof meta === "string") return ` | ${meta}`;
  try {
    // 任意オブジェクトは JSON 化して 1 行に収める。
    return ` | ${JSON.stringify(meta)}`;
  } catch {
    return " | [unserializable-meta]";
  }
}

function formatLine(level: LogLevel, scope: string, message: string, meta?: unknown) {
  const ts = formatTimestamp();
  const upper = level.toUpperCase();
  return `[${ts}] [${upper}] [${scope}] ${message}${formatMeta(meta)}`;
}

export function createLogger(scope: string) {
  return {
    debug(message: string, meta?: unknown) {
      if (!shouldLog("debug")) return;
      console.debug(formatLine("debug", scope, message, meta));
    },
    info(message: string, meta?: unknown) {
      if (!shouldLog("info")) return;
      console.log(formatLine("info", scope, message, meta));
    },
    warn(message: string, meta?: unknown) {
      if (!shouldLog("warn")) return;
      console.warn(formatLine("warn", scope, message, meta));
    },
    error(message: string, meta?: unknown) {
      if (!shouldLog("error")) return;
      console.error(formatLine("error", scope, message, meta));
    },
  };
}

export function errorToMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
