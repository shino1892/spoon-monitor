import { SpoonV2, Country } from "@sopia-bot/core";
import fs from "fs";
import path from "path";
import "dotenv/config";

const [, , liveId, liveStartTime, liveTitle, folderName] = process.argv;
if (!liveId) process.exit(1);

const CONFIG = { TOKEN: process.env.COLLECTOR_TOKEN! };

const POLL_INTERVAL_MS = 5000;

interface UserActivity {
  userId: number;
  nickname: string;
  accountAge: string;
  fanRank: number;
  firstSeen: string;
  lastSeen: string;
  staySeconds: number;
  entryCount: number;
  counts: { chat: number; heart: number; spoon: number };
}

async function startCollector() {
  const client = new SpoonV2(Country.JAPAN);
  await client.init();
  await client.setToken(CONFIG.TOKEN);

  const live = client.live;
  const userStats = new Map<number, UserActivity>();
  let currentListeners = new Set<number>(); // 💡 現在の「枠内生存」リスト

  // 💡 共通の入室処理（二重カウント防止付）
  const handleEntry = (user: any, nowISO: string) => {
    const userId = user.id || user.userId;
    if (!userStats.has(userId)) {
      console.log(`[Join] ${user.nickname} (初回入室)`);
      userStats.set(userId, {
        userId,
        nickname: user.nickname,
        accountAge: user.date_joined || user.dateJoined || "",
        fanRank: user.fan_rank || 0,
        firstSeen: nowISO,
        lastSeen: nowISO,
        staySeconds: 0,
        entryCount: 1,
        counts: { chat: 0, heart: 0, spoon: 0 },
      });
    } else if (!currentListeners.has(userId)) {
      // 💡 すでにデータがあるが、前回の監視でいなかった場合は「再入室」
      const stats = userStats.get(userId)!;
      stats.entryCount++;
      stats.lastSeen = nowISO;
      console.log(`[Re-join] ${user.nickname} (累計: ${stats.entryCount}回)`);
    }
    // 💡 重要：入室を検知したら即座に生存リストに加える（ポーリングとの二重計上防止）
    currentListeners.add(userId);
  };

  const pollListeners = async () => {
    try {
      const url = `https://jp-api.spooncast.net/lives/${liveId}/listeners/?total_count=true`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${CONFIG.TOKEN}` } });

      // レートリミット等で失敗した場合はスキップ
      if (!res.ok) {
        if (res.status === 429) console.warn("⚠️ レートリミットに抵触しています。間隔を広げてください。");
        return;
      }

      const data: any = await res.json();
      const latestListeners = data.results || [];
      const latestIds = new Set<number>(latestListeners.map((u: any) => u.id));
      const nowISO = new Date().toISOString();

      // 生存確認と入室処理
      latestListeners.forEach((user: any) => {
        handleEntry(user, nowISO);

        // 滞在時間の積み上げ (10秒)
        const stats = userStats.get(user.id)!;
        stats.staySeconds += POLL_INTERVAL_MS / 1000;
        stats.lastSeen = nowISO;
        if (!stats.accountAge && user.date_joined) stats.accountAge = user.date_joined;
      });

      // 退室のログ出力（currentListenersにあってlatestIdsにない人）
      currentListeners.forEach((id) => {
        if (!latestIds.has(id)) {
          const s = userStats.get(id);
          console.log(`[Leave] ${s?.nickname || id} が退室しました`);
        }
      });

      // 💡 生存リストを最新に更新
      currentListeners = latestIds;
    } catch (e) {
      console.error("Polling Error:", e);
    }
  };

  const pollInterval = setInterval(pollListeners, 10000);
  pollListeners();

  const saveAndExit = () => {
    clearInterval(pollInterval);
    const liveEndTime = new Date().toISOString();
    const duration = Math.floor((Date.now() - new Date(liveStartTime).getTime()) / 1000);

    try {
      const dataDir = path.join(process.cwd(), "data", folderName);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

      const finalReport = {
        live_info: {
          live_id: liveId,
          title: liveTitle,
          start_time: liveStartTime,
          end_time: liveEndTime,
          duration_seconds: duration,
        },
        users: Object.fromEntries(userStats),
      };

      fs.writeFileSync(path.join(dataDir, "summary.json"), JSON.stringify(finalReport, null, 2));
      console.log(`💾 保存完了: ${path.join(dataDir, "summary.json")}`);
    } catch (e) {
      console.error("Save Error:", e);
    }
    process.exit(0);
  };

  process.stdin.on("data", (d) => {
    if (d.toString().trim() === "exit") saveAndExit();
  });
  process.on("SIGTERM", () => saveAndExit());

  live.on("event:all", (eventName, payload) => {
    const nowISO = new Date().toISOString();
    const gen = payload.generator || payload.author || payload.user || payload;
    const userId = gen?.id || gen?.userId;
    if (!userId) return;

    // 💡 イベントが発生した＝その人は「入室中」である
    handleEntry(gen, nowISO);

    const stats = userStats.get(userId)!;
    stats.lastSeen = nowISO;

    const eName = eventName.toLowerCase();
    if (eName.includes("chat")) stats.counts.chat++;
    else if (eName.includes("like")) stats.counts.heart += payload.count || 1;
    else if (eName.includes("present")) stats.counts.spoon += payload.amount || 0;

    if (eventName === "LiveMetaUpdate" && (payload.streamStatus === "FINISHED" || payload.streamStatus === "STOP")) {
      saveAndExit();
    }
  });

  try {
    await live.join(liveId);
    console.log(`📡 収集開始 (Title: ${liveTitle})`);
  } catch (err) {
    console.error("❌ 入室失敗:", err);
    process.exit(1);
  }
}

startCollector();
