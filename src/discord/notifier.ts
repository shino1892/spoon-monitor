import "dotenv/config";

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
  const mode = (getEnv("DISCORD_NOTIFY_MODE") || "channel").toLowerCase();
  return mode === "dm" ? "dm" : "channel";
}

async function discordApi<T>(path: string, init: RequestInit): Promise<T> {
  const token = getBotToken();
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API error ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

async function resolveTargetChannelId(): Promise<string> {
  const mode = getNotifyMode();
  if (mode === "channel") {
    const channelId = getEnv("DISCORD_CHANNEL_ID");
    if (!channelId) throw new Error("DISCORD_CHANNEL_ID is missing");
    return channelId;
  }

  const adminId = getEnv("DISCORD_ADMIN_ID") || getEnv("ADMIN_ID");
  if (!adminId) throw new Error("DISCORD_ADMIN_ID or ADMIN_ID is missing (dm mode)");

  // Create (or fetch) DM channel with admin
  const dm = await discordApi<{ id: string }>("/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: adminId }),
  });
  return dm.id;
}

export async function sendDiscordMessage(content: string) {
  const channelId = await resolveTargetChannelId();
  await discordApi(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}
