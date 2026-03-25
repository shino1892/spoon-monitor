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
  return "info";
}

const ACTIVE_LEVEL = resolveLogLevel(process.env.LOG_LEVEL);

function shouldLog(level: LogLevel) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[ACTIVE_LEVEL];
}

function formatMeta(meta: unknown) {
  if (meta === undefined || meta === null) return "";
  if (meta instanceof Error) {
    return ` | ${meta.name}: ${meta.message}`;
  }
  if (typeof meta === "string") return ` | ${meta}`;
  try {
    return ` | ${JSON.stringify(meta)}`;
  } catch {
    return " | [unserializable-meta]";
  }
}

function formatLine(level: LogLevel, scope: string, message: string, meta?: unknown) {
  const ts = new Date().toISOString();
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
