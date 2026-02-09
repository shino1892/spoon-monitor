import { Client, GatewayIntentBits } from "discord.js";
import { exec } from "child_process";
import fs from "fs";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const ADMIN_ID = process.env.ADMIN_ID;

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
    else if (target === "dj") envKey = "DJ_TOKEN";
    else return message.reply("⚠️ ターゲットには `monitor` か `dj` を指定してください。");

    try {
      // 1. .env を読み込んで特定のキーだけ置換
      let envContent = fs.readFileSync(".env", "utf8");
      const regex = new RegExp(`${envKey}=.*`, "g");
      envContent = envContent.replace(regex, `${envKey}="${newToken}"`);
      fs.writeFileSync(".env", envContent);

      await message.reply(`✅ ${envKey} を更新しました。監視システムを再起動します...`);

      // 2. 監視プロセスを再起動（manager自体は止まらない）
      exec("pm2 restart spoon-monitor", (err) => {
        if (err) message.reply(`❌ プロセス再起動失敗: ${err.message}`);
        else message.reply("🚀 監視を正常に再開しました。");
      });
    } catch (error) {
      await message.reply(`❌ ファイル更新エラー: ${error.message}`);
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
