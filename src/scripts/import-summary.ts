import fs from "fs";
import path from "path";
import "dotenv/config"; // .env から DB設定を読み込む
import { Client } from "pg";

// === 1. JSONの型定義 ===
interface SummaryJson {
  live_info: {
    live_id: number;
    title: string;
    start_time: string;
    end_time: string;
    duration_seconds: number;
  };
  users: Record<string, any>;
}

async function main() {
  // コマンドライン引数から対象のファイルパスを取得
  const targetPath = process.argv[2];
  if (!targetPath) {
    console.error("❌ エラー: 読み込む summary.json のパスを指定してください。");
    console.error("   例: npx ts-node src/scripts/import-summary.ts ./data/20231001-120000/summary.json");
    process.exit(1);
  }

  const absolutePath = path.resolve(process.cwd(), targetPath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`❌ エラー: 指定されたファイルが見つかりません: ${absolutePath}`);
    process.exit(1);
  }

  // === 2. JSONファイルの読み込みと集計 ===
  console.log(`📂 JSONファイルを読み込み中: ${absolutePath}`);
  const rawData = fs.readFileSync(absolutePath, "utf-8");
  const data: SummaryJson = JSON.parse(rawData);

  const durationMinutes = Math.floor(data.live_info.duration_seconds / 60);
  
  // JSON内の各ユーザーのハート数を合計して、配信全体のいいね数を算出
  let totalLikes = 0;
  const userList = Object.values(data.users);
  for (const user of userList) {
    if (user.counts && typeof user.counts.heart === "number") {
      totalLikes += user.counts.heart;
    }
  }

  console.log(`📊 配信情報: ${data.live_info.title} (ID: ${data.live_info.live_id})`);
  console.log(`👥 リスナー数: ${userList.length}名 / ❤️ 総いいね: ${totalLikes}`);

  // === 3. データベースへの接続 ===
  const db = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT) || 5432,
  });

  try {
    await db.connect();
    console.log("🔌 データベースに接続しました。");

    await db.query("BEGIN");

    // === 4. レポート情報のUPSERT ===
    const reportQuery = `
      INSERT INTO live_reports (live_id, title, dj_name, duration, likes, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (live_id) 
      DO UPDATE SET 
        duration = EXCLUDED.duration,
        likes = EXCLUDED.likes
      RETURNING id;
    `;
    const reportValues = [
      data.live_info.live_id,
      data.live_info.title,
      "shino", // djName は既存の仕様に合わせて固定
      durationMinutes,
      totalLikes
    ];
    const reportRes = await db.query(reportQuery, reportValues);
    const reportId = reportRes.rows[0].id;

    // === 5. リスナー情報のUPSERT（分割INSERT） ===
    const batchSize = 200;
    for (let offset = 0; offset < userList.length; offset += batchSize) {
      const chunk = userList.slice(offset, offset + batchSize);
      const values: Array<number | string> = [];
      
      const placeholders = chunk.map((user, index) => {
        const base = index * 10;
        values.push(
          reportId,
          user.userId,
          user.nickname || "リスナー",
          Math.floor(user.staySeconds || 0),
          user.entryCount || 1,
          user.counts?.chat || 0,
          user.counts?.heart || 0,
          user.counts?.spoon || 0,
          user.firstSeen || data.live_info.start_time,
          user.lastSeen || data.live_info.end_time
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
      }).join(",\n");

      const listenerQuery = `
        INSERT INTO listener_activities (
          report_id, user_id, nickname, stay_seconds, entry_count,
          chat_count, heart_count, spoon_count, first_seen, last_seen
        )
        VALUES ${placeholders}
        ON CONFLICT (report_id, user_id) 
        DO UPDATE SET
          nickname = EXCLUDED.nickname,
          stay_seconds = listener_activities.stay_seconds + EXCLUDED.stay_seconds,
          entry_count = listener_activities.entry_count + EXCLUDED.entry_count,
          chat_count = listener_activities.chat_count + EXCLUDED.chat_count,
          heart_count = listener_activities.heart_count + EXCLUDED.heart_count,
          spoon_count = listener_activities.spoon_count + EXCLUDED.spoon_count,
          last_seen = EXCLUDED.last_seen;
      `;
      await db.query(listenerQuery, values);
    }

    await db.query("COMMIT");
    console.log("✅ データベースへのインポートが正常に完了しました！");

  } catch (err: any) {
    await db.query("ROLLBACK");
    console.error("❌ データベースの保存中にエラーが発生しました（ロールバック済）:", err.message || err);
  } finally {
    await db.end();
    console.log("🔌 データベースとの接続を切断しました。");
  }
}

main();