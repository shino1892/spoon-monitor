import "dotenv/config";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import fs from "fs";
import path from "path";
import { initSpoon } from "../app";
import { createLogger, errorToMessage } from "../shared/logger";

const log = createLogger("discord-bot");
log.info("Starting Discord bot...");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const ADMIN_ID = process.env.ADMIN_ID;

const CHECK_WINDOW_MS = 30_000;
const CHECK_INTERVAL_MS = 2_000;
let isChecking = false;
let djClient: Awaited<ReturnType<typeof initSpoon>> | null = null;
let monitorClient: Awaited<ReturnType<typeof initSpoon>> | null = null;
let collectorProc: ChildProcessWithoutNullStreams | null = null;
let collectorLiveId: number | null = null;

function isAdmin(userId: string | null | undefined) {
  return !!ADMIN_ID && !!userId && userId === ADMIN_ID;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHttpStatus(err: any): number | undefined {
  const direct = err?.status;
  if (typeof direct === "number") return direct;
  const responseStatus = err?.response?.status;
  if (typeof responseStatus === "number") return responseStatus;
  const nestedStatus = err?.response?.data?.status;
  if (typeof nestedStatus === "number") return nestedStatus;
  return undefined;
}

function isAuthLikeStatus(status: number | undefined) {
  return status === 406 || status === 401 || status === 403;
}

async function resetMonitorClient() {
  if (!monitorClient) return;
  try {
    // sopia-core 側が提供していればWSを明示切断（無ければ無視）。
    (monitorClient as any)?.disconnectWebSocket?.();
  } catch {
    // ignore
  }
  monitorClient = null;
}

async function getDjClient() {
  if (!djClient) {
    djClient = await initSpoon("DJ");
  }
  return djClient;
}

async function getMonitorClient() {
  if (!monitorClient) {
    monitorClient = await initSpoon("MONITOR");
  }
  return monitorClient;
}

function createJoinButtonRow(liveId: string | number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`join_live_${liveId}`).setLabel("配信に参加").setStyle(ButtonStyle.Primary));
}

function createLeaveButtonRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("leave_live_btn").setLabel("配信から退室").setStyle(ButtonStyle.Danger));
}

function sanitizeFolderPart(input: string) {
  return input
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 40);
}

function createFolderName(liveId: number, title: string) {
  const d = new Date();
  const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
  const titlePart = sanitizeFolderPart(title || "live");
  return `${ts}_${titlePart}_${liveId}`;
}

function startCollectorProcess(liveId: number, liveTitle: string) {
  if (collectorProc && !collectorProc.killed) {
    if (collectorLiveId === liveId) {
      log.info(`collector はすでに liveId=${liveId} で起動中です。`);
      return;
    }
    // 別ライブ収集中なら明示終了を送ってから切り替える。
    log.warn(`既存 collector(liveId=${collectorLiveId}) を停止して切り替えます。`);
    collectorProc.stdin.write("exit\n");
  }

  const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const startIso = new Date().toISOString();
  const folderName = createFolderName(liveId, liveTitle);
  const args = ["tsx", "src/spoon/collector.ts", String(liveId), startIso, liveTitle || "(no-title)", folderName];

  const child = spawn(pnpmCmd, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  collectorProc = child;
  collectorLiveId = liveId;
  log.info(`collector を起動しました (liveId=${liveId}, folder=${folderName})`);

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[collector:${liveId}] ${chunk.toString()}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[collector:${liveId}:err] ${chunk.toString()}`);
  });
  child.on("close", (code, signal) => {
    log.info(`collector 終了 (liveId=${liveId}, code=${code ?? "null"}, signal=${signal ?? "null"})`);
    if (collectorProc === child) {
      collectorProc = null;
      collectorLiveId = null;
    }
  });
}

async function stopCollectorProcess() {
  if (!collectorProc || collectorProc.killed) return;

  const proc = collectorProc;
  const liveId = collectorLiveId;
  log.info(`collector 停止要求 (liveId=${liveId ?? "unknown"})`);

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    const timer = setTimeout(() => {
      // 通常終了が間に合わない場合はシグナルで強制停止する。
      if (!proc.killed) {
        proc.kill("SIGTERM");
      }
      finish();
    }, 10_000);

    proc.once("close", () => {
      clearTimeout(timer);
      finish();
    });

    proc.stdin.write("exit\n");
  });
}

async function burstCheckLiveOnceForWindow(djId: string) {
  let mc = await getMonitorClient();
  const deadline = Date.now() + CHECK_WINDOW_MS;
  while (Date.now() < deadline) {
    // 短い間隔で購読一覧を再取得し、配信開始直後も拾えるようにする。
    let data: any;
    try {
      data = await mc.api.live.getSubscribed({ page_size: 50, page: 1 });
    } catch (e: any) {
      const status = getHttpStatus(e);
      if (isAuthLikeStatus(status)) {
        // トークン失効の可能性が高いので、拡張機能から更新されるのを待って再初期化して続行。
        log.warn(`monitor token may be expired (status=${status}). Re-initializing monitor client...`);
        await resetMonitorClient();
        await sleep(1500);
        mc = await getMonitorClient();
        continue;
      }
      throw e;
    }
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

  const appId = process.env.DISCORD_APP_ID || client.application?.id || client.user?.id;
  if (!appId) throw new Error("DISCORD_APP_ID is required (or wait until client.application.id is available)");

  const guildId = process.env.DISCORD_GUILD_ID;

  const commands = [new SlashCommandBuilder().setName("lastsummary").setDescription("最新の summary.json の概要を表示"), new SlashCommandBuilder().setName("check").setDescription("配信状況を最大30秒だけチェック（2秒間隔）"), new SlashCommandBuilder().setName("join").setDescription("検知中のライブに参加"), new SlashCommandBuilder().setName("leave").setDescription("配信から退室")].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
    log.info(`Slash commands registered (guild): ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    log.info("Slash commands registered (global)");
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
    // タイムアウト付き検知はレスポンスが遅くなるため defer しておく。
    await interaction.deferReply({ ephemeral: true });
    try {
      const live = await burstCheckLiveOnceForWindow(djId);
      if (live) {
        const title = live?.title || "(タイトル不明)";
        const liveId = live?.id?.toString?.() || "(id不明)";
        const hasNumericLiveId = /^\d+$/.test(liveId);
        if (hasNumericLiveId) {
          await interaction.editReply({
            content: `✅ 配信を検知しました: "${title}" (liveId=${liveId})`,
            components: [createJoinButtonRow(liveId)],
          });
        } else {
          await interaction.editReply(`✅ 配信を検知しました: "${title}" (liveId=${liveId})`);
        }
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

  if (name === "join") {
    if (isChecking) {
      await interaction.reply({ content: "⏳ すでに配信チェック中です。少し待ってから再実行してください。", ephemeral: true });
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
      if (!live) {
        await interaction.editReply("❌ 30秒間チェックしましたが、配信は見つかりませんでした。");
        return;
      }

      const liveIdRaw = live?.id?.toString?.() || "";
      const liveId = Number(liveIdRaw);
      if (!Number.isFinite(liveId)) {
        // 取得値が壊れている場合は join せずエラー扱いにする。
        await interaction.editReply("❌ liveId の取得に失敗しました。");
        return;
      }

      const client = await getDjClient();
      await client.live.join(liveId);
      startCollectorProcess(liveId, live?.title || "");
      await interaction.editReply({
        content: `✅ LiveID: ${liveId} に参加しました。`,
        components: [createLeaveButtonRow()],
      });
    } catch (e: any) {
      await interaction.editReply(`❌ 参加失敗: ${e?.message || e}`);
    } finally {
      isChecking = false;
    }
    return;
  }

  if (name === "leave") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const client = await getDjClient();
      await client.live.close();
      await stopCollectorProcess();
      await interaction.editReply({ content: "👋 退室しました。", components: [] });
    } catch (e: any) {
      await interaction.editReply(`❌ 退室失敗: ${e?.message || e}`);
    }
    return;
  }

  await interaction.reply({ content: "⚠️ 未対応のコマンドです。", ephemeral: true });
}

client.on("interactionCreate", async (interaction) => {
  if (!isAdmin(interaction.user?.id)) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: "⛔ 権限がありません。", ephemeral: true });
    }
    return;
  }

  if (interaction.isChatInputCommand()) {
    await handleInteraction(interaction);
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("join_live_")) {
      // check 結果の参加ボタンから直接 join する経路。
      const raw = interaction.customId.replace("join_live_", "");
      const liveId = Number(raw);
      if (!Number.isFinite(liveId)) {
        await interaction.reply({ content: "❌ 不正な liveId です。", ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      try {
        const client = await getDjClient();
        await client.live.join(liveId);
        const info = await client.api.live.getInfo(liveId);
        startCollectorProcess(liveId, info?.title || "");
        await interaction.editReply({
          content: `✅ LiveID: ${liveId} に参加しました。`,
          components: [createLeaveButtonRow()],
        });
      } catch (e: any) {
        await interaction.editReply(`❌ 参加失敗: ${e?.message || e}`);
      }
      return;
    }

    if (interaction.customId === "leave_live_btn") {
      await interaction.deferReply({ ephemeral: true });
      try {
        const client = await getDjClient();
        await client.live.close();
        await stopCollectorProcess();
        await interaction.editReply({ content: "👋 退室しました。", components: [] });
      } catch (e: any) {
        await interaction.editReply(`❌ 退室失敗: ${e?.message || e}`);
      }
    }
  }
});

client.once("clientReady", async () => {
  log.info(`Ready as ${client.user?.tag ?? "(unknown)"}`);
  try {
    await registerCommands();
  } catch (e: any) {
    log.error("Slash command registration failed", errorToMessage(e));
  }
});

client
  .login(process.env.DISCORD_BOT_TOKEN)
  .then(() => log.info("login() resolved"))
  .catch((e) => log.error("login() failed", errorToMessage(e)));

process.on("SIGINT", () => {
  void stopCollectorProcess().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void stopCollectorProcess().finally(() => process.exit(0));
});
