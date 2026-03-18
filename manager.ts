import "dotenv/config";
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import fs from "fs";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const ADMIN_ID = process.env.ADMIN_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

const CHECK_WINDOW_MS = 30_000;
const CHECK_INTERVAL_MS = 2_000;

let isChecking = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function upsertEnvFileKey(envContent: string, key: string, value: string) {
  const line = `${key}="${value}"`;
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(envContent)) {
    return envContent.replace(regex, line);
  }
  const suffix = envContent.endsWith("\n") || envContent.length === 0 ? "" : "\n";
  return `${envContent}${suffix}${line}\n`;
}

type CheckResult = { kind: "live"; live: any } | { kind: "not-live" } | { kind: "token-invalid" } | { kind: "error"; message: string };

async function fetchSubscribedLivesOnce() {
  const token = process.env.MONITOR_TOKEN;
  if (!token) throw new Error("MONITOR_TOKEN が設定されていません。");

  const now = Date.now();
  const url = `https://jp-api.spooncast.net/lives/subscribed/?ts=${now}`;
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Spoon/8.10.1 (Android; 13; ja-JP)",
      "x-spoon-api-version": "2",
    },
  });
}

async function burstCheckLive(djId: string): Promise<CheckResult> {
  const deadline = Date.now() + CHECK_WINDOW_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetchSubscribedLivesOnce();

      if (response.status === 460) {
        return { kind: "token-invalid" };
      }

      if (!response.ok) {
        await sleep(CHECK_INTERVAL_MS);
        continue;
      }

      const data: any = await response.json();
      const liveList = data.results || [];
      const myLive = liveList.find((l: any) => l?.author?.id?.toString?.() === djId);

      if (myLive) return { kind: "live", live: myLive };
    } catch (e: any) {
      return { kind: "error", message: e?.message || String(e) };
    }

    await sleep(CHECK_INTERVAL_MS);
  }
  return { kind: "not-live" };
}

async function registerSlashCommands(applicationId: string) {
  if (!process.env.DISCORD_BOT_TOKEN) {
    console.warn("⚠️ DISCORD_BOT_TOKEN が未設定のため、スラッシュコマンド登録をスキップします。");
    return;
  }
  if (!DISCORD_GUILD_ID) {
    console.warn("⚠️ DISCORD_GUILD_ID が未設定のため、ギルドコマンド登録をスキップします。（.env に DISCORD_GUILD_ID を設定してください）");
    return;
  }

  const command = new SlashCommandBuilder().setName("check").setDescription("Spoonの配信状況を30秒だけ精密チェックします");

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(applicationId, DISCORD_GUILD_ID), {
      body: [command.toJSON()],
    });
    console.log(`✅ /check をギルドに登録しました (guild=${DISCORD_GUILD_ID})`);
  } catch (e: any) {
    console.error("❌ スラッシュコマンド登録に失敗:", e?.message || e);
  }
}

async function handleCheckCommand(interaction: ChatInputCommandInteraction) {
  if (!ADMIN_ID || interaction.user.id !== ADMIN_ID) {
    await interaction.reply({ content: "権限がありません。", ephemeral: true });
    return;
  }
  if (isChecking) {
    await interaction.reply({ content: "すでにチェック中です。少し待ってから再実行してください。", ephemeral: true });
    return;
  }

  const djId = process.env.DJ_ID;
  if (!djId) {
    await interaction.reply({ content: "DJ_ID が未設定です。", ephemeral: true });
    return;
  }

  isChecking = true;
  try {
    await interaction.deferReply({ ephemeral: true });
    const result = await burstCheckLive(djId);

    if (result.kind === "token-invalid") {
      await interaction.editReply("🚨 MONITOR_TOKEN が失効している可能性があります。`!update monitor <token>` で更新してください。");
      return;
    }
    if (result.kind === "error") {
      await interaction.editReply(`⚠️ チェック中にエラーが発生しました: ${result.message}`);
      return;
    }
    if (result.kind === "live") {
      const title = result.live?.title || "(タイトル不明)";
      const liveId = result.live?.id?.toString?.() || "(id不明)";
      await interaction.editReply(`✅ 配信を検知しました: "${title}" (liveId=${liveId})`);
      return;
    }

    await interaction.editReply("❌ 30秒間チェックしましたが、配信は見つかりませんでした。");
  } finally {
    isChecking = false;
  }
}

client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user?.tag}`);
  try {
    await client.application?.fetch();
  } catch {
    // ignore
  }

  const applicationId = client.application?.id;
  if (!applicationId) {
    console.warn("⚠️ Application ID を取得できなかったため、/check 登録をスキップします。");
    return;
  }
  await registerSlashCommands(applicationId);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "check") return;
  await handleCheckCommand(interaction);
});

client.on("messageCreate", async (message) => {
  if (message.author.id !== ADMIN_ID || message.author.bot) return;

  // コマンド形式: !update [target] [token]
  if (message.content.startsWith("!update ")) {
    const args = message.content.split(" ");
    const target = args[1]; // 'monitor' または 'dj'
    const newToken = args[2];

    if (!target || !newToken) {
      return message.reply("⚠️ 使用法: `!update monitor <token>` または `!update dj <token>`");
    }

    // 更新対象のキーを判定
    let envKey = "";
    if (target === "monitor") envKey = "MONITOR_TOKEN";
    else if (target === "dj") envKey = "COLLECTOR_TOKEN";
    else return message.reply("⚠️ ターゲットには `monitor` か `dj` を指定してください。");

    try {
      // 1. .env を読み込んで特定のキーだけ置換
      let envContent = fs.readFileSync(".env", "utf8");
      envContent = upsertEnvFileKey(envContent, envKey, newToken);
      fs.writeFileSync(".env", envContent);

      // 2. 実行中プロセスにも反映（再起動なしで /check に反映させる）
      (process.env as any)[envKey] = newToken;

      await message.reply(`✅ ${envKey} を更新しました。`);
    } catch (error: any) {
      await message.reply(`❌ ファイル更新エラー: ${error?.message || String(error)}`);
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
