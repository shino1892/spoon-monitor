import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { exec } from 'child_process';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const ENV_PATH = path.join(__dirname, '.env');
const PORT = 3000;

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
  res.json({ message: '再起動を開始しました。' });

  const restartCommand = 'pm2 restart all';

  setTimeout(() => {
    console.log("🔄 PM2 再起動中...");
    exec(restartCommand, { cwd: '/root/workspaces/spoon-monitor/spoon-monitor' }, (err, stdout, stderr) => {
      if (err) {
        console.error(`❌ 再起動失敗: ${err.message}`);
        return;
      }
      console.log("✅ 全プロセス再起動成功");
    });
  }, 1000);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Admin API Server: http://spoon.shino04.com`);
});