import "dotenv/config";
import { createDmChannel, postChannelMessage } from "./api";

type NotifyMode = "channel" | "dm";

function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v : undefined;
}

function getBotToken() {
  const token = getEnv("DISCORD_BOT_TOKEN");
  if (!token) throw new Error("DISCORD_BOT_TOKEN is missing");
  return token;
}

function getNotifyMode(): NotifyMode {
  // 想定外の値が来た場合も channel 扱いにして通知不能を避ける。
  const mode = (getEnv("DISCORD_NOTIFY_MODE") || "channel").toLowerCase();
  return mode === "dm" ? "dm" : "channel";
}

async function resolveTargetChannelId(): Promise<string> {
  const token = getBotToken();
  const mode = getNotifyMode();
  if (mode === "channel") {
    // 通常運用はチャンネル送信を優先する。
    const channelId = getEnv("DISCORD_CHANNEL_ID");
    if (!channelId) throw new Error("DISCORD_CHANNEL_ID is missing");
    return channelId;
  }

  // DM モード時は管理者 ID から DM チャンネルを解決する。
  const adminId = getEnv("DISCORD_ADMIN_ID") || getEnv("ADMIN_ID");
  if (!adminId) throw new Error("DISCORD_ADMIN_ID or ADMIN_ID is missing (dm mode)");

  // Create (or fetch) DM channel with admin
  return createDmChannel(token, adminId);
}

export async function sendDiscordMessage(content: string) {
  const token = getBotToken();
  const channelId = await resolveTargetChannelId();
  await postChannelMessage(token, channelId, content);
}
