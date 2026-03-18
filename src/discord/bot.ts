import "dotenv/config";
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { initSpoon } from "../app";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const ADMIN_ID = process.env.ADMIN_ID;

const CHECK_WINDOW_MS = 30_000;
const CHECK_INTERVAL_MS = 2_000;
let isChecking = false;

function isAdmin(userId: string | null | undefined) {
  return !!ADMIN_ID && !!userId && userId === ADMIN_ID;
}

function envPath() {
  return path.join(process.cwd(), ".env");
}

function execAsync(command: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolve({ stdout, stderr });
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function burstCheckLiveOnceForWindow(djId: string) {
  const monitorClient = await initSpoon("MONITOR");
  const deadline = Date.now() + CHECK_WINDOW_MS;
  while (Date.now() < deadline) {
    const data = await monitorClient.api.live.getSubscribed({ page_size: 50, page: 1 });
    const liveList = data.results || [];
    const myLive = liveList.find((l: any) => l?.author?.id?.toString?.() === djId);
    if (myLive) return myLive;
    await sleep(CHECK_INTERVAL_MS);
  }
  return null;
}

async function getLatestSummary(): Promise<{
  folderName: string;
  title: string;
  liveId: number | string;
  start: string;
  end: string;
  durationSeconds: number;
  usersCount: number;
  topStay: Array<{ nickname: string; staySeconds: number; chat: number; heart: number; spoon: number }>;
} | null> {
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) return null;
  const folders = fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  if (folders.length === 0) return null;

  const withMtime = folders
    .map((name) => {
      const p = path.join(dataDir, name, "summary.json");
      if (!fs.existsSync(p)) return null;
      return { name, mtime: fs.statSync(p).mtimeMs, path: p };
    })
    .filter(Boolean) as Array<{ name: string; mtime: number; path: string }>;
  if (withMtime.length === 0) return null;

  withMtime.sort((a, b) => b.mtime - a.mtime);
  const latest = withMtime[0];
  const raw = fs.readFileSync(latest.path, "utf8");
  const json = JSON.parse(raw);

  const liveInfo = json.live_info || {};
  const users = json.users || {};
  const userList = Object.values(users) as any[];
  const topStay = userList
    .map((u) => ({
      nickname: u.nickname || "(unknown)",
      staySeconds: Number(u.staySeconds || 0),
      chat: Number(u.counts?.chat || 0),
      heart: Number(u.counts?.heart || 0),
      spoon: Number(u.counts?.spoon || 0),
    }))
    .sort((a, b) => b.staySeconds - a.staySeconds)
    .slice(0, 5);

  return {
    folderName: latest.name,
    title: String(liveInfo.title || ""),
    liveId: liveInfo.live_id ?? "?",
    start: String(liveInfo.start_time || ""),
    end: String(liveInfo.end_time || ""),
    durationSeconds: Number(liveInfo.duration_seconds || 0),
    usersCount: userList.length,
    topStay,
  };
}

async function registerCommands() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is required");

  const appId = process.env.DISCORD_APP_ID || client.application?.id;
  if (!appId) throw new Error("DISCORD_APP_ID is required (or wait until client.application.id is available)");

  const guildId = process.env.DISCORD_GUILD_ID;
  const commands = [
    new SlashCommandBuilder().setName("status").setDescription("監視プロセスの状態を表示"),
    new SlashCommandBuilder().setName("lastsummary").setDescription("最新の summary.json の概要を表示"),
    new SlashCommandBuilder().setName("check").setDescription("配信状況を最大30秒だけチェック（2秒間隔）"),
    new SlashCommandBuilder()
      .setName("restart")
      .setDescription("spoon-app を再起動")
      .addBooleanOption((o) => o.setName("confirm").setDescription("true で実行").setRequired(true)),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
    console.log(`✅ Slash commands registered (guild): ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log("✅ Slash commands registered (global)");
  }
}

async function handleInteraction(interaction: ChatInputCommandInteraction) {
  if (!isAdmin(interaction.user?.id)) {
    await interaction.reply({ content: "⛔ 権限がありません。", ephemeral: true });
    return;
  }

  const name = interaction.commandName;

  if (name === "check") {
    if (isChecking) {
      await interaction.reply({ content: "⏳ すでにチェック中です。少し待ってから再実行してください。", ephemeral: true });
      return;
    }

    const djId = process.env.DJ_ID;
    if (!djId) {
      await interaction.reply({ content: "⚠️ DJ_ID が未設定です。", ephemeral: true });
      return;
    }

    isChecking = true;
    await interaction.deferReply({ ephemeral: true });
    try {
      const live = await burstCheckLiveOnceForWindow(djId);
      if (live) {
        const title = live?.title || "(タイトル不明)";
        const liveId = live?.id?.toString?.() || "(id不明)";
        await interaction.editReply(`✅ 配信を検知しました: "${title}" (liveId=${liveId})`);
      } else {
        await interaction.editReply("❌ 30秒間チェックしましたが、配信は見つかりませんでした。");
      }
    } catch (e: any) {
      await interaction.editReply(`❌ チェック失敗: ${e?.message || e}`);
    } finally {
      isChecking = false;
    }
    return;
  }

  if (name === "status") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const { stdout } = await execAsync("pm2 jlist");
      const list = JSON.parse(stdout) as any[];
      const app = list.find((p) => p.name === "spoon-app");
      if (!app) {
        await interaction.editReply("⚠️ pm2 に spoon-app が見つかりませんでした。");
        return;
      }
      const st = app.pm2_env?.status || "unknown";
      const restarts = app.pm2_env?.restart_time ?? "?";
      const uptime = app.pm2_env?.pm_uptime ? Math.floor((Date.now() - app.pm2_env.pm_uptime) / 1000) : null;
      const mem = app.monit?.memory ? Math.round(app.monit.memory / 1024 / 1024) : null;
      await interaction.editReply(`🧩 spoon-app\n- status: ${st}\n- restarts: ${restarts}\n- uptime: ${uptime ?? "?"}s\n- mem: ${mem ?? "?"}MB`);
    } catch (e: any) {
      await interaction.editReply(`❌ status 取得失敗: ${e?.message || e}`);
    }
    return;
  }

  if (name === "lastsummary") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const s = await getLatestSummary();
      if (!s) {
        await interaction.editReply("⚠️ data/ 配下に summary.json が見つかりませんでした。");
        return;
      }
      const top = s.topStay.map((u, i) => `${i + 1}. ${u.nickname} (${Math.floor(u.staySeconds)}s chat:${u.chat} heart:${u.heart} spoon:${u.spoon})`).join("\n");
      await interaction.editReply(`📄 最新 summary\n- folder: ${s.folderName}\n- title: ${s.title}\n- liveId: ${s.liveId}\n- duration: ${s.durationSeconds}s\n- users: ${s.usersCount}\n\n🏆 top stay\n${top || "(no users)"}`);
    } catch (e: any) {
      await interaction.editReply(`❌ 読み込み失敗: ${e?.message || e}`);
    }
    return;
  }

  if (name === "restart") {
    const confirm = interaction.options.getBoolean("confirm", true);
    if (!confirm) {
      await interaction.reply({ content: "⚠️ confirm=true のときだけ実行します。", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      await execAsync("pm2 restart spoon-app");
      await interaction.editReply("🔄 spoon-app を再起動しました。");
    } catch (e: any) {
      await interaction.editReply(`❌ 再起動失敗: ${e?.message || e}`);
    }
    return;
  }

  await interaction.reply({ content: "⚠️ 未対応のコマンドです。", ephemeral: true });
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await handleInteraction(interaction);
});

client.once("ready", async () => {
  try {
    await registerCommands();
  } catch (e: any) {
    console.error("❌ Slash command registration failed:", e?.message || e);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
