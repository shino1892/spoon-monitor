import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { exec } from 'child_process';
import { Client } from "pg";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const ENV_PATH = path.join(__dirname, '.env');
const PORT = 3000;

const db = new Client({
  host: "192.168.0.56", // DBコンテナのIP
  user: "spoon_user",
  password: "Spoon_User",
  database: "spoon_monitor",
});

async function syncDbToEnv() {
    try {
        const res = await db.query("SELECT account_type, access_token, refresh_token FROM account_tokens");
        const tokens = res.rows.reduce((acc, row) => {
            acc[row.account_type] = row;
            return acc;
        }, {} as any);

        let envContent = fs.readFileSync('.env', 'utf8');

        // DJトークンの置換
        if (tokens['DJ']) {
            envContent = envContent.replace(/DJ_ACCESS_TOKEN=.*/, `DJ_ACCESS_TOKEN=${tokens['DJ'].access_token}`);
            envContent = envContent.replace(/DJ_REFRESH_TOKEN=.*/, `DJ_REFRESH_TOKEN=${tokens['DJ'].refresh_token}`);
        }
        // MONITORトークンの置換
        if (tokens['MONITOR']) {
            envContent = envContent.replace(/MONITOR_ACCESS_TOKEN=.*/, `MONITOR_ACCESS_TOKEN=${tokens['MONITOR'].access_token}`);
            envContent = envContent.replace(/MONITOR_REFRESH_TOKEN=.*/, `MONITOR_REFRESH_TOKEN=${tokens['MONITOR'].refresh_token}`);
        }

        fs.writeFileSync('.env', envContent);
        console.log("📝 DBの最新トークンを .env に同期しました。");
        return true;
    } catch (err) {
        console.error("❌ .env 同期エラー:", err);
        return false;
    }
}

// --- 1. 現在の設定（.env）を取得 ---
app.get('/api/config', (req, res) => {
  try {
    const envContent = fs.readFileSync(ENV_PATH, 'utf-8');
    res.json({ content: envContent });
  } catch (err) {
    res.status(500).json({ error: '設定ファイルの読み込みに失敗しました。' });
  }
});

// --- 2. 設定を保存 ---
app.post('/api/config', (req, res) => {
  const { content } = req.body;
  try {
    fs.writeFileSync(ENV_PATH, content, 'utf-8');
    res.json({ message: '保存しました。再起動して反映させてください。' });
  } catch (err) {
    res.status(500).json({ error: '保存に失敗しました。' });
  }
});

// --- 3. システム再起動 (コアの再配置を含む) ---
app.post('/api/restart', (req, res) => {
  res.json({ message: 'コアの再配置と再起動を開始しました。' });

  // 💡 コマンドを && で繋いで順次実行させます
  const syncCommand = [
    'rm -rf node_modules/@sopia-bot/core',
    'mkdir -p node_modules/@sopia-bot/core',
    'cp -r /root/workspaces/spoon/packages/core/* node_modules/@sopia-bot/core/',
    'pm2 restart all'
  ].join(' && ');

  setTimeout(() => {
    console.log("🔄 コアの再配置中...");
    exec(syncCommand, { cwd: '/root/workspaces/spoon-monitor/spoon-monitor' }, (err, stdout, stderr) => {
      if (err) {
        console.error(`❌ 同期・再起動失敗: ${err.message}`);
        return;
      }
      console.log("✅ コア再配置完了 ＆ 全プロセス再起動成功");
    });
  }, 1000);
});

// 💡 監視プロセス等からの同期リクエストを受け付ける
app.post('/api/sync-env', async (req, res) => {
    const success = await syncDbToEnv();
    if (success) {
        res.json({ message: ".env synchronized successfully" });
    } else {
        res.status(500).json({ error: "Failed to synchronize .env" });
    }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Admin API Server: http://spoon.shino04.com`);
});