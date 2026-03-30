import * as fs from "fs";
import type { ILogger } from "./logger.interface";
import { LogLevel } from "./logger.interface";

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

function formatTimestamp(date: Date = new Date()): string {
  const localTs = TIMESTAMP_FORMATTER.format(date).replace(" ", "T");
  return `${localTs} ${LOG_TIME_ZONE}`;
}

/**
 * WebSocket 파일 로거 인터페이스
 */
export interface IWebSocketFileLogger extends ILogger {
  enable(): void;
  disable(): void;
  getFilePath(): string | null;
  readonly enabled: boolean;
  logSend(command: string, payload: unknown): void;
  logReceive(command: string, payload: unknown, raw?: string): void;
}

/**
 * WebSocket 전용 파일 로거
 *
 * WebSocket의 모든 send/receive 데이터를 파일로 저장합니다.
 * 디버깅 목적으로 사용됩니다.
 */
export class WebSocketFileLogger implements IWebSocketFileLogger {
  private writeStream: fs.WriteStream | null = null;
  private isEnabled: boolean = false;

  constructor(
    private filePath: string,
    private minLevel: LogLevel = LogLevel.DEBUG,
    private prefix: string = "[WS]",
  ) {}

  /**
   * 파일 로깅 활성화
   */
  enable(): void {
    if (this.isEnabled) return;

    try {
      // 디렉토리가 없으면 생성
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/")) || this.filePath.substring(0, this.filePath.lastIndexOf("\\"));
      if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.writeStream = fs.createWriteStream(this.filePath, { flags: "a" });
      this.isEnabled = true;
      this.info("WebSocket file logging started", { filePath: this.filePath });
    } catch (error) {
      console.error("[WebSocketFileLogger] Failed to enable file logging:", error);
    }
  }

  /**
   * 파일 로깅 비활성화
   */
  disable(): void {
    if (!this.isEnabled) return;

    this.info("WebSocket file logging stopped");
    this.writeStream?.end();
    this.writeStream = null;
    this.isEnabled = false;
  }

  /**
   * 새 로그 파일로 교체
   * @param newFilePath 새 파일 경로
   */
  rotate(newFilePath: string): void {
    this.disable();
    this.filePath = newFilePath;
    this.enable();
  }

  /**
   * 현재 로그 파일 경로 반환
   */
  getFilePath(): string | null {
    return this.isEnabled ? this.filePath : null;
  }

  /**
   * 로깅 활성화 여부
   */
  get enabled(): boolean {
    return this.isEnabled;
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.minLevel;
  }

  private formatMessage(level: string, message: string, data?: unknown): string {
    const timestamp = formatTimestamp();
    const dataStr = data !== undefined ? `\n${JSON.stringify(data, null, 2)}` : "";
    return `${this.prefix} [${timestamp}] [${level}] ${message}${dataStr}\n`;
  }

  private writeToFile(formatted: string): void {
    if (this.isEnabled && this.writeStream) {
      this.writeStream.write(formatted);
    }
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      const formatted = this.formatMessage("DEBUG", message, args.length > 0 ? args : undefined);
      this.writeToFile(formatted);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.INFO)) {
      const formatted = this.formatMessage("INFO", message, args.length > 0 ? args : undefined);
      this.writeToFile(formatted);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.WARN)) {
      const formatted = this.formatMessage("WARN", message, args.length > 0 ? args : undefined);
      this.writeToFile(formatted);
    }
  }

  error(message: string, error?: Error | unknown, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      const errorData = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error;
      const formatted = this.formatMessage("ERROR", message, { error: errorData, args });
      this.writeToFile(formatted);
    }
  }

  /**
   * WebSocket 송신 로깅
   */
  logSend(command: string, payload: unknown): void {
    const timestamp = formatTimestamp();
    const logEntry = {
      direction: "SEND",
      timestamp,
      command,
      payload,
    };
    const formatted = `${this.prefix} [${timestamp}] [SEND] ${command}\n${JSON.stringify(logEntry, null, 2)}\n${"=".repeat(80)}\n`;
    this.writeToFile(formatted);
  }

  /**
   * WebSocket 수신 로깅
   */
  logReceive(command: string, payload: unknown, raw?: string): void {
    const timestamp = formatTimestamp();
    const logEntry = {
      direction: "RECEIVE",
      timestamp,
      command,
      payload,
      raw: raw?.length && raw.length > 1000 ? `${raw.substring(0, 1000)}... (truncated)` : raw,
    };
    const formatted = `${this.prefix} [${timestamp}] [RECEIVE] ${command}\n${JSON.stringify(logEntry, null, 2)}\n${"=".repeat(80)}\n`;
    this.writeToFile(formatted);
  }
}
